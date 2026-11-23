// `herdr-tasks device run`: run a command on the Test device against a commit, then clean up. Pure: every call to a machine goes
// through the exec passed in (the same exec runs/remote.js takes), so node --test drives it with a fake that records the calls.
//   exec(cmd, args, opts?) -> Promise<{ code, stdout, stderr }>; opts is { on, timeout (ms), cwd }.
// The steps, each one remote spawn (a Windows desktop spawn costs 4–24s, so there are only a handful):
//   resolve (local git) -> prepare (lock, sweep, "has base?") -> pack (local) -> send -> checkout -> run -> read -> cleanup.
// The run step is not one exec: Herdr caps every exec at 600s, so the command starts in a detached Herdr terminal on the device
// (`hc run --bg --on <machine>`, named herdr-test-<id>) and this computer waits for it in slices of 590s (`hc wait`, event-driven
// through the local core, no polling and nothing spawned on the device) until it exits or RUN_TIMEOUT_MS (1.5 hours) has passed.
// Nothing is pushed and no branch is made, here or there: the commit travels as a git bundle into a private ref,
// refs/herdr-test/<id>, which the cleanup deletes. The device is only ever named by its Herdr machine name (the binding's).

import { EXEC_CAP_MS, EXEC_CAP_S, RUN_TIMEOUT_MS, WAIT_GRACE_MS, WAIT_SLICE_S } from "../lib/index.js";
import { shArgv, shOn } from "../runs/index.js";
import { posixFolder, testRunBundle, testRunCode, testRunFolder, testRunId, testRunLockDir, testRunLog, testRunsDir } from "../workflow/index.js";

// How long the command may run (1.5 hours, lib/device-timeouts.js, where the CLI's wait is derived from it too): the run's own clock, as
// no exec lasts that long. Herdr caps each exec at 600s, which is all the send below may take (SEND_TIMEOUT_MS).
export { RUN_TIMEOUT_MS };
export const SEND_TIMEOUT_MS = EXEC_CAP_MS;
// A lost line to the device's terminal (a wait that fails or answers nothing sensible) is asked again this many times in a row.
export const WAIT_RETRIES = 3;
// The run's terminal on the device is named herdr-test-<id> (Herdr allows 1-32 of a-z 0-9 - _; an id is at most 14).
export const TERMINAL_PREFIX = "herdr-test-";
export const terminalName = (id) => `${TERMINAL_PREFIX}${id}`;
// The most orphaned herdr-test-* terminals one run looks at.
export const MAX_ORPHANS = 10;
// How long each other remote step may take: a desktop spawn costs 4–95s, and exec's own default of 30s would cut it short.
export const STEP_TIMEOUT_MS = 300000;
// A lock older than the run's cap plus five minutes belongs to a run that died: it is taken over (5700s).
export const STALE_LOCK_S = RUN_TIMEOUT_MS / 1000 + 300;
// What a crash leaves behind in test-runs/ is swept after a day.
export const SWEEP_AFTER_MIN = 24 * 60;
// Here, before packing: make the bundle folder and sweep the bundles a crash left in it (older than SWEEP_AFTER_MIN minutes: $2).
// Only herdr-test-*.bundle files, only directly in the folder. Never fails the run.
export const LOCAL_PREPARE = 'mkdir -p "$1" && find "$1" -maxdepth 1 -type f -name \'herdr-test-*.bundle\' -mmin "+$2" -exec rm -f {} + 2>/dev/null; true';
// What `timeout` and hc exec use for "ended by the time limit".
export const TIMED_OUT_CODE = 124;
// The most of a log that is read back (its end, where a failure is).
export const LOG_TAIL_BYTES = 4000000;

// Exit codes of `herdr-tasks device run` (cli/commands.js documents them all).
export const EXIT = { PASSED: 0, FAILED: 1, USAGE: 2, NOT_READY: 5, BUSY: 6 };

export const testRunRef = (id) => `refs/herdr-test/${id}`;

