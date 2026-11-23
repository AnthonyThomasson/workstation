// What `herdr-tasks device`, `device check` and `device run` answer, as plain data: the shapes the handlers (cli-ui/handlers.js) put in
// replies and cli/format.js prints. Pure: the handlers do the Herdr calls (the shared binding, hc machine ls, the deep check, the
// runner) and hand the results here. Every view is { ok: true, data, exit?, notes? } or { ok: false, code, message, data?, notes? },
// code being the reply code cli/protocol.js turns into an exit status ("not-ready": 5, "busy": 6, "usage": 2).
import { cheapHealth, failing, repoRootFor } from "./test-device.js";
import { EXIT } from "./test-run.js";

const UNBOUND = "No test device is bound. Pick a machine in Task settings (Test device).";
const LEVEL_WORD = { red: "red", yellow: "yellow", green: "green" };

// The failing checks, one line each with its fix: "  ! <message> (<fix>)".
export const problemLines = (health) => failing(health).map((c) => `  ! ${c.message}${c.fix ? ` (${c.fix})` : ""}`);

// What device run is told of the cheap light: { level, message } (the first thing wrong), or null when unbound.
export function cheapFor(light) {
  if (!light) return null;
  return { level: light.level, message: failing(light)[0]?.message ?? "" };
}

const redView = (machine, light, data) => ({
  ok: false, code: "not-ready", data,
  message: [`The test device ${machine} is ${LEVEL_WORD[light.level]}:`, ...problemLines(light)].join("\n"),
});

// `device`: the binding (as normalized) with the repo's folder and the light. Unbound or red is "not-ready" (exit 5), with the same data.
//   machines: `hc machine ls --json`'s entries
export function deviceView({ repo, binding, machines, now = Date.now() }) {
  if (!binding) return { ok: false, code: "not-ready", message: UNBOUND, data: { machine: null, repo: repo ?? null, light: null } };
  const light = cheapHealth(binding, machines, now);
  const data = { ...binding, repo: repo ?? null, repoRoot: repoRootFor(binding, repo), light };
  return light.level === "red" ? redView(binding.machine, light, data) : { ok: true, data };
}

// `device check`: the deep check's result (binding.health, saved by the check). Red is "not-ready" (exit 5).
export function checkView({ repo, binding }) {
  if (!binding) return { ok: false, code: "not-ready", message: UNBOUND, data: { machine: null, repo: repo ?? null, health: null } };
  const health = binding.health;
  const data = { machine: binding.machine, repo: repo ?? null, repoRoot: repoRootFor(binding, repo), health };
  if (!health) return { ok: false, code: "not-ready", message: `The check on ${binding.machine} gave no result.`, data };
  return health.level === "red" ? redView(binding.machine, health, data) : { ok: true, data };
}

// `device run`: the runner's { code, result?, message?, notes, kept? } as a view. A command that failed or timed out is an answer
// (ok, exit 1); no device, a busy one or a bad commit are not.
export function runView(r) {
  const notes = [...(r.notes ?? [])];
  if (r.result) {
    const { exitCode, timedOut } = r.result;
    if (r.code !== EXIT.PASSED && !timedOut) notes.push(`The command exited with ${exitCode}.`);
    return { ok: true, data: { ...r.result, ...(r.kept ? { kept: r.kept } : {}) }, exit: r.code, notes };
  }
  const code = r.code === EXIT.BUSY ? "busy" : r.code === EXIT.USAGE ? "usage" : "not-ready";
  return { ok: false, code, message: r.message || "The run didn't finish.", notes };
}
