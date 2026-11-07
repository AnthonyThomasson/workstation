// Herdr's side of the store: real files, and where they are. Everything else is store.js.
import { exec, home, appHome, readTextFile, writeTextFile, shared } from "herdr";
import { makeStore } from "./store.js";
import { parseCodexModels, parseKimiModels } from "./models.js";

// Set to the time of each save or delete, so the panel's list refreshes.
export const CHANGED = "workflows.changed";
// The workstation clone global workflows are copied into, set in the panel.
export const REPO_KEY = "workflows.repoDir";

const sh = (script, ...args) => exec("sh", ["-c", script, "workflows", ...args]);

const io = {
  read: (path) => readTextFile(path),
  write: (path, text, expected) => writeTextFile(path, text, expected),
  list: async (dir) => (await sh('ls -1 "$1" 2>/dev/null', dir)).stdout.split("\n").filter(Boolean),
  remove: async (path) => { await sh('rm -f "$1"', path); },
  mkdir: async (dir) => { await sh('mkdir -p "$1"', dir); },
  isDir: async (path) => (await sh('test -d "$1"', path)).code === 0,
};

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
export const checkRepo = async (dir) => io.isDir(`${dir}/herdr-app`);

// Made on each use, so a change to the clone's path applies at once.
export function store() {
  const repo = repoDir();
  return makeStore({
    io,
    dirs: { global: `${appHome()}/workflows`, local: `${appHome()}/workflows.local` },
    mirrorDir: repo ? `${repo}/herdr-app/workflows` : null,
  });
}
