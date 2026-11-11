// The command line's mailbox, as plain data: what a request and a reply are, the names of their files, the checks the sidebar's bridge
// (cli-ui/bridge.js) makes before it acts on one, and how a ticket, project or named thing is found from what was typed. client.js
// writes the requests and reads the replies; nothing here touches a file. Where the mailbox is: workflow/places.js (cliRequestsDir,
// cliRepliesDir).

export const VERSION = 1;

// What herdr-tasks exits with.
export const EXIT = { ok: 0, failed: 1, usage: 2, choose: 3, noAnswer: 4 };

// Every operation the bridge answers (commands.js names the command each comes from).
export const OPS = [
  "list", "show", "create", "edit", "move", "wontdo", "open",
  "start", "view", "runs", "merge",
  "new-task", "refactor", "investigations", "investigation-view", "investigation-done",
  "projects", "project-use", "project-create", "workflows", "doctor", "refresh",
];

// A request's id: its time and a random part, both base 36, so the names sort by time and never hold a path.
const ID = /^[a-z0-9]{1,16}-[a-z0-9]{1,16}$/;
export const requestId = (now = Date.now(), random = Math.random()) =>
  `${Math.max(0, Math.floor(now)).toString(36)}-${Math.floor(Math.abs(random) * 36 ** 8).toString(36).padStart(8, "0").slice(-8)}`;
export const isId = (id) => typeof id === "string" && ID.test(id);

// The files, by name, in the requests and replies folders. A request is written as <id>.json (client.js writes it under another name
// and renames it, so it is never read half-written), taken by renaming it to <id>.json.claimed (one rename: a second bridge that tries
// fails), and its reply is written as <id>.json.part, then renamed to <id>.json.
export const fileName = (id) => `${id}.json`;
export const claimedName = (id) => `${id}.json.claimed`;
export const partName = (id) => `${id}.json.part`;
// The id of a request file waiting to be taken, or null for anything else in the folder.
export const waitingId = (name) => {
  const m = /^([a-z0-9-]+)\.json$/.exec(String(name ?? ""));
  return m && isId(m[1]) ? m[1] : null;
};

// The request client.js sends. where: { cwd, on }; project: what --project said, or null; timeout: seconds the client waits.
export const makeRequest = ({ id, op, args = {}, where, project = null, at, timeout }) => ({
  v: VERSION, id, op, args, where: { cwd: where?.cwd ?? null, on: where?.on ?? null }, project, at, timeout,
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A request file's text as the bridge reads it: { request }, { expired: id } when its client has stopped waiting, or { error, id }
// (id null when not even that could be read). Only requests this version writes are acted on.
export function checkRequest(text, now = Date.now()) {
  let r;
  try { r = JSON.parse(text); } catch { return { error: "The request isn't JSON.", id: null }; }
  if (!isObject(r)) return { error: "The request isn't an object.", id: null };
  const id = isId(r.id) ? r.id : null;
  if (!id) return { error: "The request has no id.", id: null };
  if (r.v !== VERSION) return { error: `This Tasks speaks version ${VERSION} of the command line's requests, not ${r.v}: update the mod or herdr-tasks.`, id };
  if (!OPS.includes(r.op)) return { error: `Tasks has no "${r.op}" operation.`, id };
  if (!isObject(r.args)) return { error: "The request's args aren't an object.", id };
  if (!isObject(r.where) || typeof r.where.cwd !== "string" || !r.where.cwd.startsWith("/")) return { error: "The request names no folder to work in.", id };
  if (r.where.on !== null && r.where.on !== undefined && typeof r.where.on !== "string") return { error: "The request's machine isn't a name.", id };
  if (r.project !== null && r.project !== undefined && typeof r.project !== "string") return { error: "The request's project isn't a name.", id };
  if (!Number.isFinite(r.at) || !Number.isFinite(r.timeout) || r.timeout <= 0) return { error: "The request has no time.", id };
  if (now > r.at + r.timeout * 1000) return { expired: id };
  return { request: { ...r, where: { cwd: r.where.cwd, on: r.where.on || null }, project: r.project || null } };
}

// The replies. code: a word client.js turns into an exit code ("choose": a choice is needed; data then holds the choices).
export const okReply = (id, data = {}) => ({ v: VERSION, id, ok: true, data });
export const failReply = (id, error, { code = null, data = null } = {}) => ({ v: VERSION, id, ok: false, error: String(error ?? "It failed."), code, data });

// A failure with a reply code and data, thrown by a handler and turned into a failReply by the bridge.
export class CliError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// The exit code for a reply.
export const exitFor = (reply) => (reply?.ok ? EXIT.ok : reply?.code === "choose" ? EXIT.choose : EXIT.failed);

// ---- Finding what was typed ------------------------------------------------------------------------------------------

const lower = (s) => String(s ?? "").trim().toLowerCase();

// A ticket among tickets (lib/tickets.js normalizeItems'), by what was typed: its number ("12" or "#12"), its project item key
// ("PVTI_…"), or its title, whole and ignoring case. { ticket } or { error }.
export function findTicket(tickets, ref) {
  const text = String(ref ?? "").trim();
  if (!text) return { error: "Name a ticket: its number (#12), its project item key or its title." };
  const list = tickets ?? [];
  const number = /^#?(\d+)$/.exec(text);
  if (number) {
    const found = list.find((t) => t.number === Number(number[1]));
    return found ? { ticket: found } : { error: `The project has no ticket #${number[1]}.` };
  }
  const byKey = list.find((t) => t.key === text);
  if (byKey) return { ticket: byKey };
  const byTitle = list.filter((t) => lower(t.title) === lower(text));
  if (byTitle.length === 1) return { ticket: byTitle[0] };
  if (byTitle.length > 1) return { error: `${byTitle.length} tickets are called "${text}": name one by number (${byTitle.map((t) => (t.number ? `#${t.number}` : t.key)).join(", ")}).` };
  return { error: `The project has no ticket "${text}".` };
}

// One of several things with an id and a name (a project: id and title; a workflow, a refactor type): by its id, else its name,
// ignoring case. { item } or { error }. what: how to call it in the error ("workflow").
export function findNamed(items, ref, what, name = (x) => x.name) {
  const text = lower(ref);
  const list = items ?? [];
  const byId = list.filter((x) => lower(x.id) === text || (x.key && lower(x.key) === text));
  if (byId.length === 1) return { item: byId[0] };
  const byName = list.filter((x) => lower(name(x)) === text);
  if (byName.length === 1) return { item: byName[0] };
  const known = list.map((x) => `${name(x)} (${x.key ?? x.id})`).join(", ");
  if (byId.length + byName.length > 1) return { error: `More than one ${what} is called "${ref}": name it by id. There are: ${known}.` };
  return { error: `There is no ${what} "${ref}".${known ? ` There are: ${known}.` : ""}` };
}

// The project to use: the one --project named, else the one the Tasks sidebar picked for the repo (chooseProject's). { project } or
// { error }.
export function pickProject(projects, ref, chosen) {
  if (!ref) return chosen ? { project: chosen } : { error: "No GitHub Project is linked to this repo. Make one with: herdr-tasks project create" };
  const found = findNamed(projects, ref, "project linked to this repo", (p) => p.title);
  return found.item ? { project: found.item } : { error: found.error };
}
