// Herdr's side of local tasks: real files, and the git call. Everything else is local-tasks.js, tasks-config.js and
// github-remote.js, which are pure. Never runs git on tasks.json or a task file: git is only asked for origin's URL.
import { exec, home, readTextFile, writeTextFile } from "herdr";
import { makeLocalTasks } from "./local-tasks.js";
import { makeTasksConfig } from "./tasks-config.js";
import { hasGithubRemote } from "./github-remote.js";

const sh = (script, ...args) => exec("sh", ["-c", script, "github-tasks", ...args]);
const must = async (r, what) => { if (r.code !== 0) throw new Error(r.stderr || `${what} exited with code ${r.code}.`); };

export const io = {
  list: async (dir) => (await sh('ls -1 "$1" 2>/dev/null', dir)).stdout.split("\n").filter(Boolean), // a missing folder lists nothing
  read: (path) => readTextFile(path).catch(() => null), // a missing file is null, never a rejection
  // Last write wins: the file is read first only because writeTextFile wants what it replaces.
  write: async (path, text) => writeTextFile(path, text, (await readTextFile(path).catch(() => null)) ?? null),
  remove: async (path) => must(await sh('rm -f "$1"', path), "rm"),
  mkdir: async (dir) => must(await sh('mkdir -p "$1"', dir), "mkdir"),
};

const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);

// The local tasks of the repo whose main checkout is mainRoot (worktree.js mainCheckout finds it from any worktree).
export const localTasks = (mainRoot) => makeLocalTasks({ io, root: mainRoot, home: home() });

// read(mainRoot) -> "local" | "github"; write(mainRoot, source) writes <mainRoot>/.herdr/tasks/tasks.json.
export const tasksConfig = makeTasksConfig(io);

// Is the repo's origin remote on github.com?
export const repoHasGithubRemote = (repoRoot) => hasGithubRemote(git, repoRoot);
