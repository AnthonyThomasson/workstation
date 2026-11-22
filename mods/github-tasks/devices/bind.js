// Binding a machine and checking it, as the Task settings card does: probe once, cache { os, home }, look for the repo's folder in
// the machine's spaces, run the deep check. Pure: exec is passed in (Herdr's exec, or a fake), as in deep-check.js. Nothing here
// runs on an interval; the card calls these from its buttons only.
//   deps: { exec, probe?, seen? } as runs/remote.js's hostOf takes them
import { probeMachine, shOn } from "../runs/index.js";
import { runDeepCheck } from "./deep-check.js";
import { bindMachine, pickRepoFolder, repoRootFor, withHealth, withRepoRoot } from "./test-device.js";

// ONE script (through shOn: sh, or Git Bash on Windows, one spawn) for all the folders: $@ are folders. For each one that is a git repo
// it prints its main checkout (the first entry of `git worktree list`, else the top level) and that checkout's origin, as
// `fr.main=` and `fr.origin=` lines. Folders git can't read print nothing. It writes nothing.
export const FIND_SCRIPT = String.raw`for f in "$@"; do
  [ -d "$f" ] || continue
  m=$(git -C "$f" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
  [ -n "$m" ] || m=$(git -C "$f" rev-parse --show-toplevel 2>/dev/null)
  [ -n "$m" ] || continue
  printf 'fr.main=%s\n' "$m"
  printf 'fr.origin=%s\n' "$(git -C "$m" remote get-url origin 2>/dev/null)"
done
`;

// FIND_SCRIPT's output (CRLF read like LF) -> [{ mainRoot, remote }], one per folder it could read.
export function parseFound(stdout) {
  const found = [];
  for (const line of String(stdout ?? "").replace(/\r/g, "").split("\n")) {
    const m = line.match(/^fr\.(main|origin)=(.*)$/);
    if (!m) continue;
    if (m[1] === "main") found.push({ mainRoot: m[2].trim(), remote: "" });
    else if (found.length) found[found.length - 1].remote = m[2].trim();
  }
  return found;
}

// The folder on the machine that holds this repo's main checkout, found from the folders of the spaces open on that machine
// (spaceFolders): one FIND_SCRIPT run asks them all for their main checkout and its origin, and pickRepoFolder takes the one whose
// origin is the repo. null when none matches, there are no folders, or the script can't run.
export async function findRepoFolder(deps, { machine, repo, folders }) {
  if (!repo || !(folders ?? []).length) return null;
  const r = await shOn(deps, machine, FIND_SCRIPT, folders, { timeout: FIND_TIMEOUT_MS }).catch(() => null);
  if (!r || r.code !== 0) return null;
  return pickRepoFolder(parseFound(r.stdout).map((f) => ({ on: machine, ...f })), { machine, repo });
}
const FIND_TIMEOUT_MS = 120000;

// deps with the binding's cached host already known, so nothing after a bind or reload probes the machine again.
const withHost = (deps, binding) => {
  const seen = deps.seen ?? new Map();
  if (!seen.has(binding.machine)) seen.set(binding.machine, { on: binding.machine, os: binding.os, home: binding.home });
  return { ...deps, seen };
};

// Runs the deep check for a binding, first filling in the repo folder from the machine's spaces when none is set (a typed one is
// never replaced). -> the binding with its health saved ({ level, checks, at }) and the folder it used.
//   input: { binding, repo, folders, requires, now }
export async function checkFlow(baseDeps, { binding, repo, folders = [], requires = [], now = Date.now() }) {
  const deps = withHost(baseDeps, binding);
  let next = binding;
  if (repo && !repoRootFor(next, repo)) {
    const found = await findRepoFolder(deps, { machine: next.machine, repo, folders }).catch(() => null);
    if (found) next = withRepoRoot(next, repo, found);
  }
  const { health } = await runDeepCheck(deps, {
    machine: next.machine, repo, repoRoot: repo ? repoRootFor(next, repo) : null, requires, now, host: { os: next.os, home: next.home },
  });
  return withHealth(next, health);
}

// Binds a machine: the one probe, then onBound(binding) (so the card can show it at once and say "Checking…"), then checkFlow.
// -> { binding } or, when the probe fails (nothing is bound then), { binding: null, error }.
export async function bindFlow(deps, { machine, repo, folders = [], requires = [], now = Date.now(), onBound }) {
  let host;
  try {
    host = await (deps.probe ?? probeMachine)(deps.exec, machine);
  } catch (e) {
    return { binding: null, error: String(e?.message ?? e) };
  }
  const bound = bindMachine(machine, host);
  if (!bound) return { binding: null, error: `Couldn't read ${machine}'s system or home folder.` };
  onBound?.(bound);
  return { binding: await checkFlow({ ...deps, seen: new Map([[machine, host]]) }, { binding: bound, repo, folders, requires, now }) };
}
