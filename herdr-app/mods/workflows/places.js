// Where things are, worked out from text. Pure; env.js does the reading and the git calls.

// The folder Skillshare keeps its skills in, from its config.yaml (sources: skills: <path>). That folder
// is a symlink into a git repo here, so the repo is the one Skillshare's push and pull carry, and the
// one a synced workflow is kept in. Without a config (or a skills entry) it is Skillshare's default.
export function skillshareSource(configText, home) {
  const fallback = `${home}/.config/skillshare/skills`;
  const lines = String(configText ?? "").split(/\r?\n/);
  let inSources = false;
  for (const line of lines) {
    if (/^sources:\s*(#.*)?$/.test(line)) { inSources = true; continue; }
    if (inSources && /^\S/.test(line)) break; // the next top-level key
    const m = inSources && /^\s+skills:\s*(.+?)\s*(#.*)?$/.exec(line);
    if (m) {
      const path = m[1].replace(/^(["'])(.*)\1$/, "$2");
      return path === "~" ? home : path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
    }
  }
  return fallback;
}

// The first line of a command's output, trimmed, as a path; null if it printed nothing.
export const firstLine = (text) => String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? null;

// A repo's folder of workflows, and the workstation repo's.
export const repoWorkflowsDir = (repoRoot) => `${repoRoot}/.herdr/workflows`;
export const syncedWorkflowsDir = (workstationRoot) => `${workstationRoot}/herdr-app/workflows`;
