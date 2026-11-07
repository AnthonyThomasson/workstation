// Reading the workflows the Workflows mod keeps, from the same two places: the workstation repo's
// herdr-app/workflows (global) and the ticket's repo's .herdr/workflows. Read only; editing is that mod's.
import { exec, home, readTextFile, shared } from "herdr";
import { parseWorkflow, skillshareSource, firstLine, repoWorkflowsDir, globalWorkflowsDir } from "./match.js";

// Where the Workflows panel stores a workstation repo the person entered by hand.
const REPO_KEY = "workflows.repoDir";

const sh = (script, ...args) => exec("sh", ["-c", script, "github-tasks", ...args]);
const isDir = async (path) => (await sh('test -d "$1"', path)).code === 0;
const repoOfFolder = (folder) => sh('git -C "$1" rev-parse --show-toplevel 2>/dev/null', folder)
  .then((r) => (r.code === 0 ? firstLine(r.stdout) : null), () => null);
const expandHome = (p) => (p === "~" ? home() : p.startsWith("~/") ? `${home()}/${p.slice(2)}` : p);

// The workstation repo: the one set in the Workflows panel, else the git repo Skillshare keeps its skills
// in. A herdr-app folder in it is what makes it ours. null when there is none.
async function workstationRepo() {
  const v = shared(REPO_KEY);
  const set = typeof v === "string" && v.trim() ? expandHome(v.trim()).replace(/\/+$/, "") : null;
  if (set && (await isDir(`${set}/herdr-app`))) return set;
  const config = await readTextFile(`${home()}/.config/skillshare/config.yaml`).catch(() => null);
  const root = await repoOfFolder(skillshareSource(config, home()));
  return root && (await isDir(`${root}/herdr-app`)) ? root : null;
}

async function readDir(dir, scope) {
  const files = (await sh('ls -1 "$1" 2>/dev/null', dir)).stdout.split("\n").filter((f) => f.endsWith(".json")).sort();
  const items = [], errors = [];
  for (const file of files) {
    const id = file.slice(0, -5);
    try {
      const source = await readTextFile(`${dir}/${id}.json`);
      if (source != null) items.push(parseWorkflow(source, { id, scope }));
    } catch (e) {
      errors.push(`${file}: ${e?.message ?? e}`);
    }
  }
  return { items, errors };
}

// Every workflow this ticket's place can see, by name: { items: [{ id, name, scope, text, trigger }], errors }.
// A repo's own workflows are there only for a repo on this computer, as in the Workflows panel.
export async function loadWorkflows(where) {
  const [workstation, repo] = await Promise.all([
    workstationRepo(),
    where?.cwd && !where.on ? repoOfFolder(where.cwd) : null,
  ]);
  const parts = await Promise.all([
    workstation ? readDir(globalWorkflowsDir(workstation), "global") : { items: [], errors: [] },
    repo ? readDir(repoWorkflowsDir(repo), "repo") : { items: [], errors: [] },
  ]);
  return {
    items: parts.flatMap((p) => p.items).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.scope.localeCompare(b.scope)),
    errors: parts.flatMap((p) => p.errors),
  };
}
