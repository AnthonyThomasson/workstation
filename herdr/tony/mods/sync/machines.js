// The Machines section: one card per machine (this computer and each Herdr machine) with skillshare's
// version and health, how much still needs a sync, and the source's git state; "Pull and sync" and
// the CLI upgrade. Ported from the skills mod's old Machines tab (git show 7bcf58e). No Herdr imports:
// main.js decides when to load; the tests (machines.test.js) pass a fake machine.
//   io.job(args, { on, cwd }), io.run(args, { on }), io.sh(script, args, on) as in source.js.
import { parseJSON, driftFrom, failure } from "./targets.js";
import { readSource, standalone } from "./source.js";

// The newer of two versions ("v0.29.1" or "0.29.1").
export function newerVersion(a, b) {
  const n = (v) => String(v ?? "").replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const x = n(a), y = n(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? a : b;
  return a;
}

export const bareVersion = (v) => String(v ?? "").replace(/^v/, "");

// One card: the CLI's version and health, drift, and the source's git state. `configRepo` is the repo
// set for that machine ("" when none), so the source can be told apart from it.
export async function loadMachine(io, on, { configRepo = "" } = {}) {
  const [host, doctor, diff, status] = await Promise.all([
    on ? Promise.resolve({ stdout: on }) : io.sh("hostname -s", [], null),
    io.job(["doctor", "--json", "-g"], { on }), io.run(["diff", "--json", "-g"], { on }), io.run(["status", "--json", "-g"], { on }),
  ]);
  const st = parseJSON(status.stdout), d = parseJSON(doctor.stdout);
  const git = st?.source?.path ? await readSource(io, { on, path: st.source.path, configRepo }) : null;
  return {
    on, label: on ?? (host.stdout.trim() || "this computer"), here: !on, missing: status.code === 127 || /not found/.test(status.stderr),
    version: d?.version?.current ?? st?.version ?? null, latest: d?.version?.latest ?? null, update: Boolean(d?.version?.update_available),
    doctor: d?.summary ?? null, targets: (st?.targets ?? []).filter((x) => x.skills_enabled !== false).length,
    drift: driftFrom(parseJSON(diff.stdout)).size, git,
  };
}

// The newest version any card shows, so a machine that lags is told to update even when the CLI's
// own check could not reach the network.
export const latestOf = (cards) => cards.reduce((v, m) => (m.version ? (v ? newerVersion(v, m.version) : m.version) : v), null);

// The version a card can update to, or null.
export function updateTo(card, latest) {
  if (card.update && card.latest) return card.latest;
  return latest && card.version && newerVersion(latest, card.version) !== card.version ? latest : null;
}

// The source line on a card.
export function sourceText(git) {
  if (!git || git.repo === false) return "no git";
  if (git.same) return "in the config repo";
  const behind = git.behind?.length ?? 0, dirty = git.uncommitted?.length ?? 0;
  return behind ? `↓${behind} behind` : dirty ? `${dirty} uncommitted` : "up to date";
}

// What "Pull and sync" does on a machine: "both" (a config repo is set AND the source is its own git
// repo: pull the config repo, then the source), "repo" (its config repo is set, and the source is in it or
// not its own repo), "source" (only the source's own repo: skillshare pull), or "targets" (only link the targets).
export function pullPlan({ cfg, card }) {
  const own = standalone(card?.git) && card.git.repo !== false;
  if (own) return cfg?.repo ? "both" : "source";
  if (cfg?.repo) return "repo";
  return "targets";
}

// Upgrade skillshare's CLI on a machine: skillshare upgrade --cli --force.
export async function upgradeCli(io, { on = null, label, step = () => {} }) {
  step(`Updating skillshare on ${label}…`);
  const r = await io.job(["upgrade", "--cli", "--force"], { on });
  return r.code === 0 ? { kind: "done", text: `Updated skillshare on ${label}` } : { kind: "error", text: failure(r, "skillshare upgrade") };
}
