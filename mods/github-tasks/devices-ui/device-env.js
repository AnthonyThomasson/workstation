// Herdr's side of the Test device, shared by the settings card, the sidebar light and herdr-tasks' device commands: the shared
// binding, `hc machine ls`, and the calls that bind and check a machine. The decisions are in devices/ (test-device.js,
// deep-check.js); this only gives them Herdr's exec and state. Nothing here runs on an interval.
import { exec, hc, readTextFile, setShared, shared } from "herdr";
import { TEST_DEVICE, projectConfigPath } from "../lib/index.js";
import { bindMachine, machinesFrom, normalizeBinding, repoRootFor, requiresFromConfig, runDeepCheck, withHealth } from "../devices/index.js";
import { hostOf } from "../runs/index.js";

// Herdr's exec as the devices/ code takes it: resolves { code, stdout, stderr } and never rejects (a call that can't run is code 1).
export const deviceExec = (cmd, args, opts) => exec(cmd, args, opts)
  .catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));

// `hc machine ls --json`: herdr-core answers it on this computer, nothing spawns on a machine. -> the entries; throws if it can't be read.
export async function listMachines() {
  const r = await hc(["machine", "ls", "--json"]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  let json = null;
  if (r.code === 0) { try { json = JSON.parse(r.stdout); } catch { json = null; } }
  if (json === null) throw new Error(String(r.stderr || "hc machine ls --json gave no machine list").trim().split("\n")[0]);
  return machinesFrom(json);
}

// The saved binding, normalized (anything malformed is unbound: null).
export const readBinding = () => normalizeBinding(shared(TEST_DEVICE));
// Saves a binding, or clears the key (null): unbinding touches nothing on the device.
export const saveBinding = (binding) => setShared(TEST_DEVICE, binding ?? null);

// The commands the repo's .herdr/config.yaml (in cwd, on this computer) lists under test_device.requires.
async function requiresFor(cwd) {
  if (!cwd) return [];
  return requiresFromConfig(await readTextFile(projectConfigPath(cwd)).catch(() => null));
}

// A check takes seconds on a desktop: if the person unbound (or bound another machine) meanwhile, the result is dropped.
function saveIfStill(machine, next) {
  if (readBinding()?.machine !== machine) return readBinding();
  saveBinding(next);
  return next;
}

// Binds machine: probes it once and caches { os, home } (saved at once, so pages show it), then checkDevice. -> the binding. Throws
// with the reason when the machine can't be probed (nothing is bound then).
export async function bindDevice(machine, { repo, cwd }) {
  const host = await hostOf({ exec: deviceExec, seen: new Map() }, machine);
  const binding = bindMachine(machine, host);
  if (!binding) throw new Error(`${machine} gave no OS or home folder.`);
  saveBinding(binding);
  return checkDevice({ repo, cwd });
}

// Runs the deep check for the bound machine (one script through shOn, with the binding's cached host: no probe), saves the health
// and returns the binding. null when nothing is bound.
export async function checkDevice({ repo, cwd }) {
  const binding = readBinding();
  if (!binding) return null;
  const { health } = await runDeepCheck({ exec: deviceExec }, {
    machine: binding.machine, repo, repoRoot: repoRootFor(binding, repo), requires: await requiresFor(cwd),
    host: { os: binding.os, home: binding.home },
  });
  return saveIfStill(binding.machine, withHealth(binding, health));
}
