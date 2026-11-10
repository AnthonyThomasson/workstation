// Herdr's side of the store: real files, and where they are. Everything else is store.js.
import { exec, home, appHome, readTextFile, writeTextFile } from "herdr";
import { makeStore } from "./store.js";
import { WORKFLOWS_CHANGED, REFACTORS_CHANGED } from "./model.js";
import { parseCodexModels, parseKimiModels } from "./models.js";
import { firstLine, kindDirs, globalKindDir, tildePath } from "./places.js";
import { WORKFLOW, REFACTOR } from "./kinds.js";

export { WORKFLOWS_CHANGED, REFACTORS_CHANGED };

const sh = (script, ...args) => exec("sh", ["-c", script, "github-tasks", ...args]);

const io = {
  read: (path) => readTextFile(path),
  write: (path, text, expected) => writeTextFile(path, text, expected),
  list: async (dir) => (await sh('ls -1 "$1" 2>/dev/null', dir)).stdout.split("\n").filter(Boolean),
  remove: async (path) => {
    const r = await sh('rm -f "$1"', path);
    if (r.code !== 0) throw new Error(r.stderr || `rm exited with code ${r.code}.`);
  },
  mkdir: async (dir) => {
    const r = await sh('mkdir -p "$1"', dir);
    if (r.code !== 0) throw new Error(r.stderr || `mkdir exited with code ${r.code}.`);
  },
};

// Codex's own list of models, from the cache its CLI keeps. Empty when it has none, or it cannot be read.
export const codexModels = () => readTextFile(`${home()}/.codex/models_cache.json`)
  .then((text) => parseCodexModels(text ?? ""), () => []);

// Kimi Code's models, from its config. Only its [models] sections are read out of that file.
export const kimiModels = () => readTextFile(`${home()}/.kimi-code/config.toml`)
  .then((text) => parseKimiModels(text ?? ""), () => []);

// Where global workflows (or refactor types, kind = REFACTOR) are kept: that folder of the Herdr home. It is made
// when one is saved.
export const globalDir = (kind = WORKFLOW) => globalKindDir(appHome(), kind.folder);
// That folder as people write it, for messages: ~/.config/herdr-app/workflows.
export const globalDirText = (kind = WORKFLOW) => tildePath(globalDir(kind), home());

// A kind's shipped starters' texts, read from this installed mod rather than embedded a second time in its code.
// All of them are read (and any missing one throws) before the caller changes anything.
export async function starterTexts(kind = WORKFLOW) {
  return Promise.all(kind.starters.map(async (name) => {
    const path = `${appHome()}/mods/github-tasks/starters/${name}.yaml`;
    const text = await readTextFile(path);
    if (text == null) throw new Error(`Could not read the shipped ${name} starter at ${path}.`);
    return text;
  }));
}
export const starterWorkflows = () => starterTexts(WORKFLOW);
export const starterRefactors = () => starterTexts(REFACTOR);

// The git repo a folder is in: its top folder, or null (not a repo, or git cannot run there).
const repoOfFolder = (folder) => sh('git -C "$1" rev-parse --show-toplevel 2>/dev/null', folder)
  .then((r) => (r.code === 0 ? firstLine(r.stdout) : null), () => null);

// The repo a space is in, for the workflows kept in its .herdr folder. Only a space on this computer has
// one: a remote space's files cannot be written from here. null when there is none.
export const repoRootOf = (where) => (where?.cwd && !where.on ? repoOfFolder(where.cwd) : Promise.resolve(null));

// The store for what is known now: the repo of the selected space (or null). Global is always there; a
// repo's workflows are available only while their space is the one open.
// kind: WORKFLOW (the default) or REFACTOR, from kinds.js.
export function store({ repo = null, kind = WORKFLOW } = {}) {
  return makeStore({ io, dirs: kindDirs(appHome(), repo, kind.folder), kind });
}

// Every workflow the place can see, whole, for Start and the ticket editor's Start dialog: { items, errors }.
// A repo's own workflows are there only for a repo on this computer.
export const loadWorkflows = async (where) => store({ repo: await repoRootOf(where) }).loadAll();

// The same for refactor types.
export const loadRefactors = async (where) => store({ repo: await repoRootOf(where), kind: REFACTOR }).loadAll();
