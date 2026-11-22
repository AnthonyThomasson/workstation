import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  CLEANUP, CHECKOUT, EXIT, PREPARE, READ_BACK, RUN_ARGV, RUN_LINE, RUN_TIMEOUT_MS, SEND, STALE_LOCK_S, STEP_TIMEOUT_MS, SWEEP_AFTER_MIN, TIMED_OUT_CODE,
  exitFor, newTestRunId, parseKeyValues, parseReadBack, readiness, runOnDevice, sinceText, testRunRef,
} from "./test-run.js";
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
  if (script === PREPARE) return "prepare";
  if (script === SEND) return "send";
  if (script === CHECKOUT) return "checkout";
  if (script === RUN_LINE || script === RUN_ARGV) return "run";
  if (script === READ_BACK) return "read";
  if (script === CLEANUP) return "cleanup";
  if (script === 'rm -f "$1"') return "rm-local";
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
    run: () => ok(),
    read: () => ok("code=0\n---\nall green\n"),
    cleanup: () => ok("done=1\n"),
    "rm-local": () => ok(),
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

test("the steps run in order: pack, send, checkout, run, read, cleanup (prepare first, then the local tidy)", async () => {
  const w = world();
  const r = await run(w);
  assert.equal(r.code, 0);
  assert.deepEqual(w.steps(), ["resolve", "status", "resolve", "resolve", "prepare", "ref", "pack", "send", "checkout", "run", "read", "unref", "cleanup", "rm-local"]);
  assert.equal(r.result.device, "desktop");
  assert.equal(r.result.commit, SHA);
  assert.equal(r.result.exitCode, 0);
  assert.equal(r.result.log, "all green\n");
  assert.equal(r.result.timedOut, false);
  assert.ok(r.result.durationMs > 0);
  assert.deepEqual(Object.keys(r.result).sort(), ["commit", "device", "durationMs", "exitCode", "log", "timedOut"]);
});

test("only the remote steps are spawns on the device: a handful", async () => {
  const w = world();
  await run(w);
  const remote = w.calls.filter((c) => c.opts?.on === "desktop").map((c) => c.step);
  assert.deepEqual(remote, ["prepare", "checkout", "run", "read", "cleanup"]);
  assert.ok(w.calls.filter((c) => ["send"].includes(c.step)).every((c) => !c.opts?.on), "the send is a local hc exec");
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
  assert.equal(send.opts.timeout, RUN_TIMEOUT_MS);
  assert.equal(send.opts.on, undefined, "run here, never `on`");
  const [machine, local, cmd, ...rest] = send.args.slice(3);
  assert.equal(machine, "desktop");
  assert.match(local, /^\/tmp\/x\/herdr-test-r\w+\.bundle$/);
  assert.equal(cmd, "sh");
  assert.deepEqual(rest.slice(0, 2), ["-c", 'cat > "$1"']);
  assert.match(rest.at(-1), /^\/home\/me\/\.herdr\/test-runs\/r\w+\.bundle$/);
  assert.doesNotMatch(send.args[1], /base64/);
});

test("on Windows every remote script goes through Git Bash -lc, on Unix through sh -c", async () => {
  for (const [binding, shell, flag] of [[winBinding, GIT_BASH, "-lc"], [unixBinding, "sh", "-c"]]) {
    const w = world();
    await run(w, { binding });
    for (const c of w.calls.filter((x) => ["prepare", "checkout", "run", "read", "cleanup"].includes(x.step))) {
      assert.equal(c.cmd, shell, c.step);
      assert.equal(c.args[0], flag, c.step);
      assert.equal(c.opts.on, "desktop");
    }
    const send = w.calls.find((c) => c.step === "send");
    assert.equal(send.args[5], shell, "the device's own shell is what cat runs under");
    assert.equal(send.args[6], flag);
    const prep = w.calls.find((c) => c.step === "prepare");
    assert.equal(prep.args[3], `${binding.home}/.herdr/test-runs`);
    assert.equal(prep.args[4], `${binding.home}/.herdr/test-runs/.lock`);
  }
});

test("every remote step but the run has an explicit timeout above exec's 30s default, and the run has the cap", async () => {
  const w = world();
  await run(w);
  for (const c of w.calls.filter((x) => ["prepare", "checkout", "read", "cleanup"].includes(x.step))) assert.equal(c.opts.timeout, STEP_TIMEOUT_MS, c.step);
  assert.ok(STEP_TIMEOUT_MS > 30000 && STEP_TIMEOUT_MS <= RUN_TIMEOUT_MS);
  assert.equal(w.calls.find((x) => x.step === "run").opts.timeout, RUN_TIMEOUT_MS);
});

test("the host comes from the binding: no probe is ever made", async () => {
  const w = world();
  await run(w, { binding: winBinding });
  assert.ok(!w.calls.some((c) => c.args.some((a) => /uname/.test(String(a)))));
});

