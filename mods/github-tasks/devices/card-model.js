// What the Test device card and the sidebar's light show, worked out from the binding, `hc machine ls --json` and the clock.
// Pure: devices-ui/ draws it. The light is the cheap one (test-device.js cheapHealth: machine ls plus the cached deep result), so
// drawing it never spawns anything on the device and there is no timer here either.
import { LOGIN, REFRESH } from "../lib/index.js";
import { posixFolder } from "../workflow/index.js";
import { cheapHealth, failing, machinesFrom, repoRootFor, startsHere } from "./test-device.js";

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// "just now", "5 min ago", "3 h ago", "2 days ago"; null when there is no time.
export function agoText(at, now = Date.now()) {
  if (!Number.isFinite(at)) return null;
  const age = Math.max(0, now - at);
  if (age < MIN) return "just now";
  if (age < HOUR) return `${Math.floor(age / MIN)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  const days = Math.floor(age / DAY);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

// The theme colour (a key of Herdr's theme) a level is drawn in.
export const lightColor = (level) => ({ green: "ansi2", yellow: "ansi3", red: "ansi1" })[level] ?? "ansi1";

// The sorted, de-duplicated machine names of a list, one string: [{ name }] -> "a\nb". --temp machines are in hc machine ls
// (temporary: true) but not in herdr's machines(), so they are left out. Anything that isn't a list is "".
export const namesKey = (xs) => [...new Set((Array.isArray(xs) ? xs : []).filter((m) => m?.temporary !== true).map((m) => (typeof m?.name === "string" ? m.name.trim() : "")).filter(Boolean))].sort().join("\n");

// Whether herdr's live machine names (the reactive herdr machines(): [{ name }], the local one unnamed) differ from the names in the last
// hc machine ls list, which means a machine was added or removed since and the list should be asked again. No list yet: false.
export function machinesChanged(live, list) {
  if (list === null || list === undefined) return false;
  return namesKey(live) !== namesKey(list);
}

// Whether `hc machine ls` should be asked again, from a render or a refresh (never a timer). Pure; devices-ui/machines.js keeps the state.
//   s: { now, at (when it was last asked), loading, live (herdr's machines()), list (the last answer, null before any),
//        askedFor (namesKey of the live names the last ask happened under), freshMs, minGapMs }
// Never while a load runs. Stale (older than freshMs): yes. A change of names (live no longer matches the list): yes, but only ONCE per
// distinct set of live names (askedFor), so names that machines() and machine ls never agree on can't re-ask every minGapMs while
// something keeps rendering; after that only the staleness asks, or live names changing again.
export function machinesDue({ now, at, loading, live, list, askedFor = null, freshMs = 20000, minGapMs = 2000 }) {
  if (loading) return false;
  if (now - at > freshMs) return true;
  return now - at > minGapMs && machinesChanged(live, list) && namesKey(live) !== askedFor;
}

// The one-line fix button of a check: the existing device-flow sign-in (github-ui/auth.js Auth.start with `on`), with the gh args it
// runs (lib/gh-sign-in.js). Only for gh being signed in without the project scope or not at all; a missing gh has no button.
export function signInFor(check, machine) {
  if (check?.id === "gh-scope") return { label: `Sign in on ${machine}`, args: REFRESH };
  if (check?.id === "gh-auth") return { label: `Sign in on ${machine}`, args: LOGIN };
  return null;
}

// A tooltip: the light's level, then each failing check as "• message fix".
export function tooltipOf(machine, level, checks) {
  const lines = (checks ?? []).map((c) => `• ${[c.message, c.fix].filter(Boolean).join(" ")}`);
  return [`Test device ${machine}: ${level}`, ...lines].join("\n");
}

// The per-repo opt-in: "Start this repo's tickets on <machine>". Offered only when the repo has a folder on the machine (without one
// Start has nowhere to put the worktree), off until pressed. `offered: false` draws no toggle.
export function startToggle(binding, repo) {
  const offered = Boolean(binding && repo && repoRootFor(binding, repo));
  return { offered, on: offered && startsHere(binding, repo), label: `Start this repo's tickets on ${binding?.machine ?? ""}` };
}

// What the card draws. machines: `hc machine ls --json` (or null before it has answered); repo: "owner/name" or "".
export function cardView({ binding, machines, repo, now = Date.now() }) {
  const loading = machines === null || machines === undefined; // hc machine ls hasn't answered yet: not "no machines"
  if (!binding) {
    const all = machinesFrom(machines).filter((m) => m?.temporary !== true); // a --temp machine is a sandbox, not one to bind
    const pick = all.filter((m) => m?.state === "connected").map((m) => String(m.name ?? "").trim()).filter(Boolean);
    return { bound: false, loading, pick, addMachine: !loading && all.length === 0, noneConnected: !loading && all.length > 0 && pick.length === 0, light: null };
  }
  if (loading) {
    return { bound: true, loading, machine: binding.machine, title: `${binding.machine} · ${binding.os}`, light: null, level: null, color: null, failing: [], checkedAgo: null,
      folderLabel: `Repo folder on ${binding.machine}`, canSetFolder: Boolean(repo), repoFolder: (repo && repoRootFor(binding, repo)) || "", startToggle: startToggle(binding, repo) };
  }
  const light = cheapHealth(binding, machines, now);
  const bad = failing(light);
  return {
    bound: true,
    loading,
    machine: binding.machine,
    title: `${binding.machine} · ${binding.os}`,
    light,
    level: light.level,
    color: lightColor(light.level),
    failing: bad.map((c) => ({ ...c, signIn: signInFor(c, binding.machine) })),
    checkedAgo: agoText(light.checkedAt, now),
    folderLabel: `Repo folder on ${binding.machine}`,
    canSetFolder: Boolean(repo),
    repoFolder: (repo && repoRootFor(binding, repo)) || "",
    startToggle: startToggle(binding, repo),
  };
}

// The little dot beside the sidebar's gear: null when unbound, else { level, color, tip } from the same cheap light.
export function headerDot(binding, machines, now = Date.now()) {
  if (!binding || machines === null || machines === undefined) return null;
  const light = cheapHealth(binding, machines, now);
  return { level: light.level, color: lightColor(light.level), tip: tooltipOf(binding.machine, light.level, failing(light)) };
}

// The folders of the spaces that are on a machine (each once, as forward-slash paths): where its repo clones might be.
export function spaceFolders(spaces, machine) {
  const seen = new Set();
  for (const s of spaces ?? []) {
    const folder = s?.machine === machine && typeof s.folder === "string" ? posixFolder(s.folder.trim()) : "";
    if (folder) seen.add(folder);
  }
  return [...seen];
}