// A fresh run id: lowercase letters and digits only (workflow/places.js's testRunId accepts nothing else), time first so runs sort.
export const newTestRunId = (now = Date.now(), random = Math.random) => `r${now.toString(36)}${Math.floor(random() * 36 ** 4).toString(36).padStart(4, "0")}`;

// `key=value` lines a script prints, read through CRLF (Git Bash); the first of a key wins.
export function parseKeyValues(text) {
  const found = {};
  for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && /^[a-z_]+$/.test(line.slice(0, at)) && !(line.slice(0, at) in found)) found[line.slice(0, at)] = line.slice(at + 1);
  }
  return found;
}

// ---- the scripts (sh; run through Git Bash on Windows). Arguments are $1.., never spliced into the text. ----

// $1 test-runs folder, $2 lock folder, $3 repo folder, $4 run id, $5 base commit ("" for none), $6 stale lock seconds, $7 sweep minutes.
// Prints lock=ok|busy (+ holder=, since=), root=missing, took_over=<old holder>, base=1|0, and done=1 as its last line, so a cut-off
// answer is never read as a go. The lock is a mkdir (atomic) holding "<id> <start seconds>" in info.
export const PREPARE = [
  'd=$1; lock=$2; root=$3; id=$4; base=$5; stale=$6; sweep=$7',
  'git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || { echo root=missing; exit 0; }',
  'mkdir -p "$d" || { echo dir=failed; exit 0; }',
  'now=$(date +%s)',
  'if ! mkdir "$lock" 2>/dev/null; then',
  '  holder=; since=',
  '  [ -f "$lock/info" ] && read -r holder since < "$lock/info"',
  '  age=',
  '  case $since in ""|*[!0-9]*) ;; *) age=$((now - since)) ;; esac',
  '  if [ -z "$age" ]; then',
  '    if [ -n "$(find "$lock" -maxdepth 0 -mmin +$((stale / 60)) 2>/dev/null)" ]; then age=$((stale + 1)); else age=0; fi',
  '  fi',
  '  if [ "$age" -gt "$stale" ]; then',
  '    mv "$lock" "$lock.old$id" 2>/dev/null',
  '    mkdir "$lock" 2>/dev/null || { echo lock=busy; echo holder="$holder"; echo since="$since"; exit 0; }',
  '    rm -rf "$lock.old$id"',
  '    echo took_over="$holder"',
  '  else',
  '    echo lock=busy; echo holder="$holder"; echo since="$since"; exit 0',
  '  fi',
  'fi',
  'printf "%s %s\\n" "$id" "$now" > "$lock/info"',
  'echo lock=ok',
  'find "$d" -mindepth 1 -maxdepth 1 -mmin +"$sweep" ! -name .lock 2>/dev/null | while IFS= read -r e; do',
  '  n=${e##*/}',
  '  case $n in ""|*[!a-z0-9.]*) continue ;; esac',
  '  if [ -d "$e" ]; then git -C "$root" worktree remove --force "$e" >/dev/null 2>&1; rm -rf "$e"; else rm -f "$e"; fi',
  '  git -C "$root" update-ref -d "refs/herdr-test/${n%%.*}" >/dev/null 2>&1',
  'done',
  'git -C "$root" worktree prune >/dev/null 2>&1',
  'if [ -n "$base" ] && git -C "$root" cat-file -e "$base^{commit}" 2>/dev/null; then echo base=1; else echo base=0; fi',
  'echo done=1',
].join("\n");

// Runs on this computer: $1 machine, $2 local bundle, then the device's own sh argv (shArgv), which writes what comes in on its
// stdin to the bundle's place. A bundle is binary and Herdr's exec has no stdin, so hc does the piping, raw: no base64.
export const SEND = `m=$1; src=$2; shift 2; hc exec -i --on "$m" --timeout ${EXEC_CAP_S} -- "$@" < "$src"`;
// Runs on this computer: hc with the arguments given (start the run's terminal, wait on it, kill it, remove it, list, get). Through sh, as SEND is.
export const HC = 'hc "$@"';
export const WRITE_STDIN = 'cat > "$1"';

