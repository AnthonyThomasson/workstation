// The bell on a Tasks row: which of a run's (or a New Task session's) agents need the person, which rows go to the top, and when a
// row shakes. Agents run paneless, so Herdr's Agents panel doesn't list them; the sidebar says when one is blocked or in error.
// Pure: main.js hands it terminals() and draws what it answers, and node --test checks it.

const WAITING = ["blocked", "error"];
const statusWord = (k) => (typeof k?.status === "string" ? k.status : k?.status?.state) ?? null;

// The live terminals of one run or session that need the person: those labelled `label`=`id` (the run's or the investigation's
// id label) whose status is blocked or error. [{ address, name, status }], blocked before error, then the one that started first.
// The name is the terminal's, without the "<id>-" the run puts in front of it.
export function waitingAgents(terminals, label, id) {
  if (!id || !label) return [];
  const rank = (a) => WAITING.indexOf(a.status);
  return (terminals ?? [])
    .filter((k) => k?.state === "live" && k.labels?.[label] === id && WAITING.includes(statusWord(k)))
    .map((k) => ({ address: k.address, name: k.name?.startsWith(`${id}-`) && k.name.length > id.length + 1 ? k.name.slice(id.length + 1) : k.name || k.address, status: statusWord(k), started: k.created_ms ?? 0 }))
    .sort((a, b) => rank(a) - rank(b) || a.started - b.started)
    .map(({ address, name, status }) => ({ address, name, status }));
}

// The same list with the items `waiting` says need the person first. Each group keeps its own order, and the list given isn't changed.
export function bellFirst(items, waiting) {
  const list = items ?? [];
  const yes = [], no = [];
  for (const item of list) (waiting(item) ? yes : no).push(item);
  return [...yes, ...no];
}

// What the bell's tooltip says for these waiting agents (waitingAgents' answer): the first one, and how many more.
export function bellTip(agents) {
  const [first, ...more] = agents ?? [];
  if (!first) return "";
  if (first.status === "error" && !more.length) return `${first.name} hit an error. Click to look.`;
  return `${first.name} ${first.status === "error" ? "hit an error" : "needs you"}${more.length ? ` (and ${more.length} more)` : ""}. Click to answer.`;
}

export const BACK_AFTER = 140; // ms the row stays pushed out before it is let go
export const SHAKE_FOR = 1500; // ms after which the shake is over

// When rows shake. observe(waiting, now) is told, on every draw, which rows (by key) need the person: { key: boolean } as a Map. A row that
// didn't and now does has just started needing them and shakes once; the first time a row is seen it doesn't (the app just started, or
// the space was just selected), and one that goes away and comes back is new again. phase(key, now) says where the shake is:
// "out" (pushed sideways), "back" (let go: the spring in main.js makes it overshoot and settle, which is the shake) or null (not shaking).
export class Shakes {
  constructor() {
    this.waiting = new Map(); // key -> whether it needed the person at the last look
    this.since = new Map(); // key -> when its shake began
  }

  observe(waiting, now) {
    for (const [key, needs] of waiting) {
      if (this.waiting.get(key) === false && needs) this.since.set(key, now);
      if (!needs) this.since.delete(key);
    }
    for (const key of [...this.since.keys()]) if (!waiting.has(key)) this.since.delete(key);
    this.waiting = new Map(waiting);
  }

  // How many ms until a row that is pushed out is let go (the frame main.js must draw), or null when it isn't pushed out. Each row has its own.
  releaseIn(key, now) {
    return this.phase(key, now) === "out" ? BACK_AFTER - (now - this.since.get(key)) : null;
  }

  phase(key, now) {
    const at = this.since.get(key);
    if (at === undefined || !this.waiting.get(key)) return null;
    const age = now - at;
    return age < BACK_AFTER ? "out" : age < SHAKE_FOR ? "back" : null;
  }
}
