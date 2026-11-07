// The Tasks panel's thinking, with no Herdr in it: which project items are this repo's tickets, how
// they group and order, and what a gh failure means.

// The closed sections, in the order they show. Issues closed with no reason land in the last one.
const CLOSED = [
  ["COMPLETED", "Completed"],
  ["NOT_PLANNED", "Not planned"],
  ["DUPLICATE", "Duplicate"],
  ["OTHER", "Closed"],
];

// Project items as tickets: this repo's issues, and drafts, which belong to no repo. Pull requests,
// archived items and content the token can't see are left out.
export function normalizeItems(nodes, repo) {
  const wanted = String(repo ?? "").toLowerCase();
  const tickets = [];
  for (const node of nodes ?? []) {
    const content = node?.content;
    if (!content || node.isArchived) continue;
    const status = node.status?.name ?? null;
    if (content.__typename === "DraftIssue") {
      tickets.push({ key: node.id, contentId: content.id ?? null, draft: true, number: null, title: content.title, url: null, state: "OPEN", reason: null, createdAt: content.createdAt, status });
    } else if (content.__typename === "Issue" && content.repository?.nameWithOwner?.toLowerCase() === wanted) {
      tickets.push({ key: node.id, draft: false, number: content.number, title: content.title, url: content.url, state: content.state, reason: content.stateReason ?? null, createdAt: content.createdAt, status });
    }
  }
  return tickets;
}

const created = (ticket) => {
  const at = Date.parse(ticket.createdAt);
  return Number.isNaN(at) ? -Infinity : at;
};
const newestFirst = (a, b) => created(b) - created(a) || (b.number ?? 0) - (a.number ?? 0);

// { open, closed: [{ key, label, tickets }] }, newest first. A reopened issue is open again, whatever
// its reason says. Closed sections with nothing in them are left out.
export function groupTickets(tickets) {
  const open = tickets.filter((t) => t.state !== "CLOSED").sort(newestFirst);
  const known = new Set(CLOSED.map(([key]) => key));
  const closed = tickets.filter((t) => t.state === "CLOSED");
  const sections = CLOSED.map(([key, label]) => ({
    key,
    label,
    tickets: closed.filter((t) => (known.has(t.reason) ? t.reason : "OTHER") === key).sort(newestFirst),
  }));
  return { open, closed: sections.filter((s) => s.tickets.length) };
}

// The saved project if it's still linked, else the first, which is the most recently updated.
export function chooseProject(projects, savedId) {
  return projects.find((p) => p.id === savedId) ?? projects[0] ?? null;
}

// What a gh failure means: no-write-scope, no-scope, no-auth, not-a-repo, or other.
// GitHub names the scopes a field needs: a mutation on a project asks for plain "project", a read
// for "read:project".
export function classifyError(text) {
  const s = String(text ?? "");
  if (/scopes?:\s*\[\s*'project'\s*\]/i.test(s)) return "no-write-scope";
  if (/read:project|INSUFFICIENT_SCOPES|required scopes/i.test(s)) return "no-scope";
  if (/gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(s)) return "no-auth";
  if (/not a git repository|no git remotes|none of the git remotes|could not determine (the )?(base )?repo/i.test(s)) return "not-a-repo";
  return "other";
}

// What gh printed while it waits for the browser: its one-time code, and the page to enter it on.
export function signInFrom(text) {
  const s = String(text ?? "");
  return { code: s.match(/code \(([A-Z0-9-]+)\)/)?.[1] ?? null, url: s.match(/https:\/\/\S+/)?.[0] ?? null };
}

export function age(iso, now = Date.now()) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const m = Math.floor(Math.max(0, now - at) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// The line under a ticket's title: #123 · In progress · 3d ago.
export function ticketLine(ticket, now = Date.now()) {
  return [ticket.draft ? "Draft" : `#${ticket.number}`, ticket.status, age(ticket.createdAt, now)].filter(Boolean).join(" · ");
}

// ---- Editing one task -------------------------------------------------------------------------------
// A task as the editor holds it: { title, body, labels: [name], status: name|null }.

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
