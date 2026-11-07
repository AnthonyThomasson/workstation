// Where things are, worked out from text. Pure; env.js does the reading and the git calls.

// The first line of a command's output, trimmed, as a path; null if it printed nothing.
export const firstLine = (text) => String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? null;

// A repo's folder of workflows, and the global one: the workflows folder of the Herdr home
// (~/.config/herdr-app, or $HERDR_APP_HOME), whatever else is or is not on the machine.
export const repoWorkflowsDir = (repoRoot) => `${repoRoot}/.herdr/workflows`;
export const globalWorkflowsDir = (appHome) => `${String(appHome).replace(/\/+$/, "")}/workflows`;

// A path as people write it: under the home folder it starts with ~.
export const tildePath = (path, home) => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

// The store's folders for what is known now: global always, and the repo's only when a space is in one.
export const workflowDirs = (appHome, repoRoot = null) => ({
  global: globalWorkflowsDir(appHome),
  ...(repoRoot ? { repo: repoWorkflowsDir(repoRoot) } : {}),
});