test("the command: one argument is a shell line, several are an argv; both with the timeout of Herdr's cap", async () => {
  let w = world();
  await run(w, { command: ["npm test && echo done"] });
  let c = w.calls.find((x) => x.step === "run");
  assert.equal(c.args[1], RUN_LINE);
  assert.equal(c.args[6], "npm test && echo done");
  assert.equal(c.opts.timeout, 600000);
  assert.equal(c.opts.on, "desktop");
  w = world();
  await run(w, { command: ["git", "log", "-1", "--format=%H"] });
  c = w.calls.find((x) => x.step === "run");
  assert.equal(c.args[1], RUN_ARGV);
  assert.deepEqual(c.args.slice(6), ["git", "log", "-1", "--format=%H"]);
  assert.match(c.args[3], /^\/home\/me\/\.herdr\/test-runs\/r\w+$/, "the worktree");
  assert.equal(c.args[4], `${c.args[3]}.log`);
  assert.equal(c.args[5], `${c.args[3]}.code`);
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

test("a command the exec cap ended: no exit status, timedOut, exit 1, the partial log, and the cleanup still runs", async () => {
  const w = world({
    run: () => ({ code: 124, stdout: "", stderr: "[hc] timed out after 600000 ms: ended" }),
    read: () => ({ code: 0, stdout: "code=missing\n---\nhalf a log\n", stderr: "" }),
  });
  const r = await run(w);
  assert.equal(r.code, 1);
  assert.equal(r.result.timedOut, true);
  assert.equal(r.result.exitCode, TIMED_OUT_CODE);
  assert.equal(r.result.log, "half a log\n");
  assert.match(r.notes.join("\n"), /didn't finish in 600s/);
  assert.deepEqual(w.steps().slice(-3), ["unref", "cleanup", "rm-local"]);
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

test("a run call that throws leaves no code file, so it reads as a command that didn't finish", async () => {
  const w = world({ run: () => { throw new Error("spawn failed"); }, read: () => ({ code: 0, stdout: "code=missing\n---\n", stderr: "" }) });
  const r = await run(w);
  assert.equal(r.result.timedOut, true);
  assert.equal(r.code, 1);
  assert.ok(cleanedUp(w));
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
  assert.equal(STALE_LOCK_S, 900);
  const w = world({ prepare: () => ({ code: 0, stdout: "took_over=old1\nlock=ok\nbase=0\ndone=1\n", stderr: "" }) });
  const r = await run(w);
  assert.equal(r.code, 0);
  assert.match(r.notes.join("\n"), /Took over a stale lock from run old1/);
  const prep = w.calls.find((c) => c.step === "prepare");
  assert.equal(prep.args[8], "900");
  assert.equal(prep.args[9], String(SWEEP_AFTER_MIN));
  assert.equal(SWEEP_AFTER_MIN, 1440);
});

test("the prepare script: mkdir lock, id and start inside, sweep only what is older than a day and never the lock", () => {
  assert.match(PREPARE, /mkdir "\$lock"/);
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

// `hc exec -i --on m --timeout N -- cmd args` stands in as exec'ing cmd args with stdin passed through.
function fakeHc(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "hc"), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
  chmodSync(join(bin, "hc"), 0o755);
  return bin;
}

// Runs the call here, as the one machine this test has; `killRunAfter` ends the run step like Herdr's exec cap does.
const localExec = (env, { killRunAfter } = {}) => (cmd, args, opts = {}) => new Promise((resolve) => {
  const isRun = args[1] === RUN_LINE || args[1] === RUN_ARGV;
  const child = spawn(cmd, args, { cwd: opts.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", killed = false;
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const timer = isRun && killRunAfter ? setTimeout(() => { killed = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, killRunAfter) : null;
  child.on("close", (code) => { clearTimeout(timer); resolve(killed ? { code: 124, stdout, stderr: "[hc] timed out: ended" } : { code, stdout, stderr }); });
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
  const env = { ...process.env, PATH: `${fakeHc(dir)}${delimiter}${process.env.PATH}` };
  const binding = { machine: "dev", os: "unix", home, repoRoots: { [REPO]: device } };
  return { dir, git, mine, device, home, binding, env, runs: join(home, ".herdr", "test-runs"), tmp: join(dir, "tmp") };
}
const real = (f, extra = {}, opts = {}) => runOnDevice({ exec: localExec(f.env, opts) }, { repo: REPO, binding: f.binding, cheap: green, cwd: f.mine, tmpDir: (mkdirSync(f.tmp, { recursive: true }), f.tmp), command: ["sh", "t.sh"], ...extra });
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

test("end to end: a command the cap ends is timedOut, exit 1, and everything is cleaned up", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const r = await real(f, { command: ["echo started; sleep 30"] }, { killRunAfter: 600 });
  assert.equal(r.code, 1);
  assert.equal(r.result.timedOut, true);
  assert.equal(r.result.exitCode, TIMED_OUT_CODE);
  assert.match(r.result.log, /started/);
  assert.deepEqual(left(f), []);
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

  writeFileSync(join(lock, "info"), `rold ${nowS - 901}\n`);
  const took = await real(f);
  assert.equal(took.code, 0, took.message);
  assert.match(took.notes.join("\n"), /Took over a stale lock from run rold/);
  assert.deepEqual(left(f), []);

  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "info"), "");
  const unknown = await real(f);
  assert.equal(unknown.code, EXIT.BUSY, "a lock with no info that is young is busy");
  const old = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(lock, old, old);
  assert.equal((await real(f)).code, 0, "and one with no info older than the cap is stale");
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
