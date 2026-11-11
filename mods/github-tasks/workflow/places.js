// Where things are, worked out from text. Pure; env.js does the reading and the git calls. This is the one home of every
// .herdr/ path the mod builds (a repo's kind folders, a run's folder and pane.json, a ticket's worktree, an Investigation's
// session folder): import them from here (workflow/index.js); lib/homes.test.js keeps it so.

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

// A run's folder, <home>/.herdr/workflow-runs/<id>, and the pane.json Start writes and View reads there.
export const runDir = (home, id) => `${home}/.herdr/workflow-runs/${id}`;
export const runPanePath = (home, id) => `${runDir(home, id)}/pane.json`;

// Only a child of a .herdr/workflow-runs folder can be removed. In particular, never rm the parent or a path
// reached through a run id containing traversal; Merge builds this path from home() and the run id.
// The child's id, or null when the path is not safe to remove.
export const runIdFromDir = (path) => {
  const id = typeof path === "string" ? path.match(/^\/(?:.*\/)?\.herdr\/workflow-runs\/([^/]+)$/)?.[1] : null;
  return id && id !== "." && !id.includes("..") ? id : null;
};

// Where Herdr's own worktree mod puts a branch: <home>/.herdr/worktrees/<repo>/<branch slug>, so Herdr nests the
// ticket's space under the repo's. `repoRoot` is the main checkout (never a worktree), which names <repo>; the slug is
// the mod's own (runs of anything but letters, digits, . _ - become one -, none at the ends), so "workflow/12-fix" is
// "workflow-12-fix". The jobs' worktrees are this path plus `--<job>`. `home` is passed in to keep this pure.
export const worktreePath = (repoRoot, branch, home) => {
  const repo = repoRoot.replace(/\/+$/, "").split("/").pop();
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${home.replace(/\/+$/, "")}/.herdr/worktrees/${repo}/${slug}`;
};

// An Investigation's session folder, ~/.herdr/investigations/<id>/, which holds its spawn script and prompts: null unless the id is an
// investigation's own (inv-<base 36>), so nothing outside ~/.herdr/investigations can ever be named. The one helper for the folder: the
// start path writes it (and takes it back if the start fails) and Done removes it. `home` is passed in to keep this pure.
export function sessionFolder(home, id) {
  if (!/^inv-[a-z0-9]+$/.test(String(id ?? "")) || !String(home ?? "").replace(/\/+$/, "")) return null;
  return `${String(home).replace(/\/+$/, "")}/.herdr/investigations/${id}`;
}
