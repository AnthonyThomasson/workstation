// Where things are, worked out from text. Pure; env.js does the reading and the git calls. This is the one home of every
// .herdr/ path the mod builds (a repo's kind folders, a run's folder and pane.json, a ticket's worktree, an Investigation's
// session folder): import them from here (workflow/index.js); lib/homes.test.js keeps it so.

// The first line of a command's output, trimmed, as a path; null if it printed nothing.
export const firstLine = (text) => String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? null;

// A folder as these paths are built from it, and as two names of one folder are compared: forward slashes, no trailing slash.
// A Windows path (C:\Users\me, \\server\share, as Node's path.join makes on Windows) has its backslashes turned to slashes (C:/Users/me, as git prints it and Git Bash reads it);
// any other path keeps its backslashes, which on a Unix machine are part of a name.
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const slashes = (path) => (WINDOWS_PATH.test(path) ? path.replace(/\\/g, "/") : path);
export const posixFolder = (path) => slashes(String(path ?? "")).replace(/\/+$/, "");

// A repo's folder of workflows, and the global one: the workflows folder of the Herdr home
// (~/.config/herdr-app, or $HERDR_APP_HOME), whatever else is or is not on the machine.
// The same for any kind's folder name ("workflows" or "refactors", see kinds.js).
export const repoKindDir = (repoRoot, folder) => `${posixFolder(repoRoot)}/.herdr/${folder}`;
export const globalKindDir = (appHome, folder) => `${posixFolder(appHome)}/${folder}`;
export const repoWorkflowsDir = (repoRoot) => repoKindDir(repoRoot, "workflows");
export const globalWorkflowsDir = (appHome) => globalKindDir(appHome, "workflows");
export const repoRefactorsDir = (repoRoot) => repoKindDir(repoRoot, "refactors");
export const globalRefactorsDir = (appHome) => globalKindDir(appHome, "refactors");

// Project buttons on run and investigation pages come from this file in the ticket worktree.
export const projectConfigPath = (folder) => `${posixFolder(folder)}/.herdr/config.yaml`;

// A path as people write it: under the home folder it starts with ~.
export const tildePath = (path, home) => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

// The store's folders for what is known now: global always, and the repo's only when a space is in one.
export const kindDirs = (appHome, repoRoot, folder) => ({
  global: globalKindDir(appHome, folder),
  ...(repoRoot ? { repo: repoKindDir(repoRoot, folder) } : {}),
});
export const workflowDirs = (appHome, repoRoot = null) => kindDirs(appHome, repoRoot, "workflows");
export const refactorDirs = (appHome, repoRoot = null) => kindDirs(appHome, repoRoot, "refactors");

// A run's folder, <home>/.herdr/workflow-runs/<id>, and the pane.json Start writes and View reads there.
export const runDir = (home, id) => `${posixFolder(home)}/.herdr/workflow-runs/${id}`;
export const runPanePath = (home, id) => `${runDir(home, id)}/pane.json`;

// The command line's mailbox (cli/): herdr-tasks drops a request in requests/ and the Tasks sidebar's bridge (cli-ui/bridge.js) writes
// the reply into replies/. `home` is passed in to keep this pure.
export const cliDir = (home) => `${posixFolder(home)}/.herdr/tasks-cli`;
export const cliRequestsDir = (home) => `${cliDir(home)}/requests`;
export const cliRepliesDir = (home) => `${cliDir(home)}/replies`;

// Only a child of a .herdr/workflow-runs folder can be removed. In particular, never rm the parent or a path
// reached through a run id containing traversal; Merge builds this path from home() and the run id.
// The child's id, or null when the path is not safe to remove.
export const runIdFromDir = (path) => {
  // an absolute path: /… here or on a Unix machine, C:/… or C:\… on a Windows one (a run's folder there, removed by Merge)
  const id = typeof path === "string" ? slashes(path).match(/^(?:[A-Za-z]:)?\/(?:.*\/)?\.herdr\/workflow-runs\/([^/]+)$/)?.[1] : null;
  return id && id !== "." && !id.includes("..") ? id : null;
};

// Where Herdr's own worktree mod puts a branch: <home>/.herdr/worktrees/<repo>/<branch slug>, so Herdr nests the
// ticket's space under the repo's. `repoRoot` is the main checkout (never a worktree), which names <repo>; the slug is
// the mod's own (runs of anything but letters, digits, . _ - become one -, none at the ends), so "workflow/12-fix" is
// "workflow-12-fix". The jobs' worktrees are this path plus `--<job>`. `home` is passed in to keep this pure.
export const worktreePath = (repoRoot, branch, home) => {
  const repo = posixFolder(repoRoot).split("/").pop();
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${posixFolder(home)}/.herdr/worktrees/${repo}/${slug}`;
};

// An Investigation's session folder, ~/.herdr/investigations/<id>/, which holds its spawn script and prompts: null unless the id is an
// investigation's own (inv-<base 36>), so nothing outside ~/.herdr/investigations can ever be named. The one helper for the folder: the
// start path writes it (and takes it back if the start fails) and Done removes it. `home` is passed in to keep this pure.
export function sessionFolder(home, id) {
  if (!/^inv-[a-z0-9]+$/.test(String(id ?? "")) || !posixFolder(home)) return null;
  return `${posixFolder(home)}/.herdr/investigations/${id}`;
}

// The test device's runs (devices/test-run.js): each `herdr-tasks device run` gets <home>/.herdr/test-runs/<id>/ (a git worktree),
// beside <id>.bundle, <id>.log and <id>.code, and one .lock folder per device. `home` is the device's own home (passed in to keep
// this pure). The id's own helpers return null unless it is a plain run id (lowercase letters and digits), so traversal such as
// "..", "a/b" or "" can never name a path outside test-runs, which the run's cleanup and the 24h sweep remove from.
export const testRunsDir = (home) => `${posixFolder(home)}/.herdr/test-runs`;
export const testRunLockDir = (home) => `${testRunsDir(home)}/.lock`;
export const testRunId = (id) => (/^[a-z0-9]{1,40}$/.test(String(id ?? "")) ? String(id) : null);
const testRunChild = (home, id, suffix) => (testRunId(id) && posixFolder(home) ? `${testRunsDir(home)}/${id}${suffix}` : null);
export const testRunFolder = (home, id) => testRunChild(home, id, "");
export const testRunBundle = (home, id) => testRunChild(home, id, ".bundle");
export const testRunLog = (home, id) => testRunChild(home, id, ".log");
export const testRunCode = (home, id) => testRunChild(home, id, ".code");
