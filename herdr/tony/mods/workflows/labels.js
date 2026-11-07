// The GitHub labels of the repo the selected space is in, to complete a workflow's trigger from. Pure:
// gh comes in as gh(args, { cwd, on }) -> { code, stdout, stderr } (main's runs the real one), so
// node --test runs it. GitHub Projects have no labels of their own; a project's tickets use the repo's.

export class LabelError extends Error {
  constructor(text) {
    const message = String(text ?? "").trim().split("\n")[0] || "GitHub didn't answer.";
    super(message);
    const s = String(text ?? "");
    this.kind = /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(s) ? "no-auth"
      : /not a git repository|no git remotes|none of the git remotes|could not determine (the )?(base )?repo/i.test(s) ? "not-a-repo"
        : "other";
  }
}

const json = (text) => { try { return JSON.parse(text); } catch { return null; } };

// "owner/name" of the repo in where.cwd.
export async function findRepo(gh, where) {
  const r = await gh(["repo", "view", "--json", "nameWithOwner"], where);
  const repo = r.code === 0 ? json(r.stdout)?.nameWithOwner : null;
  if (!repo) throw new LabelError(r.stderr || r.stdout);
  return repo;
}

// The repo's labels: [{ name, color }], by name.
export async function loadLabels(gh, repo, where) {
  const r = await gh(["label", "list", "-R", repo, "--json", "name,color", "-L", "200"], where);
  const labels = r.code === 0 ? json(r.stdout) : null;
  if (!Array.isArray(labels)) throw new LabelError(r.stderr || r.stdout);
  return labels
    .filter((l) => l && typeof l.name === "string")
    .map((l) => ({ name: l.name, color: typeof l.color === "string" ? l.color : "" }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

// What the label dialog and the field's suggestions show: the labels that contain the query, those that
// start with it first, then the rest in order. No query matches all. limit caps the answer (none: all).
export function matchLabels(labels, query, limit = Infinity) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return labels.slice(0, limit);
  const starts = [], inside = [];
  for (const l of labels) {
    const name = l.name.toLowerCase();
    if (name.startsWith(q)) starts.push(l);
    else if (name.includes(q)) inside.push(l);
  }
  return [...starts, ...inside].slice(0, limit);
}

// Whether text is exactly an existing label (GitHub's label names match without regard to case).
export const hasLabel = (labels, text) => {
  const q = String(text ?? "").trim().toLowerCase();
  return Boolean(q) && labels.some((l) => l.name.toLowerCase() === q);
};
