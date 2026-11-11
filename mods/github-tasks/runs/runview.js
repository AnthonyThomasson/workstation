// What the run page lists, from the core's terminals and `hc ls`. Pure: no Herdr imports, so node --test runs it.
// A run's terminals carry the labels run.js gives them.
import { RUN_LABEL as RUN, ROLE_LABEL as ROLE, NAME_LABEL as NAME, FINAL_LABEL as FINAL } from "./run.js";

// terminals() gives the status as a word and the agent's report beside it; `hc` gives one object with both.
const statusWord = (k) => (typeof k.status === "string" ? k.status : k.status?.state) ?? null;
const reportOf = (k) => (k.report && typeof k.report === "object" ? k.report : typeof k.status === "object" ? k.status : null);

// A run's terminals are named "<run id>-<name>": the name without the run id.
const unprefixed = (k) => {
  const prefix = k.labels?.[RUN] ? `${k.labels[RUN]}-` : null;
  return prefix && k.name?.startsWith(prefix) && k.name.length > prefix.length ? k.name.slice(prefix.length) : k.name;
};

export function row(k) {
  const live = k.state === "live";
  const status = live ? statusWord(k) ?? "unknown" : "finished";
  return {
    address: k.address,
    name: k.labels?.[NAME] || unprefixed(k) || k.address,
    status,
    live,
    needsYou: live && status === "blocked",
    final: k.labels?.[FINAL] === "1", // the final reviewer, who looks over the whole ticket branch
    // What it says it is doing, else what its terminal is titled.
    detail: reportOf(k)?.msg || k.title || "",
    started: k.created_ms ?? 0,
    turn: Number.isFinite(k.turn) ? k.turn : null, // hc counts a terminal's turns: Merge's "fixing" state ends when it moves
    role: k.labels?.[ROLE] ?? null,
  };
}

// Those still running come first, so a long run's finished ones sink; then the order they started. An agent with no start
// time (known only from `hc ls`) comes after those with one, in the order it was first seen, as the sort is stable.
const inOrder = (rows) => [...rows].sort((a, b) => Number(b.live) - Number(a.live) || Number(Boolean(b.started)) - Number(Boolean(a.started)) || a.started - b.started);

// The answer of `hc ls --json`: its terminals, or null when it isn't that.
export function parseLs(stdout) {
  try {
    const list = JSON.parse(stdout)?.terminals;
    return Array.isArray(list) ? list : null;
  } catch { return null; }
}

// The terminals the core lists for a run, per role, from `hc ls --all --label run=<id> --label role=<role> [--label final=1] --json`.
// That answer has no labels (the query is the filter), so they are put back here from the query.
const asLabelled = (k, id, role, final) => ({ ...k, labels: { ...k.labels, [RUN]: id, [ROLE]: role, ...(final ? { [FINAL]: "1" } : {}) } });

// Arguments of the four queries, in the order of `listed`: { worker, reviewer, final, investigator }.
export const lsQueries = (id) => {
  const q = (...extra) => ["ls", "--all", "--label", `${RUN}=${id}`, ...extra.flatMap((l) => ["--label", l]), "--json"];
  return {
    worker: q(`${ROLE}=worker`),
    reviewer: q(`${ROLE}=reviewer`),
    final: q(`${ROLE}=reviewer`, `${FINAL}=1`),
    investigator: q(`${ROLE}=investigator`),
  };
};

// What a row keeps between visits, and so across a reload of the page.
// Not the detail: it changes with every report, and the saved rows are only written when they really change.
export const keep = (r) => ({ address: r.address, name: r.name, role: r.role, final: r.final, started: r.started });

// Whether two lists of kept rows say the same, whatever their order.
export function sameKept(a, b) {
  const key = (list) => JSON.stringify([...(list ?? [])].sort((x, y) => (x.address < y.address ? -1 : x.address > y.address ? 1 : 0)));
  return key(a) === key(b);
}

const ROLES = ["worker", "reviewer", "investigator"];

// This run's workers, reviewers and investigators: every one the core lists (running or finished), the live ones from terminals() with
// their current status and report, and those saved on an earlier visit that the core has forgotten, as finished.
//   terminals: terminals(). listed: { worker, reviewer, final, investigator }, each the terminals of an `hc ls --all` query, or null
//   when it hasn't answered. saved: the rows kept from before (see keep).
// Returns { workers, reviewers, investigators, needsYou, kept }, kept being what to save for next time.
export function agentsFor({ id, terminals, listed, saved }) {
  const byAddress = new Map();
  const put = (r, { name = true } = {}) => {
    const old = byAddress.get(r.address);
    if (!old) return byAddress.set(r.address, r);
    byAddress.set(r.address, { ...old, ...r, final: old.final || r.final, name: name ? r.name : old.name, detail: r.detail || old.detail, started: r.started || old.started });
  };
  for (const s of saved ?? []) {
    if (s?.address && ROLES.includes(s.role)) put({ ...s, status: "finished", live: false, needsYou: false });
  }
  for (const role of ["worker", "reviewer", "investigator"]) {
    for (const k of listed?.[role] ?? []) put(row(asLabelled(k, id, role, false)), { name: false });
  }
  for (const k of listed?.final ?? []) put(row(asLabelled(k, id, "reviewer", true)), { name: false });
  for (const k of terminals ?? []) {
    if (k.labels?.[RUN] !== id || !ROLES.includes(k.labels?.[ROLE])) continue;
    put(row(k), { name: Boolean(k.labels?.[NAME]) });
  }
  const all = [...byAddress.values()];
  const rows = (role) => inOrder(all.filter((r) => r.role === role));
  const workers = rows("worker"), reviewers = rows("reviewer"), investigators = rows("investigator");
  return { workers, reviewers, investigators, needsYou: all.filter((r) => r.needsYou).length, kept: [...workers, ...reviewers, ...investigators].map(keep) };
}

// The orchestrator's terminal as a row, or null when it is gone from the core altogether.
export function orchestratorOf(terminals, address) {
  const k = (terminals ?? []).find((x) => x.address === address);
  return k ? row(k) : null;
}

// A live orchestrator of the run, found by its labels (the newest if there are several), or null. The run page uses it before it
// starts a new one: the run may have one already that the page did not know of.
export function liveOrchestratorFor(terminals, id) {
  const live = (terminals ?? []).filter((k) => k.state === "live" && k.labels?.[ROLE] === "orchestrator" && k.labels?.[RUN] === id);
  live.sort((a, b) => (b.created_ms ?? 0) - (a.created_ms ?? 0));
  return live[0] ? row(live[0]) : null;
}

const WORDS = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle", error: "Error", finished: "Finished", unknown: "Running" }; // unknown: it hasn't reported, and a plain program never will
export const statusLabel = (status) => WORDS[status] ?? status;

// The theme color for a status.
export function statusColor(status, t) {
  return { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle, error: t.ansi1, finished: t.dim }[status] ?? t.unknown;
}
