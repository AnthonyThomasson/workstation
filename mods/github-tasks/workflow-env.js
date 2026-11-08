// Herdr's side of the store: real files, and where they are. Everything else is store.js.
import { exec, home, appHome, readTextFile, writeTextFile } from "herdr";
import { makeStore } from "./store.js";
import { parseCodexModels, parseKimiModels } from "./models.js";
import { firstLine, workflowDirs, globalWorkflowsDir, tildePath } from "./places.js";

// Set to the time of each save or delete, so the panel's list refreshes.
export const WORKFLOWS_CHANGED = "github-tasks.workflows.changed";

const sh = (script, ...args) => exec("sh", ["-c", script, "github-tasks", ...args]);

const io = {
  read: (path) => readTextFile(path),
  write: (path, text, expected) => writeTextFile(path, text, expected),
  list: async (dir) => (await sh('ls -1 "$1" 2>/dev/null', dir)).stdout.split("\n").filter(Boolean),
  remove: async (path) => { await sh('rm -f "$1"', path); },
  mkdir: async (dir) => { await sh('mkdir -p "$1"', dir); },
};

// Codex's own list of models, from the cache its CLI keeps. Empty when it has none, or it cannot be read.
export const codexModels = () => readTextFile(`${home()}/.codex/models_cache.json`)
  .then((text) => parseCodexModels(text ?? ""), () => []);

// Kimi Code's models, from its config. Only its [models] sections are read out of that file.
export const kimiModels = () => readTextFile(`${home()}/.kimi-code/config.toml`)
  .then((text) => parseKimiModels(text ?? ""), () => []);

// Where global workflows are kept: the workflows folder of the Herdr home. It is made when one is saved.
export const globalDir = () => globalWorkflowsDir(appHome());
// That folder as people write it, for messages: ~/.config/herdr-app/workflows.
export const globalDirText = () => tildePath(globalDir(), home());

// The git repo a folder is in: its top folder, or null (not a repo, or git cannot run there).
const repoOfFolder = (folder) => sh('git -C "$1" rev-parse --show-toplevel 2>/dev/null', folder)
  .then((r) => (r.code === 0 ? firstLine(r.stdout) : null), () => null);

// The repo a space is in, for the workflows kept in its .herdr folder. Only a space on this computer has
// one: a remote space's files cannot be written from here. null when there is none.
export const repoRootOf = (where) => (where?.cwd && !where.on ? repoOfFolder(where.cwd) : Promise.resolve(null));

// The store for what is known now: the repo of the selected space (or null). Global is always there; a
// repo's workflows are available only while their space is the one open.
export function store({ repo = null } = {}) {
  return makeStore({ io, dirs: workflowDirs(appHome(), repo) });
}

// Every workflow the place can see, whole, for Start and the ticket editor's Start dialog: { items, errors }.
// A repo's own workflows are there only for a repo on this computer.
export const loadWorkflows = async (where) => store({ repo: await repoRootOf(where) }).loadAll();
