// Reading the workflows the Workflows mod keeps, from the same two places: the Herdr home's workflows folder
// (~/.config/herdr-app/workflows, global) and the ticket's repo's .herdr/workflows. Read only; editing is that mod's.
import { exec, appHome, readTextFile } from "herdr";
import { parseWorkflow, firstLine, repoWorkflowsDir, globalWorkflowsDir } from "./match.js";

const sh = (script, ...args) => exec("sh", ["-c", script, "github-tasks", ...args]);
const repoOfFolder = (folder) => sh('git -C "$1" rev-parse --show-toplevel 2>/dev/null', folder)
  .then((r) => (r.code === 0 ? firstLine(r.stdout) : null), () => null);

async function readDir(dir, scope) {
  const files = (await sh('ls -1 "$1" 2>/dev/null', dir)).stdout.split("\n").filter((f) => f.endsWith(".yaml") || f.endsWith(".json")).sort();
  const items = [], errors = [];
  for (const id of new Set(files.map((f) => f.slice(0, f.lastIndexOf("."))))) {
    const file = files.includes(`${id}.yaml`) ? `${id}.yaml` : `${id}.json`; // a YAML file wins over an old JSON one
    try {
      const source = await readTextFile(`${dir}/${file}`);
      if (source != null) items.push(parseWorkflow(source, { id, scope }));
    } catch (e) {
      errors.push(`${file}: ${e?.message ?? e}`);
    }
  }
  return { items, errors };
}

// Every workflow this ticket's place can see, by name: { items: [parseWorkflow's workflows], errors }.
// A repo's own workflows are there only for a repo on this computer, as in the Workflows panel.
export async function loadWorkflows(where) {
  const repo = where?.cwd && !where.on ? await repoOfFolder(where.cwd) : null;
  const parts = await Promise.all([
    readDir(globalWorkflowsDir(appHome()), "global"),
    repo ? readDir(repoWorkflowsDir(repo), "repo") : { items: [], errors: [] },
  ]);
  return {
    items: parts.flatMap((p) => p.items).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.scope.localeCompare(b.scope)),
    errors: parts.flatMap((p) => p.errors),
  };
}
