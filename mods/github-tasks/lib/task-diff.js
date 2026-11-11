// Editing one task: { title, body, labels: [name], status: name|null }.

export function snapshot(task) {
  return {
    title: String(task?.title ?? ""),
    body: String(task?.body ?? ""),
    labels: [...new Set(task?.labels ?? [])].sort(),
    status: task?.status ?? null,
  };
}

// Which labels to put on and take off to turn one list into the other.
export function labelDiff(before, after) {
  const was = new Set(before ?? []), now = new Set(after ?? []);
  return { add: [...now].filter((l) => !was.has(l)).sort(), remove: [...was].filter((l) => !now.has(l)).sort() };
}

// What differs between two snapshots; empty when nothing does. Drafts have no labels.
export function changes(before, after, { draft = false } = {}) {
  const a = snapshot(before), b = snapshot(after), out = {};
  if (a.title !== b.title) out.title = b.title;
  if (a.body !== b.body) out.body = b.body;
  if (a.status !== b.status) out.status = b.status;
  if (!draft) {
    const labels = labelDiff(a.labels, b.labels);
    if (labels.add.length || labels.remove.length) out.labels = labels;
  }
  return out;
}

export const isDirty = (before, after, opts) => Object.keys(changes(before, after, opts)).length > 0;

// The save needs a title, and a status it can name.
export function checkTask(after, statusOptions = []) {
  if (!String(after?.title ?? "").trim()) return "A task needs a title.";
  if (after?.status && statusOptions.length && !statusOptions.some((o) => o.name === after.status)) return `The project has no "${after.status}" status.`;
  return null;
}
