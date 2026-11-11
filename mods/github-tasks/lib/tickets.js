// Project items as tickets, their grouping and ordering, and the lines the sidebar draws for them.

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
      tickets.push({ key: node.id, contentId: content.id ?? null, draft: true, number: null, title: content.title, url: null, state: "OPEN", reason: null, createdAt: content.createdAt, closedAt: null, status, labels: [] });
    } else if (content.__typename === "Issue" && content.repository?.nameWithOwner?.toLowerCase() === wanted) {
      tickets.push({ key: node.id, draft: false, number: content.number, title: content.title, url: content.url, state: content.state, reason: content.stateReason ?? null, createdAt: content.createdAt, closedAt: content.closedAt ?? null, status, labels: (content.labels?.nodes ?? []).map((l) => l.name) });
    }
  }
  return tickets;
}

const created = (ticket) => {
  const at = Date.parse(ticket.createdAt);
  return Number.isNaN(at) ? -Infinity : at;
};
// Newest first, then the higher number first; statuses.js groupByStage sorts by it too.
export const newestFirst = (a, b) => created(b) - created(a) || (b.number ?? 0) - (a.number ?? 0);

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

const DAY = 24 * 60 * 60 * 1000;

// Tickets closed as done within the last day, most recently closed first. closed: groupTickets' closed sections.
// A ticket closed as not planned or a duplicate wasn't done, so it is left out.
export function recentlyDone(closed, now = Date.now()) {
  const at = (t) => Date.parse(t.closedAt);
  return (closed ?? []).filter((s) => s.key !== "NOT_PLANNED" && s.key !== "DUPLICATE").flatMap((s) => s.tickets)
    .filter((t) => at(t) <= now && now - at(t) < DAY).sort((a, b) => at(b) - at(a));
}

// A title that fits max characters, losing its middle: "Some big name ... of the task".
export function middleEllipsis(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const keep = Math.max(2, max - 5), head = Math.ceil(keep / 2), tail = keep - head;
  return `${s.slice(0, head).trimEnd()} ... ${s.slice(s.length - tail).trimStart()}`;
}

// The saved project if it's still linked, else the first, which is the most recently updated.
export function chooseProject(projects, savedId) {
  return projects.find((p) => p.id === savedId) ?? projects[0] ?? null;
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