// $1 repo folder, $2 bundle, $3 private ref, $4 worktree folder, $5 commit. Exit 11 when the fetch fails, 12 when the worktree does.
export const CHECKOUT = [
  'git -C "$1" fetch --quiet "$2" "$3:$3" || exit 11',
  'git -C "$1" worktree add --quiet --detach "$4" "$5" || exit 12',
].join("\n");

// $1 worktree, $2 log, $3 code file, then the command: one argument is a shell command line (eval), more are an argv that is run
// as given. The exit status is written last, and not at all when the run is cut short, which is how a timeout is known.
export const RUN_LINE = 'w=$1; l=$2; c=$3; shift 3\n( cd "$w" && eval "$1" ) >"$l" 2>&1\nrc=$?\nprintf "%s\\n" "$rc" >"$c"';
export const RUN_ARGV = 'w=$1; l=$2; c=$3; shift 3\n( cd "$w" && "$@" ) >"$l" 2>&1\nrc=$?\nprintf "%s\\n" "$rc" >"$c"';

// $1 code file, $2 log, $3 tail bytes: "code=<n>" (or missing), then a line holding only ---, then the log.
export const READ_BACK = [
  'if [ -f "$1" ]; then printf "code=%s\\n" "$(tr -d "\\r\\n " < "$1")"; else echo code=missing; fi',
  'echo ---',
  'tail -c "$3" "$2" 2>/dev/null',
].join("\n");

// $1 repo folder, $2 worktree, $3 bundle, $4 log, $5 code, $6 private ref, $7 keep (1: keep worktree and log), $8 lock folder, $9 run id.
// Every step goes on after a failed one. The lock is released only when it is this run's.
export const CLEANUP = [
  'if [ "$7" != 1 ]; then git -C "$1" worktree remove --force "$2" >/dev/null 2>&1; rm -rf "$2"; rm -f "$4"; fi',
  'git -C "$1" worktree prune >/dev/null 2>&1',
  'git -C "$1" update-ref -d "$6" >/dev/null 2>&1',
  'rm -f "$3" "$5"',
  'if [ -f "$8/info" ] && [ "$(cut -d" " -f1 "$8/info")" = "$9" ]; then rm -rf "$8"; fi',
  'echo done=1',
].join("\n");

// The run's command as sh arguments after $3: its script and arguments.
export const runScript = (command) => (command.length === 1 ? RUN_LINE : RUN_ARGV);

// What the read-back printed: { code: number | null (missing), log }. Throws on an answer with no header (cut off).
export function parseReadBack(stdout) {
  const text = String(stdout ?? "").replace(/\r\n/g, "\n");
  const at = text.indexOf("\n---\n");
  if (at < 0 || !text.startsWith("code=")) throw new Error("the device's answer to reading the run back was cut off");
  const code = text.slice("code=".length, at);
  return { code: /^-?\d+$/.test(code) ? Number(code) : null, log: text.slice(at + "\n---\n".length) };
}

// The result, and the exit status it maps to: 0 when the command passed, 1 when it failed or timed out.
export const exitFor = (result) => (result.exitCode === 0 && !result.timedOut ? EXIT.PASSED : EXIT.FAILED);

// A lock's start (seconds since the epoch, as the device's date said) as a time; "an unknown time" when it isn't a number.
export const sinceText = (since) => (/^\d+$/.test(String(since ?? "")) ? new Date(Number(since) * 1000).toISOString().replace(/\.\d+Z$/, "Z") : "an unknown time");

