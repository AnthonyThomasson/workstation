import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  CLEANUP, CHECKOUT, EXIT, HC, LOCAL_PREPARE, MAX_ORPHANS, PREPARE, READ_BACK, RUN_ARGV, RUN_LINE, RUN_TIMEOUT_MS, SEND, SEND_TIMEOUT_MS, STALE_LOCK_S, STEP_TIMEOUT_MS, SWEEP_AFTER_MIN, TERMINAL_PREFIX, TIMED_OUT_CODE, WAIT_RETRIES,
  exitFor, exitedAs, newTestRunId, parseKeyValues, parseReadBack, readiness, runOnDevice, sinceText, terminalAddress, terminalName, testRunRef, waitForRun,
} from "./test-run.js";
import { EXEC_CAP_MS, WAIT_GRACE_MS, WAIT_SLICE_S } from "../lib/index.js";
import { GIT_BASH } from "../runs/index.js";
import { testRunId } from "../workflow/index.js";

const SHA = "a".repeat(40), BASE = "b".repeat(40);
const REPO = "me/app";
const unixBinding = { machine: "desktop", os: "unix", home: "/home/me", repoRoots: { [REPO]: "/home/me/app" } };
const winBinding = { machine: "desktop", os: "windows", home: "C:/Users/me", repoRoots: { [REPO]: "C:/Users/me/code/app" } };
const green = { level: "green" };
const input = (extra = {}) => ({ repo: REPO, binding: unixBinding, cheap: green, cwd: "/work/app", commit: "HEAD", command: ["npm", "test"], tmpDir: "/tmp/x", ...extra });

// Which step a call is, by what it runs.
function stepOf({ cmd, args }) {
  if (cmd === "git") {
    const g = args.slice(2);
    if (g[0] === "bundle") return "pack";
    if (g[0] === "update-ref") return g[1] === "-d" ? "unref" : "ref";
    if (g[0] === "rev-parse" || g[0] === "symbolic-ref") return "resolve";
    if (g[0] === "status") return "status";
    return `git ${g[0]}`;
  }
  const script = args[1];
  if (script === HC) return { run: "start", wait: "wait", kill: "kill", rm: "rm", ls: "ls", get: "get" }[args[3]] ?? `hc ${args[3]}`;
  if (script === PREPARE) return "prepare";
  if (script === SEND) return "send";
  if (script === CHECKOUT) return "checkout";
  if (script === READ_BACK) return "read";
  if (script === CLEANUP) return "cleanup";
  if (script === 'rm -f "$1"') return "rm-local";
  if (script === LOCAL_PREPARE) return "mkdir-local";
  return `other ${cmd}`;
}

// A fake world: every call is recorded; `at` maps a step to its answer (a function of the call, or a value; throw to simulate a spawn failing).
function world(at = {}) {
  const calls = [];
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const defaults = {
    resolve: (c) => (c.args.includes("symbolic-ref") ? ok("origin/main\n") : c.args.some((a) => /^origin\/main\^/.test(a)) ? ok(`${BASE}\n`) : ok(`${SHA}\n`)),
    status: () => ok(""),
    prepare: () => ok("lock=ok\nbase=1\ndone=1\n"),
    ref: () => ok(), unref: () => ok(), pack: () => ok(), send: () => ok(), checkout: () => ok(),
    ls: () => ok('{"machines":[],"terminals":[]}'),
    start: () => ok('{"address":"desktop/t9","name":"herdr-test"}'),
    wait: () => ok('{"ended":true,"exit_code":0,"reason":"exit","terminal":"desktop/t9"}'),
    kill: () => ok(), rm: () => ok(),
    read: () => ok("code=0\n---\nall green\n"),
    cleanup: () => ok("done=1\n"),
    "rm-local": () => ok(), "mkdir-local": () => ok(),
  };
  const exec = async (cmd, args, opts) => {
    const call = { cmd, args, opts, step: null };
    call.step = stepOf(call);
    calls.push(call);
    const answer = call.step in at ? at[call.step] : defaults[call.step];
    const r = typeof answer === "function" ? answer(call, calls) : answer;
    return r ?? { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls, steps: () => calls.map((c) => c.step) };
}
const run = (w, extra = {}, deps = {}) => runOnDevice({ exec: w.exec, now: (() => { let t = 1_000_000; return () => (t += 500); })(), random: () => 0.5, ...deps }, input(extra));
// A clock that only the test moves, for runs that last longer than the real one would: advance(ms).
const clock = (start = 10_000_000) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };
const waitJson = (extra) => ({ code: 0, stdout: JSON.stringify({ ended: false, exit_code: null, reason: "timeout", terminal: "desktop/t9", ...extra }), stderr: "" });
const hcArgs = (c) => c.args.slice(3); // what hc was given: sh -c <script> github-tasks <args>

// ---------------------------------------------------------------- fail fast

