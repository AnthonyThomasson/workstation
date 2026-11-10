// Where things are, worked out from text. Pure; env.js does the reading and the git calls.

// The first line of a command's output, trimmed, as a path; null if it printed nothing.
export const firstLine = (text) => String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? null;

// A repo's folder of workflows, and the global one: the workflows folder of the Herdr home
// (~/.config/herdr-app, or $HERDR_APP_HOME), whatever else is or is not on the machine.
// The same for any kind's folder name ("workflows" or "refactors", see kinds.js).
export const repoKindDir = (repoRoot, folder) => `${repoRoot}/.herdr/${folder}`;
export const globalKindDir = (appHome, folder) => `${String(appHome).replace(/\/+$/, "")}/${folder}`;
export const repoWorkflowsDir = (repoRoot) => repoKindDir(repoRoot, "workflows");
export const globalWorkflowsDir = (appHome) => globalKindDir(appHome, "workflows");
export const repoRefactorsDir = (repoRoot) => repoKindDir(repoRoot, "refactors");
export const globalRefactorsDir = (appHome) => globalKindDir(appHome, "refactors");

// A path as people write it: under the home folder it starts with ~.
export const tildePath = (path, home) => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

// The store's folders for what is known now: global always, and the repo's only when a space is in one.
export const kindDirs = (appHome, repoRoot, folder) => ({
  global: globalKindDir(appHome, folder),
  ...(repoRoot ? { repo: repoKindDir(repoRoot, folder) } : {}),
});
export const workflowDirs = (appHome, repoRoot = null) => kindDirs(appHome, repoRoot, "workflows");
export const refactorDirs = (appHome, repoRoot = null) => kindDirs(appHome, repoRoot, "refactors");