// Can the run start at all? null, or { code, message } for the first thing in the way: no binding, no repo folder, a red cheap light.
// Nothing is made and no machine is asked before this says null.
//   binding: the normalized binding ({ machine, os, home, repoRoots }) or null; cheap: { level, message? } (devices/test-device.js).
export function readiness({ repo, binding, cheap, command }) {
  if (!Array.isArray(command) || !command.length || command.some((a) => typeof a !== "string") || !command[0]) {
    return { code: EXIT.USAGE, message: "device run needs a command after --." };
  }
  if (!binding?.machine) return { code: EXIT.NOT_READY, message: "No test device is bound. Pick a machine in Task settings." };
  const machine = binding.machine;
  if (!posixFolder(binding.home) || !["unix", "windows"].includes(binding.os)) {
    return { code: EXIT.NOT_READY, message: `The test device ${machine} has no recorded OS or home folder: unbind it and bind it again.` };
  }
  if (!repo || !binding.repoRoots?.[repo]) {
    return { code: EXIT.NOT_READY, message: `No repo folder on ${machine} for ${repo || "this repo"}. Set it in Task settings (Test device).` };
  }
  if (cheap?.level === "red") {
    return { code: EXIT.NOT_READY, message: `The test device ${machine} is red${cheap.message ? `: ${cheap.message}` : "."}` };
  }
  return null;
}

// The run's terminal address from what `hc run --bg --json --on <machine>` printed ({ address: "machine/t7", ... }); a bare "t7" gets the
// machine in front of it. null for anything that isn't an address (never one that could be read as an option).
export function terminalAddress(stdout, machine) {
  let got = null;
  try { got = JSON.parse(stdout); } catch { return null; }
  const a = typeof got?.address === "string" ? got.address.trim() : "";
  const full = a && !a.includes("/") ? `${machine}/${a}` : a;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[a-z0-9]+$/.test(full) ? full : null;
}

// How a finished terminal's `hc wait --json` answer reads, for a message: "exit code 3" / "killed" / "".
export const exitedAs = (got) => [got?.exit_code != null ? `exit code ${got.exit_code}` : "", got?.signal ? `signal ${got.signal}` : "", got?.reason && got.reason !== "timeout" ? String(got.reason) : ""].filter(Boolean).join(", ");

class Step extends Error {
  constructor(code, message) { super(message); this.exitCode = code; }
}

const said = (r) => String(r?.stderr || r?.stdout || "").trim().split("\n").slice(-3).join(" ").trim();
const gitHere = (exec, cwd) => (...args) => exec("git", ["-C", cwd, ...args], {});

