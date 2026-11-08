// What the run page lists, from the core's terminals. Pure: no Herdr imports, so node --test runs it.
// A run's terminals carry the labels run.js gives them.
import { RUN_LABEL as RUN, ROLE_LABEL as ROLE, NAME_LABEL as NAME, FINAL_LABEL as FINAL } from "./run.js";

// terminals() gives the status as a word and the agent's report beside it; `hc` gives one object with both.
const statusWord = (k) => (typeof k.status === "string" ? k.status : k.status?.state) ?? null;
const reportOf = (k) => (k.report && typeof k.report === "object" ? k.report : typeof k.status === "object" ? k.status : null);

export function row(k) {
  const live = k.state === "live";
  const status = live ? statusWord(k) ?? "unknown" : "finished";
  return {
    address: k.address,
    name: k.labels?.[NAME] || k.name || k.address,
    status,
    live,
    needsYou: live && status === "blocked",
    final: k.labels?.[FINAL] === "1", // the final reviewer, who looks over the whole ticket branch
    // What it says it is doing, else what its terminal is titled.
    detail: reportOf(k)?.msg || k.title || "",
    started: k.created_ms ?? 0,
  };
}

// In the order they were started. Those still running come first, so a long run's finished ones sink.
const inOrder = (rows) => [...rows].sort((a, b) => Number(b.live) - Number(a.live) || a.started - b.started || a.address.localeCompare(b.address));

// { workers, reviewers, needsYou }: this run's agents, and how many are waiting on the person.
export function agentsOf(terminals, id) {
  const mine = (terminals ?? []).filter((k) => k.labels?.[RUN] === id);
  const rows = (role) => inOrder(mine.filter((k) => k.labels?.[ROLE] === role).map(row));
  const workers = rows("worker"), reviewers = rows("reviewer");
  return { workers, reviewers, needsYou: [...workers, ...reviewers].filter((r) => r.needsYou).length };
}

// The core forgets a terminal that ended, so a list of agents would lose those that finished. seen: a Map of
// every row shown so far, kept by the caller and updated here. Returns rows with the gone ones back, as finished.
export function withGone(rows, seen) {
  for (const r of rows) seen.set(r.address, r);
  const here = new Set(rows.map((r) => r.address));
  const gone = [...seen.values()].filter((r) => !here.has(r.address)).map((r) => ({ ...r, status: "finished", live: false, needsYou: false }));
  return inOrder([...rows, ...gone]);
}

// The orchestrator's terminal as a row, or null when it is gone from the core altogether.
export function orchestratorOf(terminals, address) {
  const k = (terminals ?? []).find((x) => x.address === address);
  return k ? row(k) : null;
}

const WORDS = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle", error: "Error", finished: "Finished", unknown: "Running" }; // unknown: it hasn't reported, and a plain program never will
export const statusLabel = (status) => WORDS[status] ?? status;

// The theme color for a status.
export function statusColor(status, t) {
  return { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle, error: t.ansi1, finished: t.dim }[status] ?? t.unknown;
}
