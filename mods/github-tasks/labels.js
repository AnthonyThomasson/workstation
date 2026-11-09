// The GitHub labels of the repo the selected space is in, to complete a workflow's trigger from. Pure:
// gh comes in as gh(args, { cwd, on }) -> { code, stdout, stderr } (ui.js has the real one), so
// node --test runs it. GitHub Projects have no labels of their own; a project's tickets use the repo's.
// The repo itself is found by loader.js findRepo.

import { GitHubError, parseJson } from "./loader.js";

export const LABEL_LIMIT = 200; // how many labels loadLabels asks for; an answer this long may be cut short

// The repo's labels: [{ name, color }], by name.
export async function loadLabels(gh, repo, where) {
  const r = await gh(["label", "list", "-R", repo, "--json", "name,color", "-L", String(LABEL_LIMIT)], where);
  const labels = r.code === 0 ? parseJson(r.stdout) : null;
  if (!Array.isArray(labels)) throw new GitHubError(r.stderr || r.stdout);
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