// Runs a command on the test device against a commit. Never rejects; the cleanup runs on both sides whatever happens.
//   deps: { exec, now = Date.now, random = Math.random }
//   input: { repo, binding, cheap, cwd (a folder of the repo on this computer), commit = "HEAD", keep = false, command: [string],
//            tmpDir (a folder here for the local bundle: made if missing; the handler gives one under this computer's .herdr, as the
//            mod has no os.tmpdir, and nothing hard-codes /tmp) }
// -> { code, result?, message?, notes: [stderr lines], kept?: { worktree, log } } where result is
//    { device, commit, exitCode, log, durationMs, timedOut }; `code` is the process exit status (0, 1, 2, 5 or 6).
export async function runOnDevice(deps, input) {
  const { exec, now = Date.now, random = Math.random } = deps;
  const notes = [];
  const blocked = readiness(input);
  if (blocked) return { ...blocked, notes };

  const { binding, cwd, command, keep = false, tmpDir } = input;
  if (!tmpDir) return { code: EXIT.USAGE, message: "device run needs a folder here for the bundle (tmpDir).", notes };
  const machine = binding.machine;
  const home = posixFolder(binding.home);
  const root = binding.repoRoots[input.repo];
  const id = testRunId(newTestRunId(now(), random));
  const dir = testRunsDir(home), lockDir = testRunLockDir(home), folder = testRunFolder(home, id);
  const bundle = testRunBundle(home, id), log = testRunLog(home, id), codeFile = testRunCode(home, id);
  const ref = testRunRef(id);
  const localBundle = `${posixFolder(tmpDir)}/herdr-test-${id}.bundle`;
  // The device's host is known from the binding (probed once when it was bound), so no probe is made here.
  const remote = { exec, seen: new Map([[machine, { on: machine, os: binding.os, home }]]) };
  const local = { exec };
  const sh = (script, args = [], opts = { timeout: STEP_TIMEOUT_MS }) => shOn(remote, machine, script, args, opts);
  const here = gitHere(exec, cwd);

  // The run's terminal: `started` once hc run was asked, `address` when its answer gave one, `ended` once it is known to have exited or been killed.
  // hc kill / hc rm of the run's terminal. Never throws; "it's gone already" is expected (a run that finished) and says nothing.
  const endTerminal = async (target, what) => {
    const r = await hcHere([what, target]);
    if (r.code !== 0 && !/no such|not found|unknown|finished|exited|not running|already|gone/i.test(`${r.stderr}${r.stdout}`)) notes.push(`Cleanup: couldn't ${what} the terminal ${target} (${said(r)}).`);
  };
  let refMade = false, touched = false, started = false, address = null, ended = false;
  const hcHere = (args, timeout = STEP_TIMEOUT_MS) => shOn(local, null, HC, args, { timeout }).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  try {
    // 1. resolve, here: the commit (and whether the tree is dirty) and what the device may already have.
    const rev = input.commit || "HEAD";
    if (rev.startsWith("-")) throw new Step(EXIT.USAGE, `Not a commit: ${rev}.`); // never an option to git
    const found = await here("rev-parse", "--verify", "--quiet", `${rev}^{commit}`).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    const commit = String(found.stdout ?? "").trim();
    if (found.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw new Step(EXIT.USAGE, `Can't find commit ${rev} in ${cwd}.`);
    const dirty = await here("status", "--porcelain").catch(() => ({ stdout: "" }));
    if (String(dirty.stdout ?? "").trim()) notes.push(`Uncommitted changes aren't sent: running ${commit.slice(0, 12)} as committed.`);
    const base = await baseCommit(here);

    // 2. prepare, there: the lock, the sweep of what a crash left, and whether the device has the base.
    touched = true;
    const prep = await sh(PREPARE, [dir, lockDir, root, id, base ?? "", String(STALE_LOCK_S), String(SWEEP_AFTER_MIN)]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
    const state = parseKeyValues(prep.stdout);
    if (state.root === "missing") { touched = false; throw new Step(EXIT.NOT_READY, `${root} on ${machine} isn't a git repo. Fix the repo folder in Task settings.`); }
    if (state.dir === "failed") { touched = false; throw new Step(EXIT.NOT_READY, `Couldn't make ${dir} on ${machine}.`); }
    if (prep.code !== 0 || !state.lock || (state.lock === "ok" && state.done !== "1")) throw new Step(EXIT.NOT_READY, `Couldn't reach ${machine}: ${prep.code !== 0 ? said(prep) : ""}${prep.code !== 0 && said(prep) ? "" : "its answer was cut off"}.`);
    if (state.lock !== "ok") {
      touched = false; // somebody else's lock: not ours to clean up
      throw new Step(EXIT.BUSY, `busy: run ${state.holder || "?"} since ${sinceText(state.since)}`);
    }
    if (state.took_over) notes.push(`Took over a stale lock from run ${state.took_over}.`);
    await sweepTerminals({ hcHere, machine, own: terminalName(id), now: now() }); // the lock is ours: what a crash left running is stale

    // 3. pack, here: a private ref at the commit, bundled thin against the base when the device has it, else whole.
    await shOn(local, null, LOCAL_PREPARE, [posixFolder(tmpDir), String(SWEEP_AFTER_MIN)]).catch(() => {}); // a missing folder shows as the bundle failing below
    const made = await here("update-ref", ref, commit);
    if (made.code !== 0) throw new Step(EXIT.USAGE, `Couldn't make ${ref} here: ${said(made)}`);
    refMade = true;
    let packed = base && state.base === "1"
      ? await here("bundle", "create", localBundle, ref, `^${base}`)
      : { code: 1 };
    if (packed.code !== 0) packed = await here("bundle", "create", localBundle, ref); // no base, the device lacks it, or nothing is new
    if (packed.code !== 0) throw new Step(EXIT.USAGE, `Couldn't bundle ${commit.slice(0, 12)}: ${said(packed)}`);

    // 4. send, raw: hc pipes the bundle into `cat` on the device.
    const [cmd, args] = shArgv(binding.os, WRITE_STDIN, [bundle]);
    const sentR = await shOn(local, null, SEND, [machine, localBundle, cmd, ...args], { timeout: SEND_TIMEOUT_MS }).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
    if (sentR.code !== 0) throw new Step(EXIT.NOT_READY, `Couldn't send the bundle to ${machine}: ${said(sentR)}`);

    // 5. check out, there: fetch into the private ref and add a detached worktree.
    const checked = await sh(CHECKOUT, [root, bundle, ref, folder, commit]);
    if (checked.code !== 0) throw new Step(EXIT.NOT_READY, `Couldn't check ${commit.slice(0, 12)} out on ${machine}: ${said(checked) || `git exited ${checked.code}`}`);

    // 6. run, there, in a detached Herdr terminal (no exec lasts longer than 600s), then wait for it in slices on this computer.
    const t0 = now();
    started = true;
    const [runCmd, runArgs] = shArgv(binding.os, runScript(command), [folder, log, codeFile, ...command]);
    const began = await hcHere(["run", "--bg", "--json", "--on", machine, "--name", terminalName(id), "--cwd", folder, "--no-parent", "--no-notify", "--", runCmd, ...runArgs]);
    address = terminalAddress(began.stdout, machine);
    if (began.code !== 0 || !address) throw new Step(EXIT.NOT_READY, `Couldn't start the command on ${machine}: ${said(began) || "hc run named no terminal"}.`);
    const waited = await waitForRun({ hcHere, address, now, t0 });
    if (waited.lost) throw new Step(EXIT.NOT_READY, `Lost the run on ${machine} (${address}): ${waited.lost}.`);
    ended = true;
    if (waited.capped) await endTerminal(address, "kill"); // the cap: the run's own, not Herdr's. Cleanup below still runs.
    const durationMs = Math.max(0, now() - t0);

    // 7. read back. Only a run this computer ended at the cap makes a timeout; no exit status otherwise is a lost run.
    const cut = waited.capped;
    let back;
    try {
      const read = await sh(READ_BACK, [codeFile, log, String(LOG_TAIL_BYTES)]);
      if (read.code !== 0) throw new Error(`Couldn't read the run back from ${machine}: ${said(read)}`);
      back = parseReadBack(read.stdout);
    } catch (e) {
      if (!cut) throw new Step(EXIT.NOT_READY, String(e?.message ?? e));
      notes.push(`${String(e?.message ?? e)} (the run had timed out).`); // still a timeout: exit 1, with no log
      back = { code: null, log: "" };
    }
    if (back.code === null && !cut) throw new Step(EXIT.NOT_READY, `The run on ${machine} ended without an exit status: ${exitedAs(waited.got) || "no answer from the device"}.`);
    const timedOut = back.code === null;
    if (timedOut) notes.push(`The command didn't finish in ${RUN_TIMEOUT_MS / 1000}s, so its terminal was ended.`);
    const result = { device: machine, commit, exitCode: timedOut ? TIMED_OUT_CODE : back.code, log: back.log, durationMs, timedOut };
    return { code: exitFor(result), result, notes, ...(keep ? { kept: { worktree: folder, log } } : {}) };
  } catch (e) {
    return { code: e instanceof Step ? e.exitCode : EXIT.NOT_READY, message: e instanceof Step ? e.message : String(e?.message ?? e), notes };
  } finally {
    // Cleanup, both sides, whatever happened. A cleanup that fails is a note, never a change of the result.
    const warn = (what, e) => notes.push(`Cleanup: ${what}${e ? ` (${String(e?.message ?? e)})` : ""}.`);
    // The terminal first, so nothing holds the worktree: killed unless it is known to be over, then removed. A run whose start was
    // asked but named no terminal is looked for by its name.
    const target = address ?? (started ? `${machine}/${terminalName(id)}` : null);
    if (target && !ended) await endTerminal(target, "kill");
    if (target) await endTerminal(target, "rm");
    if (refMade) await here("update-ref", "-d", ref).then((r) => { if (r.code !== 0) warn(`couldn't delete ${ref} here`, said(r)); }, (e) => warn(`couldn't delete ${ref} here`, e));
    if (touched) {
      await sh(CLEANUP, [root, folder, bundle, log, codeFile, ref, keep ? "1" : "0", lockDir, id])
        .then((r) => { if (r.code !== 0) warn(`the device's cleanup exited ${r.code}`, said(r)); }, (e) => warn(`couldn't clean up on ${machine}`, e));
    }
    if (refMade) await shOn(local, null, 'rm -f "$1"', [localBundle]).catch(() => {});
  }
}

// Waits for the run's terminal, here: `hc wait <machine>/<t> --json --timeout <WAIT_SLICE_S>` in a row (each its own exec, at most
// the 600s cap), until it has exited or RUN_TIMEOUT_MS has passed since t0. The wait is the local core's own, event-driven: a slice
// that ends with the terminal still running is only the wait checking in, and nothing is spawned on the device or slept on.
//   -> { ended: true, got } | { capped: true } | { lost: reason }. A wait that fails, or answers nothing readable, or answers "not over"
//   for a reason other than its own timeout (which would spin), is asked again WAIT_RETRIES times in a row, then the run is lost.
export async function waitForRun({ hcHere, address, now, t0 }) {
  let bad = 0, why = "";
  for (;;) {
    const left = RUN_TIMEOUT_MS - (now() - t0);
    if (left < 1000) return { capped: true };
    const slice = Math.min(WAIT_SLICE_S, Math.floor(left / 1000));
    const r = await hcHere(["wait", address, "--json", "--timeout", String(slice)], slice * 1000 + WAIT_GRACE_MS);
    let got = null;
    try { got = JSON.parse(r.stdout); } catch { got = null; }
    if (r.code === 0 && got && typeof got === "object") {
      if (got.ended === true || got.exit_code != null) return { ended: true, got };
      if (got.reason === "timeout") { bad = 0; continue; } // the slice ran out; the terminal is still running
      why = `the wait answered "${got.reason ?? "nothing"}" while the terminal was still running`;
    } else {
      why = said(r) || (r.code === 0 ? "its answer wasn't readable" : `hc wait exited ${r.code}`);
    }
    if (++bad >= WAIT_RETRIES) return { lost: why };
  }
}

// What a crash leaves: herdr-test-* terminals of this machine older than the stale-lock age (the run holds the lock, so none is live).
// `hc ls --json` and `hc get` are the local core's; nothing runs on the device. Best effort: it never fails the run.
async function sweepTerminals({ hcHere, machine, own, now }) {
  try {
    const listed = await hcHere(["ls", "--json"]);
    const terminals = JSON.parse(listed.stdout)?.terminals;
    const old = (Array.isArray(terminals) ? terminals : [])
      .filter((t) => typeof t?.name === "string" && t.name.startsWith(TERMINAL_PREFIX) && t.name !== own && t.state === "live" && String(t.address).startsWith(`${machine}/`))
      .slice(0, MAX_ORPHANS);
    for (const t of old) {
      const got = await hcHere(["get", t.address, "--json"]);
      const made = Number(JSON.parse(got.stdout)?.created_ms);
      if (!Number.isFinite(made) || now - made <= STALE_LOCK_S * 1000) continue;
      await hcHere(["kill", t.address]);
      await hcHere(["rm", t.address]);
    }
  } catch { /* nothing to sweep, or no answer: the next run tries again */ }
}

// The commit the device most likely has: origin's default branch here. null when there is no origin.
async function baseCommit(here) {
  const head = await here("symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => ({ code: 1 }));
  const names = [head.code === 0 ? String(head.stdout).trim() : "", "origin/main", "origin/master"].filter(Boolean);
  for (const name of names) {
    const r = await here("rev-parse", "--verify", "--quiet", `${name}^{commit}`).catch(() => ({ code: 1 }));
    if (r.code === 0 && /^[0-9a-f]{40,64}$/.test(String(r.stdout).trim())) return String(r.stdout).trim();
  }
  return null;
}
