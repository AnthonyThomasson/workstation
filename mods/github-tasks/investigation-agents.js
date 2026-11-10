// What an Investigation's page lists, from the core's terminals and `hc ls`: the session's investigators and prototype workers
// (the labels investigations.js gives them: herdr.investigation=<id>, herdr.role=investigator|worker). Pure: no Herdr imports,
// so node --test runs it. The same shape as runview.js's agentsFor for a run, kept apart from it.
import { FOLDER_LABEL, NAME_LABEL, ROLE_LABEL } from "./run.js";
import { row, keep } from "./runview.js";

const SESSION = "herdr.investigation"; // investigations.js INVESTIGATION_LABEL (not imported: that file pulls in bgrun.js)
const ROLES = ["investigator", "worker"];

// Arguments of the two queries, in the order of `listed`: { investigator, worker }.
export const investigationQueries = (id) => {
  const q = (role) => ["ls", "--all", "--label", `${SESSION}=${id}`, "--label", `${ROLE_LABEL}=${role}`, "--json"];
  return { investigator: q("investigator"), worker: q("worker") };
};

// A prototype worker <job> works in <session worktree>--<job>.
export const workerFolder = (workDir, job) => `${workDir}--${job}`;

// A worktree folder as the page shows it: "…--<job>" for a worker's, else its last part.
export function shortFolder(folder) {
  const last = String(folder ?? "").split("/").filter(Boolean).pop() ?? "";
  const at = last.lastIndexOf("--");
  return at >= 0 ? `…${last.slice(at)}` : last;
}

// The terminal is named "<session id>-<name>": the name without the id.
const unprefixed = (id, name) => (name?.startsWith(`${id}-`) && name.length > id.length + 1 ? name.slice(id.length + 1) : name);

// A row of the page: runview.js's row, with the name taken from this session's prefix and a worker's detail being its folder.
function agentRow(id, workDir, k, role) {
  const r = row(k);
  const name = k.labels?.[NAME_LABEL] || unprefixed(id, k.name) || k.address;
  const folder = k.labels?.[FOLDER_LABEL] || (workDir ? workerFolder(workDir, name) : "");
  return { ...r, name, role, detail: role === "worker" ? shortFolder(folder) : r.detail };
}

// Those still running come first; then the order they started (one with no start time, known only from `hc ls`, after those with one).
const inOrder = (rows) => [...rows].sort((a, b) => Number(b.live) - Number(a.live) || Number(Boolean(b.started)) - Number(Boolean(a.started)) || a.started - b.started);

// The session's investigators and workers: every one the core lists (running or finished), the live ones from terminals() with
// their current status and report, and those saved on an earlier visit that the core has forgotten, as finished.
//   terminals: terminals(). listed: { investigator, worker }, each the terminals of an `hc ls --all` query (no labels: the query
//   is the filter), or null when it hasn't answered. saved: the rows kept from before. workDir: the session's worktree.
// Returns { investigators, workers, needsYou, kept }, kept being what to save for next time (runview.js keep).
export function investigationAgentsFor({ id, workDir, terminals, listed, saved }) {
  const byAddress = new Map();
  const put = (r, { name = true } = {}) => {
    const old = byAddress.get(r.address);
    if (!old) return byAddress.set(r.address, r);
    byAddress.set(r.address, { ...old, ...r, name: name ? r.name : old.name, detail: r.detail || old.detail, started: r.started || old.started });
  };
  for (const s of saved ?? []) {
    if (!s?.address || !ROLES.includes(s.role)) continue;
    const folder = s.role === "worker" && workDir ? shortFolder(workerFolder(workDir, s.name)) : "";
    put({ ...s, status: "finished", live: false, needsYou: false, detail: folder });
  }
  for (const role of ROLES) {
    for (const k of listed?.[role] ?? []) put(agentRow(id, workDir, { ...k, labels: { ...k.labels, [SESSION]: id, [ROLE_LABEL]: role } }, role), { name: false });
  }
  for (const k of terminals ?? []) {
    const role = k.labels?.[ROLE_LABEL];
    if (k.labels?.[SESSION] !== id || !ROLES.includes(role)) continue;
    put(agentRow(id, workDir, k, role), { name: Boolean(k.labels?.[NAME_LABEL]) });
  }
  const all = [...byAddress.values()];
  const rows = (role) => inOrder(all.filter((r) => r.role === role));
  const investigators = rows("investigator"), workers = rows("worker");
  return { investigators, workers, needsYou: all.filter((r) => r.needsYou).length, kept: [...investigators, ...workers].map(keep) };
}
