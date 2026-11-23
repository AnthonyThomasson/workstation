// Runs the deep check on the Test device: probe it, run DEEP_SCRIPT once through shOn, judge what it printed. No Herdr import:
// exec is passed in (as in runs/remote.js), so node --test runs it with a fake. Called on bind, on Check and by `herdr-tasks device
// check`, never on an interval.
//   deps: { exec, probe?, seen? } as runs/remote.js's hostOf and shOn take them
import { hostOf, shOn } from "../runs/index.js";
import { DEEP_TIMEOUT_MS } from "../lib/index.js";
import { DEEP_SCRIPT, deepArgs, deepChecks, healthOf, probeFailure } from "./test-device.js";

export { DEEP_TIMEOUT_MS };

// -> { host: { on, os, home } | null, health: { level, checks, at } }. Never rejects: a probe or exec that fails is a red check.
//   input: { machine, repo, repoRoot, requires, now, host }. host: the binding's cached { os, home } (or a full host), so a check after
//   a reload doesn't probe again; bind has none and probes. The probe's answer is kept in deps.seen as hostOf does.
export async function runDeepCheck(deps, { machine, repo, repoRoot = null, requires = [], now = Date.now(), host: cached = null }) {
  if (cached?.os && cached?.home) {
    const seen = deps.seen ?? new Map();
    if (!seen.has(machine)) seen.set(machine, { on: machine, os: cached.os, home: cached.home });
    deps = { ...deps, seen };
  }
  let host;
  try {
    host = await hostOf(deps, machine);
  } catch (e) {
    return { host: null, health: healthOf([probeFailure(machine, e)], now) };
  }
  const run = await shOn(deps, machine, DEEP_SCRIPT, deepArgs({ repoRoot, requires }), { timeout: DEEP_TIMEOUT_MS })
    .catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  return { host, health: healthOf(deepChecks({ machine, repo, repoRoot, requires }, run), now) };
}
