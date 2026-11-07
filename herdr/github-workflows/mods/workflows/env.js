// Herdr's side of the store: real files, and where they are. Everything else is store.js.
import { exec, home, readTextFile, writeTextFile, shared } from "herdr";
import { makeStore } from "./store.js";
import { parseCodexModels, parseKimiModels } from "./models.js";
import { skillshareSource, firstLine, repoWorkflowsDir, syncedWorkflowsDir } from "./places.js";

// Set to the time of each save or delete, so the panel's list refreshes.
export const CHANGED = "workflows.changed";
// The workstation repo, when the person sets it by hand in the panel (it is otherwise found, below).
export const REPO_KEY = "workflows.repoDir";

const sh = (script, ...args) => exec("sh", ["-c", script, "workflows", ...args]);

const io = {
  read: (path) => readTextFile(path),
  write: (path, text, expected) => writeTextFile(path, text, expected),
  list: async (dir) => (await sh('ls -1 "$1" 2>/dev/null', dir)).stdout.split("\n").filter(Boolean),
  remove: async (path) => { await sh('rm -f "$1"', path); },
  mkdir: async (dir) => { await sh('mkdir -p "$1"', dir); },
};
const isDir = async (path) => (await sh('test -d "$1"', path)).code === 0;

// Codex's own list of models, from the cache its CLI keeps. Empty when it has none, or it cannot be read.
export const codexModels = () => readTextFile(`${home()}/.codex/models_cache.json`)
  .then((text) => parseCodexModels(text ?? ""), () => []);

// Kimi Code's models, from its config. Only its [models] sections are read out of that file.
export const kimiModels = () => readTextFile(`${home()}/.kimi-code/config.toml`)
  .then((text) => parseKimiModels(text ?? ""), () => []);

// gh, as labels.js wants it: a failure to start is an answer with a code, not a throw.
export const gh = (args, where) => exec("gh", args, where)
  .catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) }));

export const expandHome = (p) => (p === "~" ? home() : p.startsWith("~/") ? `${home()}/${p.slice(2)}` : p);
export const repoDir = () => {
  const v = shared(REPO_KEY);
  return typeof v === "string" && v.trim() ? expandHome(v.trim()).replace(/\/+$/, "") : null;
};
export const checkRepo = (dir) => isDir(`${dir}/herdr-app`);

// The git repo a folder is in: its top folder, or null (not a repo, or git cannot run there).
const repoOfFolder = (folder) => sh('git -C "$1" rev-parse --show-toplevel 2>/dev/null', folder)
  .then((r) => (r.code === 0 ? firstLine(r.stdout) : null), () => null);

// The repo a space is in, for the workflows kept in its .herdr folder. Only a space on this computer has
// one: a remote space's files cannot be written from here. null when there is none.
export const repoRootOf = (where) => (where?.cwd && !where.on ? repoOfFolder(where.cwd) : Promise.resolve(null));

// The workstation repo, where global workflows are kept: the one set by hand in the panel, else the git
// repo Skillshare keeps its skills in, which its push and pull carry. A herdr-app folder in it is what
// makes it ours. null when neither is one, and then there is nothing to sync to.
export async function workstationRepo() {
  const set = repoDir();
  if (set && (await checkRepo(set))) return set;
  const config = await readTextFile(`${home()}/.config/skillshare/config.yaml`).catch(() => null);
  const root = await repoOfFolder(skillshareSource(config, home()));
  return root && (await checkRepo(root)) ? root : null;
}

// The store for what is known now: the workstation repo (or null) and the repo of the selected space (or
// null). A scope without its repo is unavailable in it, so repo workflows show only while their space is
// the one open.
export function store({ workstation = null, repo = null } = {}) {
  return makeStore({
    io,
    dirs: {
      ...(workstation ? { global: syncedWorkflowsDir(workstation) } : {}),
      ...(repo ? { repo: repoWorkflowsDir(repo) } : {}),
    },
  });
}