test("no binding, no repo folder, a red light or no command stop the run before any call", async () => {
  const cases = [
    [{ binding: null }, EXIT.NOT_READY, /No test device is bound/],
    [{ binding: { ...unixBinding, repoRoots: {} } }, EXIT.NOT_READY, /No repo folder on desktop for me\/app/],
    [{ binding: { ...unixBinding, repoRoots: { "other/repo": "/x" } } }, EXIT.NOT_READY, /No repo folder/],
    [{ cheap: { level: "red", message: "`desktop` isn't connected" } }, EXIT.NOT_READY, /desktop is red: `desktop` isn't connected/],
    [{ binding: { ...unixBinding, home: "" } }, EXIT.NOT_READY, /no recorded OS or home/],
    [{ binding: { ...unixBinding, os: "plan9" } }, EXIT.NOT_READY, /no recorded OS or home/],
    [{ command: [] }, EXIT.USAGE, /needs a command/],
    [{ command: [""] }, EXIT.USAGE, /needs a command/],
  ];
  for (const [extra, code, message] of cases) {
    const w = world();
    const r = await run(w, extra);
    assert.equal(r.code, code, JSON.stringify(extra));
    assert.match(r.message, message);
    assert.equal(w.calls.length, 0, `no call for ${JSON.stringify(extra)}`);
    assert.equal(r.result, undefined);
  }
});

test("yellow, or no cheap light yet, still runs: only red stops", async () => {
  for (const cheap of [{ level: "yellow", message: "Not checked yet" }, undefined]) {
    const r = await run(world(), { cheap });
    assert.equal(r.code, 0);
  }
});

test("a commit that can't be resolved is a usage error, found before the device is asked", async () => {
  const w = world({ resolve: () => ({ code: 1, stdout: "", stderr: "" }) });
  const r = await run(w, { commit: "nope" });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.message, /Can't find commit nope in \/work\/app/);
  assert.deepEqual(w.steps().filter((s) => !["resolve"].includes(s)), []);
});

// ---------------------------------------------------------------- the happy path

test("the steps run in order: pack, send, checkout, start, wait, read, cleanup (prepare first, then the local tidy)", async () => {
  const w = world();
  const r = await run(w);
  assert.equal(r.code, 0);
  assert.deepEqual(w.steps(), ["resolve", "status", "resolve", "resolve", "prepare", "ls", "mkdir-local", "ref", "pack", "send", "checkout", "start", "wait", "read", "rm", "unref", "cleanup", "rm-local"]);
  assert.equal(r.result.device, "desktop");
  assert.equal(r.result.commit, SHA);
  assert.equal(r.result.exitCode, 0);
  assert.equal(r.result.log, "all green\n");
  assert.equal(r.result.timedOut, false);
  assert.ok(r.result.durationMs > 0);
  assert.deepEqual(Object.keys(r.result).sort(), ["commit", "device", "durationMs", "exitCode", "log", "timedOut"]);
});

test("only the remote steps are spawns on the device: a handful, and the run itself, its waits and its terminal's end are none", async () => {
  const w = world();
  await run(w);
  const remote = w.calls.filter((c) => c.opts?.on === "desktop").map((c) => c.step);
  assert.deepEqual(remote, ["prepare", "checkout", "read", "cleanup"]);
  for (const step of ["send", "start", "wait", "rm", "ls"]) {
    assert.ok(w.calls.filter((c) => c.step === step).every((c) => !c.opts?.on && c.cmd === "sh"), `${step} is run here, through sh, never on the device`);
  }
});

test("the commit resolves as given, defaulting to HEAD, and a dirty tree is reported, not sent", async () => {
  const w = world({ status: () => ({ code: 0, stdout: " M src/a.js\n?? b.txt\n", stderr: "" }) });
  const r = await run(w, { commit: undefined });
  assert.deepEqual(w.calls[0].args, ["-C", "/work/app", "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  assert.match(r.notes.join("\n"), /Uncommitted changes aren't sent: running aaaaaaaaaaaa as committed/);
  const w2 = world();
  await run(w2, { commit: "v1.2^2" });
  assert.equal(w2.calls[0].args[5], "v1.2^2^{commit}");
  assert.deepEqual((await run(world())).notes, [], "a clean tree says nothing");
});

test("the bundle is thin against origin's default when the device has it, else whole, and a thin one that fails is made whole", async () => {
  const bundleArgs = (w) => w.calls.find((c) => c.step === "pack").args.slice(2);
  let w = world();
  await run(w);
  const thin = bundleArgs(w);
  assert.equal(thin[0], "bundle"); assert.equal(thin[1], "create");
  assert.match(thin[2], /^\/tmp\/x\/herdr-test-r[a-z0-9]+\.bundle$/);
  assert.match(thin[3], /^refs\/herdr-test\/r[a-z0-9]+$/);
  assert.equal(thin[4], `^${BASE}`);

  w = world({ prepare: () => ({ code: 0, stdout: "lock=ok\nbase=0\ndone=1\n", stderr: "" }) });
  await run(w);
  assert.equal(bundleArgs(w).length, 4, "the device lacks the base: a whole bundle");
  assert.ok(!w.calls.some((c) => c.args.includes(`^${BASE}`)));

  w = world({ resolve: (c) => (c.args.includes("symbolic-ref") || c.args.some((a) => /origin\//.test(a)) ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: `${SHA}\n`, stderr: "" }) });
  await run(w);
  assert.equal(w.calls.filter((c) => c.step === "pack").length, 1);
  assert.equal(bundleArgs(w).length, 4, "no origin here: a whole bundle");

  let n = 0;
  w = world({ pack: () => (++n === 1 ? { code: 128, stdout: "", stderr: "empty bundle" } : { code: 0, stdout: "", stderr: "" }) });
  const r = await run(w);
  assert.equal(r.code, 0);
  const packs = w.calls.filter((c) => c.step === "pack");
  assert.equal(packs.length, 2);
  assert.equal(packs[0].args.at(-1), `^${BASE}`);
  assert.ok(!packs[1].args.some((a) => a.startsWith("^")));
});

test("the send is hc's raw stdin into cat on the device, run by the local sh, with the exec cap as its timeout", async () => {
  const w = world();
  await run(w);
  const send = w.calls.find((c) => c.step === "send");
  assert.equal(send.cmd, "sh");
  assert.equal(send.args[0], "-c");
  assert.match(send.args[1], /hc exec -i --on "\$m" --timeout 600 -- "\$@" < "\$src"/);
  assert.equal(send.opts.timeout, SEND_TIMEOUT_MS);
  assert.equal(send.opts.on, undefined, "run here, never `on`");
  const [machine, local, cmd, ...rest] = send.args.slice(3);
  assert.equal(machine, "desktop");
  assert.match(local, /^\/tmp\/x\/herdr-test-r\w+\.bundle$/);
  assert.equal(cmd, "sh");
  assert.deepEqual(rest.slice(0, 2), ["-c", 'cat > "$1"']);
  assert.match(rest.at(-1), /^\/home\/me\/\.herdr\/test-runs\/r\w+\.bundle$/);
  assert.doesNotMatch(send.args[1], /base64/);
});

test("the local bundle goes in the tmpDir the caller gives, made first, never a hard-coded /tmp", async () => {
  const w = world();
  await run(w, { tmpDir: "/Users/me/.herdr/test-runs" });
  const mk = w.calls.find((c) => c.step === "mkdir-local");
  assert.equal(mk.args.at(-2), "/Users/me/.herdr/test-runs");
  assert.ok(w.calls.indexOf(mk) < w.calls.findIndex((c) => c.step === "pack"), "made before the bundle");
  const bundles = w.calls.filter((c) => c.step === "pack").map((c) => c.args.find((a) => a.endsWith(".bundle")));
  assert.ok(bundles.length && bundles.every((b) => /^\/Users\/me\/\.herdr\/test-runs\/herdr-test-r\w+\.bundle$/.test(b)), bundles.join());
  assert.ok(!w.calls.some((c) => c.args.some((a) => String(a).startsWith("/tmp/"))), "no /tmp anywhere");
});

test("the local prepare makes the folder and sweeps only old herdr-test bundles directly in it", () => {
  const dir = mkdtempSync(join(tmpdir(), "local-sweep-"));
  try {
    const folder = join(dir, "made", "later");
    const old = (name) => { const f = join(folder, name); writeFileSync(f, "x"); const t = new Date(Date.now() - (SWEEP_AFTER_MIN + 60) * 60000); utimesSync(f, t, t); };
    mkdirSync(folder, { recursive: true });
    old("herdr-test-rold.bundle"); old("keep-me.bundle"); old("herdr-test-note.txt");
    writeFileSync(join(folder, "herdr-test-rnew.bundle"), "x"); // young: a run may be using it
    mkdirSync(join(folder, "sub")); writeFileSync(join(folder, "sub", "herdr-test-rsub.bundle"), "x");
    const t = new Date(Date.now() - (SWEEP_AFTER_MIN + 60) * 60000); utimesSync(join(folder, "sub", "herdr-test-rsub.bundle"), t, t);
    const r = spawnSync("sh", ["-c", LOCAL_PREPARE, "sh", folder, String(SWEEP_AFTER_MIN)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(folder).sort(), ["herdr-test-note.txt", "herdr-test-rnew.bundle", "keep-me.bundle", "sub"]);
    assert.ok(existsSync(join(folder, "sub", "herdr-test-rsub.bundle")), "never below the folder");
    const fresh = join(dir, "not", "there");
    assert.equal(spawnSync("sh", ["-c", LOCAL_PREPARE, "sh", fresh, "1440"]).status, 0);
    assert.ok(existsSync(fresh), "the folder is made");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the run's local prepare is given the folder and the sweep age", async () => {
  const w = world();
  await run(w, { tmpDir: "/Users/me/.herdr/test-runs" });
  assert.deepEqual(w.calls.find((c) => c.step === "mkdir-local").args.slice(-2), ["/Users/me/.herdr/test-runs", String(SWEEP_AFTER_MIN)]);
});

test("without a tmpDir the run stops before packing instead of falling back to /tmp", async () => {
  const w = world();
  const r = await run(w, { tmpDir: undefined });
  assert.notEqual(r.code, 0);
  assert.ok(!w.calls.some((c) => c.step === "pack" || c.step === "send"));
  assert.ok(!w.calls.some((c) => c.args.some((a) => String(a).startsWith("/tmp/"))));
});

test("on Windows every remote script goes through Git Bash -lc, on Unix through sh -c", async () => {
  for (const [binding, shell, flag] of [[winBinding, GIT_BASH, "-lc"], [unixBinding, "sh", "-c"]]) {
    const w = world();
    await run(w, { binding });
    for (const c of w.calls.filter((x) => ["prepare", "checkout", "read", "cleanup"].includes(x.step))) {
      assert.equal(c.cmd, shell, c.step);
      assert.equal(c.args[0], flag, c.step);
      assert.equal(c.opts.on, "desktop");
    }
    const start = hcArgs(w.calls.find((x) => x.step === "start"));
    assert.deepEqual(start.slice(start.indexOf("--") + 1, start.indexOf("--") + 3), [shell, flag], "the terminal runs the command under the device's own shell");
    const send = w.calls.find((c) => c.step === "send");
    assert.equal(send.args[5], shell, "the device's own shell is what cat runs under");
    assert.equal(send.args[6], flag);
    const prep = w.calls.find((c) => c.step === "prepare");
    assert.equal(prep.args[3], `${binding.home}/.herdr/test-runs`);
    assert.equal(prep.args[4], `${binding.home}/.herdr/test-runs/.lock`);
  }
});

test("every remote step has an explicit timeout above exec's 30s default, and none passes Herdr's 600s exec cap", async () => {
  const w = world();
  await run(w);
  for (const c of w.calls.filter((x) => ["prepare", "checkout", "read", "cleanup"].includes(x.step))) assert.equal(c.opts.timeout, STEP_TIMEOUT_MS, c.step);
  assert.ok(STEP_TIMEOUT_MS > 30000 && STEP_TIMEOUT_MS <= EXEC_CAP_MS);
  assert.equal(w.calls.find((x) => x.step === "send").opts.timeout, SEND_TIMEOUT_MS);
  assert.equal(SEND_TIMEOUT_MS, 600000, "the send keeps the exec cap of its own: it is not the run's 1.5 hours");
  assert.ok(RUN_TIMEOUT_MS > EXEC_CAP_MS && SEND_TIMEOUT_MS !== RUN_TIMEOUT_MS);
  assert.match(SEND, /--timeout 600 /);
  for (const c of w.calls) if (c.opts?.timeout) assert.ok(c.opts.timeout <= EXEC_CAP_MS, `${c.step} asks ${c.opts.timeout}ms, past the exec cap`);
});

test("the host comes from the binding: no probe is ever made", async () => {
  const w = world();
  await run(w, { binding: winBinding });
  assert.ok(!w.calls.some((c) => c.args.some((a) => /uname/.test(String(a)))));
});

// `hc run --bg --json --on <m> --name herdr-test-<id> --cwd <worktree> --no-parent --no-notify -- <shell> <flag> <script> github-tasks <worktree> <log> <code> <command...>`
const startOf = (w) => {
  const a = hcArgs(w.calls.find((x) => x.step === "start"));
  const at = a.indexOf("--");
  return { before: a.slice(0, at), device: a.slice(at + 1) };
};

test("the command starts in a detached Herdr terminal on the device: hc run --bg, named for the run, no parent, no notes; the exit status goes to the code file", async () => {
  const w = world();
  await run(w, { command: ["npm test && echo done"] });
  const { before, device } = startOf(w);
  const name = before[before.indexOf("--name") + 1];
  assert.match(name, /^herdr-test-r[a-z0-9]+$/);
  assert.deepEqual(before.slice(0, 4), ["run", "--bg", "--json", "--on"]);
  assert.equal(before[4], "desktop");
  assert.equal(before[before.indexOf("--cwd") + 1], `/home/me/.herdr/test-runs/${name.slice(TERMINAL_PREFIX.length)}`, "the worktree");
  assert.ok(before.includes("--no-parent") && before.includes("--no-notify"));
  assert.ok(!before.includes("--rm"), "removed by the run, once it is read");
  assert.deepEqual(device.slice(0, 3), ["sh", "-c", RUN_LINE]);
  assert.deepEqual(device.slice(3, 4), ["github-tasks"]);
  const [folder, log, code, ...cmd] = device.slice(4);
  assert.match(folder, /^\/home\/me\/\.herdr\/test-runs\/r\w+$/);
  assert.equal(log, `${folder}.log`); assert.equal(code, `${folder}.code`);
  assert.deepEqual(cmd, ["npm test && echo done"], "one argument is a shell line");
  assert.equal(w.calls.find((x) => x.step === "start").opts.timeout, STEP_TIMEOUT_MS);

  const w2 = world();
  await run(w2, { command: ["git", "log", "-1", "--format=%H"] });
  const s2 = startOf(w2);
  assert.deepEqual(s2.device.slice(0, 3), ["sh", "-c", RUN_ARGV]);
  assert.deepEqual(s2.device.slice(7), ["git", "log", "-1", "--format=%H"], "several are an argv, run as given");
});

test("the terminal's name is a valid Herdr name for any id a run makes", () => {
  for (const id of [newTestRunId(0, () => 0), newTestRunId(Date.now(), () => 0.9999999), newTestRunId(2 ** 45, () => 0.5)]) {
    assert.match(terminalName(id), /^[a-z0-9_-]{1,32}$/, terminalName(id));
  }
});

test("the terminal's address is read from hc run's JSON; a bare address gets the machine, anything else is none", () => {
  assert.equal(terminalAddress('{"address":"desktop/t7","name":"x"}', "desktop"), "desktop/t7");
  assert.equal(terminalAddress('{"address":"t7"}', "desktop"), "desktop/t7");
  for (const bad of ["", "not json", "{}", '{"address":""}', '{"address":"-x/t7"}', '{"address":"a b/t7"}', '{"address":["t7"]}', "null"]) assert.equal(terminalAddress(bad, "desktop"), null, bad);
});

test("a start that fails or names no terminal is exit 5 with the reason, and nothing waits", async () => {
  for (const start of [() => ({ code: 1, stdout: "", stderr: "[hc] machine disconnected" }), () => ({ code: 0, stdout: "{}", stderr: "" }), () => { throw new Error("spawn failed"); }]) {
    const w = world({ start });
    const r = await run(w);
    assert.equal(r.code, EXIT.NOT_READY);
    assert.match(r.message, /Couldn't start the command on desktop/);
    assert.ok(!w.steps().includes("wait"));
    assert.ok(cleanedUp(w));
  }
});

test("the checkout fetches the bundle into the private ref and adds a detached worktree at the commit", async () => {
  const w = world();
  await run(w);
  const c = w.calls.find((x) => x.step === "checkout");
  assert.match(CHECKOUT, /fetch --quiet "\$2" "\$3:\$3"/);
  assert.match(CHECKOUT, /worktree add --quiet --detach "\$4" "\$5"/);
  const [root, bundle, ref, folder, sha] = c.args.slice(3);
  assert.equal(root, "/home/me/app");
  assert.match(bundle, /\.bundle$/);
  assert.match(ref, /^refs\/herdr-test\/r\w+$/);
  assert.match(folder, /^\/home\/me\/\.herdr\/test-runs\/r\w+$/);
  assert.equal(sha, SHA);
  assert.ok(bundle.startsWith(folder) && bundle === `${folder}.bundle`);
});

// ---------------------------------------------------------------- results and exit codes

test("exit 0 when the command passed, 1 when it failed, with the log and the code", async () => {
  assert.equal(exitFor({ exitCode: 0, timedOut: false }), 0);
  assert.equal(exitFor({ exitCode: 3, timedOut: false }), 1);
  assert.equal(exitFor({ exitCode: 0, timedOut: true }), 1);
  const r = await run(world({ read: () => ({ code: 0, stdout: "code=3\r\n---\r\n1 failing\r\n", stderr: "" }) }));
  assert.equal(r.code, 1);
  assert.equal(r.result.exitCode, 3);
  assert.equal(r.result.log, "1 failing\n");
  assert.equal(r.result.timedOut, false);
});

// A run whose terminal is still going: every wait checks in (reason timeout), the clock moving by what the wait took.
const stillRunning = (c, took = WAIT_SLICE_S * 1000) => (calls) => { c.advance(took); return waitJson(); };

test("the wait is a loop of hc wait slices of at most 590s, each its own exec under the 600s cap, until the terminal exits", async () => {
  const c = clock();
  let n = 0;
  const w = world({ wait: () => { c.advance(WAIT_SLICE_S * 1000); return ++n < 4 ? waitJson() : { code: 0, stdout: '{"ended":true,"exit_code":0,"reason":"exit"}', stderr: "" }; } });
  const r = await run(w, {}, { now: c.now });
  assert.equal(r.code, 0);
  const waits = w.calls.filter((x) => x.step === "wait");
  assert.equal(waits.length, 4, "three check-ins, then the exit");
  for (const x of waits) {
    assert.deepEqual(hcArgs(x), ["wait", "desktop/t9", "--json", "--timeout", String(WAIT_SLICE_S)]);
    assert.equal(x.opts.timeout, WAIT_SLICE_S * 1000 + WAIT_GRACE_MS);
    assert.ok(x.opts.timeout <= EXEC_CAP_MS, "an exec under Herdr's cap");
    assert.equal(x.opts.on, undefined, "the local core's wait, not a spawn on the device");
  }
  assert.ok(!w.steps().includes("kill"), "it ended by itself: nothing to kill");
  assert.equal(r.result.timedOut, false);
  assert.ok(r.result.durationMs >= 3 * WAIT_SLICE_S * 1000, "the run's own time spans the slices");
});

test("the cap: 1.5 hours of slices, then the terminal is killed, timedOut, exit 1, the partial log read, and the cleanup still runs", async () => {
  assert.equal(RUN_TIMEOUT_MS, 5400000);
  const c = clock();
  const w = world({
    wait: stillRunning(c),
    read: () => ({ code: 0, stdout: "code=missing\n---\nhalf a log\n", stderr: "" }),
  });
  const r = await run(w, {}, { now: c.now });
  assert.equal(r.code, 1);
  assert.equal(r.result.timedOut, true);
  assert.equal(r.result.exitCode, TIMED_OUT_CODE);
  assert.equal(r.result.log, "half a log\n");
  assert.match(r.notes.join("\n"), /didn't finish in 5400s/);
  const waits = w.calls.filter((x) => x.step === "wait");
  assert.equal(waits.length, Math.ceil(RUN_TIMEOUT_MS / (WAIT_SLICE_S * 1000)), "590s slices until the 5400s are used up");
  assert.deepEqual(hcArgs(waits.at(-1)).slice(-1), [String(Math.floor((RUN_TIMEOUT_MS - 9 * WAIT_SLICE_S * 1000) / 1000))], "the last slice is only what is left");
  assert.ok(waits.every((x) => Number(hcArgs(x).at(-1)) <= WAIT_SLICE_S));
  const kills = w.calls.filter((x) => x.step === "kill");
  assert.equal(kills.length, 1, "killed once");
  assert.deepEqual(hcArgs(kills[0]), ["kill", "desktop/t9"]);
  assert.ok(w.calls.indexOf(kills[0]) > w.calls.indexOf(waits.at(-1)) && w.calls.indexOf(kills[0]) < w.calls.findIndex((x) => x.step === "read"), "killed before the log is read");
  assert.deepEqual(w.steps().slice(-4), ["rm", "unref", "cleanup", "rm-local"]);
});

test("a run the cap ended is a timeout whatever status it left (none, or one its kill made); only a 0 is a finish", async () => {
  for (const code of ["missing", "137", "143", "1"]) {
    const c = clock();
    const w = world({ wait: stillRunning(c), read: () => ({ code: 0, stdout: `code=${code}\n---\npartial\n`, stderr: "" }) });
    const r = await run(w, {}, { now: c.now });
    assert.equal(r.code, 1, code);
    assert.equal(r.result.timedOut, true, code);
    assert.equal(r.result.exitCode, TIMED_OUT_CODE, code);
    assert.equal(r.result.log, "partial\n");
  }
  const w = world({ read: () => ({ code: 0, stdout: "code=3\n---\nx", stderr: "" }) });
  const r = await run(w);
  assert.equal(r.result.timedOut, false, "a run that wasn't capped keeps its own status");
  assert.equal(r.result.exitCode, 3);
});

test("a kill at the cap that failed is tried again in the cleanup, before the lock is released; one that worked is not repeated", async () => {
  const c = clock();
  let n = 0;
  const w = world({ wait: stillRunning(c), read: () => ({ code: 0, stdout: "code=missing\n---\n", stderr: "" }), kill: () => (++n === 1 ? { code: 1, stdout: "", stderr: "[hc] busy" } : { code: 0, stdout: "", stderr: "" }) });
  const r = await run(w, {}, { now: c.now });
  assert.equal(r.result.timedOut, true);
  const steps = w.steps();
  assert.equal(steps.filter((x) => x === "kill").length, 2);
  assert.ok(steps.lastIndexOf("kill") > steps.indexOf("read") && steps.lastIndexOf("kill") < steps.indexOf("cleanup"), "the second kill comes after the read and before the cleanup that frees the lock");
  const c2 = clock();
  const ok = world({ wait: stillRunning(c2), read: () => ({ code: 0, stdout: "code=missing\n---\n", stderr: "" }) });
  await run(ok, {}, { now: c2.now });
  assert.equal(ok.steps().filter((x) => x === "kill").length, 1);
});

test("a run that finishes just as the cap lands is its own result, not a timeout", async () => {
  const c = clock();
  const w = world({ wait: stillRunning(c, RUN_TIMEOUT_MS), read: () => ({ code: 0, stdout: "code=0\n---\nlast line\n", stderr: "" }) });
  const r = await run(w, {}, { now: c.now });
  assert.equal(r.code, 0);
  assert.equal(r.result.timedOut, false);
  assert.equal(r.result.log, "last line\n");
});

test("waitForRun on its own: slice sizes, check-ins, the exit, the cap", async () => {
  const c = clock(); let seen = [];
  const hcHere = async (args) => { seen.push(args); c.advance(1000 * Number(args.at(-1))); return waitJson(); };
  const r = await waitForRun({ hcHere, address: "desktop/t9", now: c.now, t0: c.now() });
  assert.deepEqual(r, { capped: true });
  assert.equal(seen.length, 10);
  assert.equal(seen.at(-1).at(-1), "90", "5400 - 9 x 590");
  seen = [];
  const exited = await waitForRun({ hcHere: async () => ({ code: 0, stdout: '{"ended":true,"exit_code":3,"reason":"exit"}', stderr: "" }), address: "d/t1", now: c.now, t0: c.now() });
  assert.equal(exited.ended, true);
  assert.equal(exitedAs(exited.got), "exit code 3, exit");
  assert.equal(exitedAs({ exit_code: 129, reason: "killed", signal: "HUP" }), "exit code 129, signal HUP, killed");
  assert.equal(exitedAs(null), "");
  // an exit status that is only in exit_code (no `ended` field) still ends the wait
  assert.equal((await waitForRun({ hcHere: async () => ({ code: 0, stdout: '{"exit_code":0}', stderr: "" }), address: "d/t1", now: c.now, t0: c.now() })).ended, true);
});

test("a lost line or a wait error is asked again a bounded number of times, then the run is exit 5 with the reason and its terminal is killed", async () => {
  assert.equal(WAIT_RETRIES, 3);
  for (const bad of [
    () => ({ code: 1, stdout: "", stderr: "[hc] machine disconnected" }),
    () => { throw new Error("spawn failed"); },
    () => ({ code: 0, stdout: "not json", stderr: "" }),
    () => ({ code: 124, stdout: "", stderr: "[hc] timed out" }),
  ]) {
    const w = world({ wait: bad });
    const r = await run(w);
    assert.equal(r.code, EXIT.NOT_READY);
    assert.match(r.message, /Lost the run on desktop \(desktop\/t9\): /);
    assert.equal(r.result, undefined);
    assert.equal(w.calls.filter((x) => x.step === "wait").length, WAIT_RETRIES);
    assert.equal(w.calls.filter((x) => x.step === "kill").length, 1, "killed anyway");
    assert.deepEqual(hcArgs(w.calls.find((x) => x.step === "kill")), ["kill", "desktop/t9"]);
    assert.ok(w.steps().includes("rm") && cleanedUp(w));
  }
  assert.match((await run(world({ wait: () => ({ code: 1, stdout: "", stderr: "[hc] machine disconnected" }) }))).message, /machine disconnected/);
});

test("one lost line then an answer is fine, and a good answer restarts the count", async () => {
  let n = 0;
  const answers = [{ code: 1, stdout: "", stderr: "blip" }, waitJson(), { code: 1, stdout: "", stderr: "blip" }, { code: 1, stdout: "", stderr: "blip" }, { code: 0, stdout: '{"ended":true,"exit_code":0}', stderr: "" }];
  const c = clock();
  const w = world({ wait: () => { c.advance(WAIT_SLICE_S * 1000); return answers[n++]; } }); // each slice takes its whole length
  const r = await run(w, {}, { now: c.now });
  assert.equal(r.code, 0);
  assert.equal(n, 5);
});

test("a timeout answer that came back far sooner than its slice is a bad try, so a wait that returns at once can't spin the loop", async () => {
  const c = clock();
  const w = world({ wait: () => { c.advance(50); return waitJson(); } });
  const r = await run(w, {}, { now: c.now });
  assert.equal(r.code, EXIT.NOT_READY);
  assert.match(r.message, /Lost the run on desktop[^:]*: the wait came back after 0s of a 590s slice while the terminal was still running/);
  assert.equal(w.calls.filter((x) => x.step === "wait").length, WAIT_RETRIES);
  assert.equal(w.calls.filter((x) => x.step === "kill").length, 1);
  // a slice that took most of its time is a normal check-in, and a short last slice is judged against its own length
  const c2 = clock();
  const hcHere = async (args) => { c2.advance(Number(args.at(-1)) * 1000 * 0.6); return waitJson(); };
  assert.deepEqual(await waitForRun({ hcHere, address: "d/t1", now: c2.now, t0: c2.now() }), { capped: true });
});

test("a wait that keeps answering at once with a reason other than its timeout can't make a spinning loop", async () => {
  const w = world({ wait: () => ({ code: 0, stdout: '{"ended":false,"exit_code":null,"reason":"idle","status":"idle"}', stderr: "" }) });
  const r = await run(w);
  assert.equal(r.code, EXIT.NOT_READY);
  assert.match(r.message, /answered "idle" while the terminal was still running/);
  assert.equal(w.calls.filter((x) => x.step === "wait").length, WAIT_RETRIES);
});

test("--keep tells the cleanup to keep the worktree and log, and reports their paths", async () => {
  const w = world();
  const r = await run(w, { keep: true });
  const cleanup = w.calls.find((c) => c.step === "cleanup");
  assert.equal(cleanup.args[9], "1");
  assert.match(r.kept.worktree, /^\/home\/me\/\.herdr\/test-runs\/r\w+$/);
  assert.equal(r.kept.log, `${r.kept.worktree}.log`);
  const w2 = world();
  const r2 = await run(w2);
  assert.equal(w2.calls.find((c) => c.step === "cleanup").args[9], "0");
  assert.equal(r2.kept, undefined);
});

test("the log read-back keeps the end of a big log", () => {
  assert.match(READ_BACK, /tail -c "\$3"/);
  assert.deepEqual(parseReadBack("code=0\n---\nline\n---\nmore\n"), { code: 0, log: "line\n---\nmore\n" });
  assert.deepEqual(parseReadBack("code=7\r\n---\r\n"), { code: 7, log: "" });
  assert.deepEqual(parseReadBack("code=missing\n---\nx"), { code: null, log: "x" });
});

test("a read-back cut off before its header is an error, never a pass", () => {
  for (const text of ["", "code=0", "code=0\n--", "---\nlog"]) assert.throws(() => parseReadBack(text), /cut off/, JSON.stringify(text));
});

// ---------------------------------------------------------------- cleanup, whatever happens

// The device was asked to clean up, and when a bundle was made here it was removed last.
const cleanedUp = (w) => w.steps().includes("cleanup") && (!w.steps().includes("pack") || w.steps().at(-1) === "rm-local");

test("cleanup runs after a throw or a failure at every step, and the failing step's reason is reported", async () => {
  const boom = () => { throw new Error("spawn failed"); };
  const bad = (stderr) => () => ({ code: 1, stdout: "", stderr });
  const cases = [
    ["prepare", boom, EXIT.NOT_READY, /Couldn't reach desktop: spawn failed/, true],
    ["prepare", bad("no route to host"), EXIT.NOT_READY, /no route to host/, true],
    ["prepare", () => ({ code: 0, stdout: "lock=ok\nbase=1\n", stderr: "" }), EXIT.NOT_READY, /cut off/, true],
    ["ref", bad("cannot lock ref"), EXIT.USAGE, /Couldn't make refs\/herdr-test\//, true],
    ["pack", bad("fatal"), EXIT.USAGE, /Couldn't bundle aaaaaaaaaaaa: fatal/, true],
    ["send", boom, EXIT.NOT_READY, /Couldn't send the bundle to desktop: spawn failed/, true],
    ["send", bad("[hc] machine disconnected"), EXIT.NOT_READY, /machine disconnected/, true],
    ["checkout", bad("fatal: bad object"), EXIT.NOT_READY, /Couldn't check aaaaaaaaaaaa out on desktop: fatal: bad object/, true],
    ["checkout", () => ({ code: 12, stdout: "", stderr: "" }), EXIT.NOT_READY, /git exited 12/, true],
    ["read", bad("no file"), EXIT.NOT_READY, /Couldn't read the run back from desktop: no file/, true],
    ["read", () => ({ code: 0, stdout: "garbage", stderr: "" }), EXIT.NOT_READY, /cut off/, true],
  ];
  for (const [step, answer, code, message, tidied] of cases) {
    const w = world({ [step]: answer });
    const r = await run(w);
    assert.equal(r.code, code, `${step}: ${r.message}`);
    assert.match(r.message ?? "", message, step);
    assert.equal(r.result, undefined, step);
    assert.equal(cleanedUp(w), tidied, `${step}: ${w.steps().join(",")}`);
  }
});

test("a terminal that exited with no exit status written (killed, crashed) and wasn't capped is a lost run: exit 5 with the reason, and cleanup", async () => {
  for (const ended of ['{"ended":true,"exit_code":129,"reason":"killed","signal":"HUP"}', '{"ended":true,"exit_code":0,"reason":"exit"}']) {
    const w = world({ wait: () => ({ code: 0, stdout: ended, stderr: "" }), read: () => ({ code: 0, stdout: "code=missing\n---\npartial\n", stderr: "" }) });
    const r = await run(w);
    assert.equal(r.code, EXIT.NOT_READY);
    assert.equal(r.result, undefined);
    assert.match(r.message, /ended without an exit status: exit code (129, signal HUP, killed|0, exit)/);
    assert.ok(!w.steps().includes("kill"), "it was over already");
    assert.ok(w.steps().includes("rm") && cleanedUp(w));
  }
});

test("a read-back that fails after a timeout is still a timeout: exit 1, timedOut, and cleanup", async () => {
  for (const read of [() => ({ code: 1, stdout: "", stderr: "no route" }), () => { throw new Error("spawn failed"); }, () => ({ code: 0, stdout: "garbage", stderr: "" })]) {
    const c = clock();
    const w = world({ wait: stillRunning(c), read });
    const r = await run(w, {}, { now: c.now });
    assert.equal(r.code, 1);
    assert.equal(r.result.timedOut, true);
    assert.equal(r.result.exitCode, TIMED_OUT_CODE);
    assert.equal(r.result.log, "");
    assert.match(r.notes.join("\n"), /the run had timed out/);
    assert.ok(cleanedUp(w));
  }
});

test("a --commit that starts with a dash is never handed to git as an option", async () => {
  const w = world();
  const r = await run(w, { commit: "--output=/tmp/x" });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.message, /Not a commit/);
  assert.equal(w.calls.length, 0);
});

test("a run that fails before any call to the device has nothing to tidy there", async () => {
  const w = world({ pack: () => ({ code: 1, stdout: "", stderr: "x" }) });
  await run(w);
  assert.deepEqual(w.steps().slice(-3), ["unref", "cleanup", "rm-local"]);
  const w2 = world({ resolve: () => ({ code: 1, stdout: "", stderr: "" }) });
  await run(w2);
  assert.ok(!w2.steps().includes("unref") && !w2.steps().includes("cleanup"));
});

test("cleanup deletes the private ref on both sides and removes the files; the device's cleanup lists them all", async () => {
  const w = world();
  await run(w);
  const unref = w.calls.find((c) => c.step === "unref");
  assert.deepEqual(unref.args.slice(2, 4), ["update-ref", "-d"]);
  assert.match(unref.args[4], /^refs\/herdr-test\/r\w+$/);
  const c = w.calls.find((x) => x.step === "cleanup");
  const [root, folder, bundle, log, code, ref, keep, lock, id] = c.args.slice(3);
  assert.equal(root, "/home/me/app");
  const id0 = folder.split("/").pop();
  assert.deepEqual([folder, bundle, log, code].map((p) => p.replace(id0, "ID")), ["/home/me/.herdr/test-runs/ID", "/home/me/.herdr/test-runs/ID.bundle", "/home/me/.herdr/test-runs/ID.log", "/home/me/.herdr/test-runs/ID.code"]);
  assert.equal(ref, unref.args[4]);
  assert.equal(lock, "/home/me/.herdr/test-runs/.lock");
  assert.equal(testRunId(id), id);
  // the order inside the script: worktree remove, prune, update-ref -d, then the files, then the lock
  const at = (s) => CLEANUP.indexOf(s);
  assert.ok(at("worktree remove --force") < at("worktree prune") && at("worktree prune") < at("update-ref -d") && at("update-ref -d") < at("rm -f \"$3\" \"$5\"") && at("rm -f \"$3\" \"$5\"") < at('rm -rf "$8"'));
  assert.match(CLEANUP, /\[ "\$7" != 1 \]/, "--keep skips removing the worktree and the log");
  assert.match(CLEANUP, /= "\$9" \]; then rm -rf "\$8"/, "the lock is released only by its owner");
});

test("a cleanup that fails is a note, never a change of the result", async () => {
  const w = world({ cleanup: () => ({ code: 1, stdout: "", stderr: "worktree is locked" }), unref: () => { throw new Error("gone"); } });
  const r = await run(w);
  assert.equal(r.code, 0);
  assert.equal(r.result.exitCode, 0);
  assert.match(r.notes.join("\n"), /Cleanup: couldn't delete refs\/herdr-test\/r\w+ here \(gone\)/);
  assert.match(r.notes.join("\n"), /Cleanup: the device's cleanup exited 1 \(worktree is locked\)/);
});

test("cleanup ends and removes the run's terminal on every path that started one, and none that didn't", async () => {
  const boom = () => { throw new Error("spawn failed"); };
  const c0 = () => clock();
  const cases = [
    // [what, world answers, run deps, killed?]
    ["it passed", {}, {}, false],
    ["it failed", { read: () => ({ code: 0, stdout: "code=2\n---\nx", stderr: "" }) }, {}, false],
    ["the read-back threw", { read: boom }, {}, false],
    ["the wait was lost", { wait: boom }, {}, true],
    ["the cap", { wait: stillRunning(c0()) }, "cap", true],
  ];
  for (const [what, at, deps, killed] of cases) {
    const c = clock();
    const w = world(deps === "cap" ? { wait: stillRunning(c) } : at);
    await run(w, {}, deps === "cap" ? { now: c.now } : {});
    const kills = w.calls.filter((x) => x.step === "kill").map(hcArgs);
    assert.deepEqual(kills, killed ? [["kill", "desktop/t9"]] : [], what);
    assert.deepEqual(w.calls.filter((x) => x.step === "rm").map(hcArgs), [["rm", "desktop/t9"]], `${what}: removed`);
    assert.ok(w.calls.findIndex((x) => x.step === "rm") < w.calls.findIndex((x) => x.step === "cleanup"), `${what}: the terminal goes before the worktree`);
    assert.ok(cleanedUp(w), what);
  }
  for (const step of ["prepare", "ref", "pack", "send", "checkout"]) {
    const w = world({ [step]: () => ({ code: 1, stdout: "", stderr: "x" }) });
    await run(w);
    assert.ok(!w.steps().includes("kill") && !w.steps().includes("rm"), `${step} failed before any terminal: none to end`);
  }
});

test("a terminal that is already gone is no complaint, and one that can't be ended is a note, never a different result", async () => {
  const quiet = world({ rm: () => ({ code: 1, stdout: "", stderr: "[hc] no such terminal desktop/t9" }) });
  const r = await run(quiet);
  assert.equal(r.code, 0);
  assert.deepEqual(r.notes, []);
  const c = clock();
  const loud = world({ wait: stillRunning(c), read: () => ({ code: 0, stdout: "code=missing\n---\n", stderr: "" }), kill: () => ({ code: 1, stdout: "", stderr: "[hc] permission denied" }), rm: () => { throw new Error("hc exploded"); } });
  const r2 = await run(loud, {}, { now: c.now });
  assert.equal(r2.code, 1);
  assert.equal(r2.result.timedOut, true);
  assert.match(r2.notes.join("\n"), /couldn't kill the terminal desktop\/t9 \(\[hc\] permission denied\)/);
  assert.match(r2.notes.join("\n"), /couldn't rm the terminal desktop\/t9 \(hc exploded\)/);
});

test("a start that ran but whose answer named no terminal is ended by its name", async () => {
  const w = world({ start: () => ({ code: 0, stdout: "garbage", stderr: "" }) });
  await run(w);
  const name = hcArgs(w.calls.find((x) => x.step === "start"))[hcArgs(w.calls.find((x) => x.step === "start")).indexOf("--name") + 1];
  assert.deepEqual(w.calls.filter((x) => x.step === "kill" || x.step === "rm").map(hcArgs), [["kill", name], ["rm", name]], "the bare name, which Herdr resolves; a machine prefix is only for an address");
  assert.match(name, /^herdr-test-r[a-z0-9]+$/);
});

// ---------------------------------------------------------------- orphans a crash left

const orphan = (name, address, state = "live") => ({ address, name, state, agent: "zsh" });
const lsOf = (...terminals) => () => ({ code: 0, stdout: JSON.stringify({ machines: [], terminals }), stderr: "" });

test("a run first ends this machine's herdr-test-* terminals older than the stale-lock age, by hc ls and hc get on this computer", async () => {
  const now = 1_700_000_000_000;
  const got = { "desktop/t1": now - (STALE_LOCK_S + 60) * 1000, "desktop/t2": now - 600 * 1000, "desktop/t3": now - (STALE_LOCK_S + 1) * 1000 };
  const w = world({
    ls: lsOf(orphan("herdr-test-rold1", "desktop/t1"), orphan("herdr-test-rnew1", "desktop/t2"), orphan("herdr-test-rold2", "desktop/t3", "finished"),
      orphan("herdr-test-rother", "other/t4"), orphan("my-build", "desktop/t5"), orphan(null, "desktop/t6"), orphan("herdr-test-rold3", "desktop/t7")),
    get: (c) => ({ code: 0, stdout: JSON.stringify({ address: hcArgs(c)[1], created_ms: got[hcArgs(c)[1]] ?? now - (STALE_LOCK_S + 5) * 1000 }), stderr: "" }),
  });
  await run(w, {}, { now: () => now });
  const touched = w.calls.filter((x) => ["get", "kill", "rm"].includes(x.step)).map((x) => hcArgs(x).slice(0, 2).join(" "));
  assert.deepEqual(touched.filter((t) => !t.includes("t9")), ["get desktop/t1", "kill desktop/t1", "rm desktop/t1", "get desktop/t2", "get desktop/t7", "kill desktop/t7", "rm desktop/t7"]);
  assert.deepEqual(hcArgs(w.calls.find((x) => x.step === "ls")), ["ls", "--json"]);
  assert.ok(w.calls.every((x) => !x.opts?.on || ["prepare", "checkout", "read", "cleanup"].includes(x.step)), "found by the local core: nothing is spawned on the device for it");
  assert.ok(w.calls.findIndex((x) => x.step === "ls") > w.calls.findIndex((x) => x.step === "prepare"), "after the lock is ours");
});

test("the orphan sweep is bounded, skips this run's own name, never fails the run, and is skipped when the lock is busy", async () => {
  const many = Array.from({ length: 25 }, (_, i) => orphan(`herdr-test-ro${i}`, `desktop/t${i + 20}`));
  const w = world({ ls: lsOf(...many), get: () => ({ code: 0, stdout: JSON.stringify({ created_ms: 1 }), stderr: "" }) });
  await run(w, {}, { now: () => 5_000_000_000_000 });
  assert.equal(w.calls.filter((x) => x.step === "get").length, MAX_ORPHANS);
  for (const bad of [{ code: 1, stdout: "", stderr: "no" }, { code: 0, stdout: "junk", stderr: "" }, { code: 0, stdout: "{}", stderr: "" }]) {
    const w2 = world({ ls: () => bad });
    assert.equal((await run(w2)).code, 0);
  }
  const w3 = world({ ls: () => { throw new Error("gone"); }, get: () => { throw new Error("gone"); } });
  assert.equal((await run(w3)).code, 0);
  const busy = world({ prepare: () => ({ code: 0, stdout: "lock=busy\nholder=rk3\nsince=1\n", stderr: "" }) });
  await run(busy);
  assert.ok(!busy.steps().includes("ls"), "another run is live: not ours to sweep");
});

// ---------------------------------------------------------------- never pushes, never makes a branch

test("no call anywhere pushes, makes a branch or switches one", async () => {
  const all = [];
  for (const [binding, extra] of [[unixBinding, {}], [winBinding, { keep: true }], [unixBinding, { command: ["a", "b"] }]]) {
    const w = world();
    await run(w, { binding, ...extra });
    all.push(...w.calls);
  }
  const text = all.map((c) => [c.cmd, ...c.args].join(" ")).join("\n");
  for (const script of [PREPARE, SEND, CHECKOUT, RUN_LINE, RUN_ARGV, READ_BACK, CLEANUP]) assert.doesNotMatch(script, /\bpush\b|\bbranch\b|checkout -b|switch|\bworktree add -b\b|-B\b/);
  assert.doesNotMatch(text.replace(/--cached/g, ""), /\bpush\b| branch |checkout -b|\bswitch\b|worktree add -b|\bstash\b|\breset\b/);
  assert.match(text, /worktree add --quiet --detach/);
  assert.ok(all.every((c) => c.step !== "git push"));
  assert.ok(all.filter((c) => c.cmd === "git").every((c) => ["rev-parse", "symbolic-ref", "status", "update-ref", "bundle"].includes(c.args[2])));
});

// ---------------------------------------------------------------- the lock

test("a busy device exits 6 with the holder and its start, and touches nothing of the other run", async () => {
  const w = world({ prepare: () => ({ code: 0, stdout: "lock=busy\r\nholder=rk3\r\nsince=1700000000\r\n", stderr: "" }) });
  const r = await run(w);
  assert.equal(r.code, EXIT.BUSY);
  assert.equal(r.message, "busy: run rk3 since 2023-11-14T22:13:20Z");
  assert.deepEqual(w.steps(), ["resolve", "status", "resolve", "resolve", "prepare"], "no pack, no send, and no cleanup that could remove the other run's lock");
  assert.equal(sinceText("junk"), "an unknown time");
  assert.equal(sinceText(""), "an unknown time");
});

test("a lock older than the cap plus five minutes is taken over, and the note says whose it was", async () => {
  assert.equal(STALE_LOCK_S, RUN_TIMEOUT_MS / 1000 + 300);
  assert.equal(STALE_LOCK_S, 5700);
  const w = world({ prepare: () => ({ code: 0, stdout: "took_over=old1\nlock=ok\nbase=0\ndone=1\n", stderr: "" }) });
  const r = await run(w);
  assert.equal(r.code, 0);
  assert.match(r.notes.join("\n"), /Took over a stale lock from run old1/);
  const prep = w.calls.find((c) => c.step === "prepare");
  assert.equal(prep.args[8], "5700");
  assert.equal(prep.args[9], String(SWEEP_AFTER_MIN));
  assert.equal(SWEEP_AFTER_MIN, 1440);
});

test("the prepare script: mkdir lock, id and start inside, sweep only what is older than a day and never the lock", () => {
  assert.match(PREPARE, /mkdir "\$lock"/);
  assert.match(PREPARE, /mv "\$lock" "\$lock\.old\$id"[\s\S]*mkdir "\$lock"/, "a stale lock is moved aside, then made anew");
  assert.doesNotMatch(PREPARE, /rm -rf "\$lock"/);
  assert.match(PREPARE, /printf "%s %s\\n" "\$id" "\$now" > "\$lock\/info"/);
  assert.match(PREPARE, /find "\$d" -mindepth 1 -maxdepth 1 -mmin \+"\$sweep" ! -name \.lock/);
  assert.match(PREPARE, /\*\[!a-z0-9\.\]\*\) continue/, "only names a run makes");
  assert.match(PREPARE, /echo done=1\s*$/, "its last line, so a cut-off answer is never a go");
  assert.doesNotMatch(PREPARE, /rm -rf "?\$d"?\s/, "never the whole test-runs folder");
});

// ---------------------------------------------------------------- ids and parsing

test("run ids are plain lowercase letters and digits whatever the clock and the dice say", () => {
  for (const [now, random] of [[0, () => 0], [Date.now(), () => 0.9999999], [2 ** 41, () => 0.123456]]) {
    const id = newTestRunId(now, random);
    assert.equal(testRunId(id), id, id);
  }
  assert.notEqual(newTestRunId(1000, () => 0.1), newTestRunId(1000, () => 0.2));
  assert.equal(testRunRef("abc"), "refs/herdr-test/abc");
});

test("key=value lines are read through CRLF, the first of a key wins and other lines are ignored", () => {
  assert.deepEqual(parseKeyValues("lock=ok\r\nbase=1\r\nnoise\r\nBad=1\r\nlock=busy\r\ndone=1"), { lock: "ok", base: "1", done: "1" });
  assert.deepEqual(parseKeyValues(undefined), {});
  assert.deepEqual(parseKeyValues("holder=\nsince=12"), { holder: "", since: "12" });
});

test("readiness is exposed for callers that decide before they build anything", () => {
  assert.equal(readiness({ repo: REPO, binding: unixBinding, cheap: green, command: ["x"] }), null);
  assert.equal(readiness({ repo: REPO, binding: unixBinding, cheap: { level: "red" }, command: ["x"] }).code, 5);
});

// ---------------------------------------------------------------- the real scripts, against real git and a real sh

const sh = (cwd, ...cmd) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// A stand-in for hc that is the one machine this test has. `hc exec -i --on m --timeout N -- cmd args` execs cmd args with stdin passed
// through. `hc run --bg --json --on m --name N --cwd C ... -- cmd args` starts cmd args in the background in C (its own process group,
// recorded) and prints { address }; its exit status is written when it ends. `hc wait <address> --json --timeout S` polls for that for at
// most min(S, $FAKE_HC_WAIT_CAP) seconds and answers like Herdr (`ended`, `exit_code`, or reason "timeout"). kill ends the group, rm forgets it.
function fakeHc(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "hc"), String.raw`#!/bin/sh
d=$FAKE_HC_DIR; mkdir -p "$d"; sub=$1; shift
case $sub in
  exec) while [ "$1" != "--" ]; do shift; done; shift; exec "$@" ;;
  run) cwd=.; m=
    while [ "$1" != "--" ]; do case $1 in --cwd) cwd=$2; shift ;; --on) m=$2; shift ;; esac; shift; done; shift
    id=t$(od -An -N3 -tu4 /dev/urandom | tr -d " ")
    ( cd "$cwd" && "$@"; echo $? > "$d/$id.exit" ) </dev/null >/dev/null 2>&1 &
    pid=$!; ps -o pgid= -p "$pid" | tr -d " " > "$d/$id.pgid"
    printf '{"address":"%s/%s","name":"x"}\n' "$m" "$id" ;;
  wait) addr=$1; shift; to=590; while [ $# -gt 0 ]; do [ "$1" = --timeout ] && to=$2; shift; done
    id=@{addr##*/}; [ -n "$FAKE_HC_WAIT_CAP" ] && [ "$FAKE_HC_WAIT_CAP" -lt "$to" ] && to=$FAKE_HC_WAIT_CAP
    [ -f "$d/$id.pgid" ] || { echo "[hc] no such terminal $addr" >&2; exit 1; }
    i=0; while [ "$i" -lt $((to * 10)) ]; do
      if [ -f "$d/$id.exit" ]; then printf '{"ended":true,"exit_code":%s,"reason":"exit","terminal":"%s"}\n' "$(cat "$d/$id.exit")" "$addr"; exit 0; fi
      sleep 0.1; i=$((i + 1)); done
    printf '{"ended":false,"exit_code":null,"reason":"timeout","terminal":"%s"}\n' "$addr" ;;
  kill) id=@{1##*/}; [ -f "$d/$id.pgid" ] && kill -KILL -- "-$(cat "$d/$id.pgid")" 2>/dev/null; [ -f "$d/$id.exit" ] || echo 137 > "$d/$id.exit"; echo "$id" >> "$d/killed" ;;
  rm) id=@{1##*/}; rm -f "$d/$id.pgid" "$d/$id.exit"; echo "$id" >> "$d/removed" ;;
  ls) echo '{"machines":[],"terminals":[]}' ;;
  *) echo "fake hc: $sub" >&2; exit 2 ;;
esac
`.replaceAll("@{", "${"));
  chmodSync(join(bin, "hc"), 0o755);
  return bin;
}

// Runs the call here, as the one machine this test has; `afterWait` runs after each hc wait (to move a fake clock past the run's cap).
const localExec = (env, { afterWait } = {}) => (cmd, args, opts = {}) => new Promise((resolve) => {
  const child = spawn(cmd, args, { cwd: opts.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (code) => { if (args[1] === HC && args[3] === "wait") afterWait?.(); resolve({ code, stdout, stderr }); });
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "device-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...a) => sh(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a);
  const origin = join(dir, "origin.git");
  mkdirSync(origin);
  git(origin, "init", "--bare", "-b", "main");
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", "."); git(seed, "commit", "-m", "one");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "main");
  const mine = join(dir, "mine"), device = join(dir, "device-repo");
  git(dir, "clone", origin, mine);
  git(dir, "clone", origin, device);
  git(mine, "remote", "set-head", "origin", "main");
  writeFileSync(join(mine, "b.bin"), Buffer.from([0, 255, 10, 13, 0, 1, 2, 200]));
  writeFileSync(join(mine, "t.sh"), "echo hi from the worktree; cat a.txt; test -f b.bin\n");
  git(mine, "add", "."); git(mine, "commit", "-m", "two");
  const home = join(dir, "device-home");
  mkdirSync(home);
  const env = { ...process.env, PATH: `${fakeHc(dir)}${delimiter}${process.env.PATH}`, FAKE_HC_DIR: join(dir, "hc-state"), FAKE_HC_WAIT_CAP: "1" };
  const binding = { machine: "dev", os: "unix", home, repoRoots: { [REPO]: device } };
  return { dir, git, mine, device, home, binding, env, runs: join(home, ".herdr", "test-runs"), tmp: join(dir, "tmp"), terminals: join(dir, "hc-state") };
}
const real = (f, extra = {}, opts = {}, deps = {}) => runOnDevice({ exec: localExec(f.env, opts), ...deps }, { repo: REPO, binding: f.binding, cheap: green, cwd: f.mine, tmpDir: (mkdirSync(f.tmp, { recursive: true }), f.tmp), command: ["sh", "t.sh"], ...extra });
const left = (f) => (existsSync(f.runs) ? readdirSync(f.runs) : []);

test("end to end: a thin bundle sent raw, a worktree at the commit, the command run in it, and nothing left behind", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const before = [f.git(f.mine, "branch", "-a"), f.git(f.device, "branch", "-a")];
  const head = f.git(f.mine, "rev-parse", "HEAD");
  const r = await real(f);
  assert.equal(r.code, 0, r.message);
  assert.equal(r.result.commit, head);
  assert.equal(r.result.log, "hi from the worktree\none\n");
  assert.equal(r.result.exitCode, 0);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(left(f), [], "test-runs is empty again: lock, bundle, log, code and worktree are gone");
  assert.deepEqual([f.git(f.mine, "branch", "-a"), f.git(f.device, "branch", "-a")], before, "no branch on either side");
  assert.equal(f.git(f.mine, "for-each-ref", "refs/herdr-test"), "");
  assert.equal(f.git(f.device, "for-each-ref", "refs/herdr-test"), "");
  assert.equal(f.git(f.device, "worktree", "list").split("\n").length, 1);
  assert.deepEqual(readdirSync(f.tmp), [], "the local bundle is gone");
});

test("end to end: a failing command is exit 1 with its log, and the cleanup still runs", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const r = await real(f, { command: ["echo before; echo oops >&2; exit 3"] });
  assert.equal(r.code, 1);
  assert.equal(r.result.exitCode, 3);
  assert.equal(r.result.log, "before\noops\n");
  assert.deepEqual(left(f), []);
});

test("end to end: --keep keeps the worktree and the log, drops the bundle, code, ref and lock", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const r = await real(f, { keep: true });
  assert.equal(r.code, 0, r.message);
  assert.equal(existsSync(join(r.kept.worktree, "a.txt")), true);
  assert.equal(readFileSync(r.kept.log, "utf8"), "hi from the worktree\none\n");
  assert.deepEqual(left(f).sort(), [r.kept.worktree.split("/").pop(), r.kept.log.split("/").pop()].sort());
  assert.equal(f.git(f.device, "for-each-ref", "refs/herdr-test"), "");
});

test("end to end: a whole bundle works when the device has no clone of the base", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const empty = join(f.dir, "empty-device");
  mkdirSync(empty);
  f.git(empty, "init", "-b", "main");
  const r = await real(f, { binding: { ...f.binding, repoRoots: { [REPO]: empty } } });
  assert.equal(r.code, 0, r.message);
  assert.equal(r.result.log, "hi from the worktree\none\n");
});

test("end to end: a command in a detached terminal, waited on by hc wait, with its exit status and log read back; the terminal is removed after", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const r = await real(f, { command: ["sleep 1; echo slow; exit 4"] });
  assert.equal(r.code, 1);
  assert.equal(r.result.exitCode, 4);
  assert.equal(r.result.log, "slow\n");
  assert.equal(r.result.timedOut, false);
  assert.equal(readFileSync(join(f.terminals, "removed"), "utf8").trim().split("\n").length, 1, "its terminal was removed");
  assert.ok(!existsSync(join(f.terminals, "killed")), "it ended by itself: nothing was killed");
});

test("end to end: a command still running at the cap has its terminal killed: timedOut, exit 1, the log so far, and everything is cleaned up", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const c = clock(Date.now());
  const r = await real(f, { command: ["echo started; sleep 30"] }, { afterWait: () => c.advance(RUN_TIMEOUT_MS) }, { now: c.now });
  assert.equal(r.code, 1);
  assert.equal(r.result.timedOut, true);
  assert.equal(r.result.exitCode, TIMED_OUT_CODE);
  assert.match(r.result.log, /started/);
  assert.deepEqual(left(f), []);
  assert.equal(readFileSync(join(f.terminals, "killed"), "utf8").trim().split("\n").length, 1);
  assert.equal(readFileSync(join(f.terminals, "removed"), "utf8").trim().split("\n").length, 1);
});

test("end to end: a second run while one holds the lock exits 6 and leaves the lock alone; a stale lock is taken over", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const lock = join(f.runs, ".lock");
  mkdirSync(lock, { recursive: true });
  const nowS = Math.floor(Date.now() / 1000);
  writeFileSync(join(lock, "info"), `rother ${nowS - 60}\n`);
  const busy = await real(f);
  assert.equal(busy.code, EXIT.BUSY);
  assert.match(busy.message, /^busy: run rother since \d{4}-\d\d-\d\dT[\d:]+Z$/);
  assert.equal(readFileSync(join(lock, "info"), "utf8"), `rother ${nowS - 60}\n`, "the other run's lock is untouched");
  assert.deepEqual(left(f), [".lock"]);

  writeFileSync(join(lock, "info"), `rold ${nowS - STALE_LOCK_S - 1}\n`);
  const took = await real(f);
  assert.equal(took.code, 0, took.message);
  assert.match(took.notes.join("\n"), /Took over a stale lock from run rold/);
  assert.deepEqual(left(f), [], "the old lock is gone too");

  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "info"), "");
  const unknown = await real(f);
  assert.equal(unknown.code, EXIT.BUSY, "a lock with no info that is young is busy");
  const old = new Date(Date.now() - (STALE_LOCK_S / 60 + 5) * 60 * 1000);
  utimesSync(lock, old, old);
  assert.equal((await real(f)).code, 0, "and one with no info older than the cap plus five minutes is stale");
});

test("end to end: the sweep removes only what is older than 24h, with its worktree and ref, and leaves the rest", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  mkdirSync(f.runs, { recursive: true });
  // a crashed run's leftovers: a worktree with its private ref, a bundle and a log
  const sha = f.git(f.device, "rev-parse", "HEAD");
  f.git(f.device, "update-ref", "refs/herdr-test/rcrash1", sha);
  f.git(f.device, "worktree", "add", "--detach", join(f.runs, "rcrash1"), sha);
  writeFileSync(join(f.runs, "rcrash1.bundle"), "x"); writeFileSync(join(f.runs, "rcrash1.log"), "x");
  writeFileSync(join(f.runs, "rfresh.log"), "x");
  writeFileSync(join(f.runs, "keep me.txt"), "x");
  const longAgo = new Date(Date.now() - 25 * 3600 * 1000), yesterdayish = new Date(Date.now() - 23 * 3600 * 1000);
  for (const n of ["rcrash1", "rcrash1.bundle", "rcrash1.log"]) utimesSync(join(f.runs, n), longAgo, longAgo);
  utimesSync(join(f.runs, "rfresh.log"), yesterdayish, yesterdayish);
  utimesSync(join(f.runs, "keep me.txt"), longAgo, longAgo);
  const r = await real(f);
  assert.equal(r.code, 0, r.message);
  assert.deepEqual(left(f).sort(), ["keep me.txt", "rfresh.log"], "a name a run could not have made is left alone, and so is anything under a day old");
  assert.equal(f.git(f.device, "for-each-ref", "refs/herdr-test"), "");
  assert.equal(f.git(f.device, "worktree", "list").split("\n").length, 1);
});

test("end to end: a binary bundle goes through stdin byte for byte", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.mine, "big.bin"), Buffer.from(Array.from({ length: 300000 }, (_, i) => (i * 31 + (i >> 8)) & 255)));
  f.git(f.mine, "add", "."); f.git(f.mine, "commit", "-m", "big");
  const r = await real(f, { command: ["cmp", "big.bin", join(f.mine, "big.bin")] });
  assert.equal(r.code, 0, `${r.message ?? ""}${r.result?.log ?? ""}`);
});

test("end to end: a commit that is already in origin's default still bundles, and a dirty tree is only reported", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.mine, "untracked.txt"), "x");
  const r = await real(f, { commit: "origin/main", command: ["cat", "a.txt"] });
  assert.equal(r.code, 0, r.message);
  assert.equal(r.result.log, "one\n");
  assert.match(r.notes.join("\n"), /Uncommitted changes aren't sent/);
  const missing = await real(f, { binding: { ...f.binding, repoRoots: { [REPO]: join(f.dir, "no-such-repo") } } });
  assert.equal(missing.code, EXIT.NOT_READY);
  assert.match(missing.message, /isn't a git repo/);
  assert.deepEqual(left(f), [], "a missing repo folder takes no lock");
});
