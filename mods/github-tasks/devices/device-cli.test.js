import test from "node:test";
import assert from "node:assert/strict";
import { cheapFor, checkView, deviceView, problemLines, runView } from "./device-cli.js";
import { EXIT } from "./test-run.js";

const NOW = Date.parse("2026-06-10T12:00:00Z");
const machines = [{ name: "desktop", state: "connected" }];
const green = { level: "green", at: NOW - 1000, checks: [{ id: "git", level: "green", message: "git is installed." }] };
const bound = (health = green) => ({ machine: "desktop", os: "windows", home: "C:/Users/x", repoRoots: { "o/r": "C:/src/r" }, startHere: {}, health });

test("device: unbound is exit 5 with no binding in the data", () => {
  const v = deviceView({ repo: "o/r", binding: null, machines, now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.code, "not-ready");
  assert.match(v.message, /No test device is bound/);
  assert.deepEqual(v.data, { machine: null, repo: "o/r", light: null });
});

test("device: a bound, connected device gives the binding with the repo's folder and the light", () => {
  const v = deviceView({ repo: "o/r", binding: bound(), machines, now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.data.machine, "desktop");
  assert.equal(v.data.os, "windows");
  assert.equal(v.data.repoRoot, "C:/src/r");
  assert.equal(v.data.light.level, "green");
  assert.deepEqual(v.data.repoRoots, { "o/r": "C:/src/r" });
  assert.equal("hostname" in v.data, false);
  assert.equal(deviceView({ repo: "o/other", binding: bound(), machines, now: NOW }).data.repoRoot, null);
});

test("device: yellow is still ok (exit 0) and its problems stay in the light", () => {
  const yellow = { level: "yellow", at: NOW, checks: [{ id: "gh-scope", level: "yellow", message: "no project scope", fix: "Sign in again." }] };
  const v = deviceView({ repo: "o/r", binding: bound(yellow), machines, now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.data.light.level, "yellow");
  assert.deepEqual(problemLines(v.data.light), ["  ! no project scope (Sign in again.)"]);
});

test("device: a machine that is gone or not connected is red, from the machine list alone", () => {
  const gone = deviceView({ repo: "o/r", binding: bound(), machines: [], now: NOW });
  assert.equal(gone.code, "not-ready");
  assert.match(gone.message, /desktop is red:\n  ! `desktop` isn't a Herdr machine any more/);
  assert.equal(gone.data.light.level, "red");
  const down = deviceView({ repo: "o/r", binding: bound(), machines: [{ name: "desktop", state: "disconnected" }], now: NOW });
  assert.match(down.message, /isn't connected/);
  const redDeep = deviceView({ repo: "o/r", binding: bound({ level: "red", at: NOW, checks: [{ id: "repo-folder", level: "red", message: "No repo folder.", fix: "Set it." }] }), machines, now: NOW });
  assert.match(redDeep.message, /No repo folder\. \(Set it\.\)/);
});

test("device check: the saved result, red is exit 5, none is exit 5", () => {
  assert.equal(checkView({ repo: "o/r", binding: null }).code, "not-ready");
  const ok = checkView({ repo: "o/r", binding: bound() });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.health.level, "green");
  assert.equal(ok.data.machine, "desktop");
  const red = checkView({ repo: "o/r", binding: bound({ level: "red", at: NOW, checks: [{ id: "git", level: "red", message: "git isn't installed.", fix: "Install it." }] }) });
  assert.equal(red.ok, false);
  assert.equal(red.code, "not-ready");
  assert.match(red.message, /git isn't installed\. \(Install it\.\)/);
  assert.equal(red.data.health.level, "red");
  assert.equal(checkView({ repo: "o/r", binding: bound(null) }).code, "not-ready");
});

test("cheapFor gives the runner a level and the first thing wrong", () => {
  assert.equal(cheapFor(null), null);
  assert.deepEqual(cheapFor({ level: "green", checks: [] }), { level: "green", message: "" });
  assert.deepEqual(cheapFor({ level: "red", checks: [{ id: "connected", level: "red", message: "desktop isn't connected." }] }), { level: "red", message: "desktop isn't connected." });
});

test("run: a passed command is exit 0; a failed or timed out one is an answer with exit 1", () => {
  const result = { device: "desktop", commit: "a".repeat(40), exitCode: 0, log: "ok\n", durationMs: 5, timedOut: false };
  assert.deepEqual(runView({ code: 0, result, notes: ["n"] }), { ok: true, data: result, exit: 0, notes: ["n"] });
  const failed = runView({ code: 1, result: { ...result, exitCode: 3 }, notes: [] });
  assert.equal(failed.ok, true);
  assert.equal(failed.exit, 1);
  assert.deepEqual(failed.notes, ["The command exited with 3."]);
  const timed = runView({ code: 1, result: { ...result, exitCode: 124, timedOut: true }, notes: ["It didn't finish in 600s."] });
  assert.deepEqual(timed.notes, ["It didn't finish in 600s."]);
  assert.equal(timed.data.timedOut, true);
  assert.deepEqual(runView({ code: 0, result, notes: [], kept: { worktree: "C:/w", log: "C:/l" } }).data.kept, { worktree: "C:/w", log: "C:/l" });
});

test("run: not ready, busy and a bad commit are failures with their own codes and the runner's notes", () => {
  assert.deepEqual(runView({ code: EXIT.NOT_READY, message: "No test device is bound.", notes: ["n"] }), { ok: false, code: "not-ready", message: "No test device is bound.", notes: ["n"] });
  assert.equal(runView({ code: EXIT.BUSY, message: "busy: run r1 since then", notes: [] }).code, "busy");
  assert.equal(runView({ code: EXIT.USAGE, message: "Can't find commit x.", notes: [] }).code, "usage");
  assert.equal(runView({ code: 5, notes: [] }).message, "The run didn't finish.");
});
