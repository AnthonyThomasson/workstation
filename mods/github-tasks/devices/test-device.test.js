import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as model from "./test-device.js";
import * as deepCheck from "./deep-check.js";
import { runDeepCheck } from "./deep-check.js";
import {
  DEEP_SCRIPT, MIN_FREE_KB, STALE_AFTER_MS, bindMachine, cheapHealth, deepArgs, deepChecks, failing, healthOf, normalizeBinding, parseDeep,
  pickRepoFolder, probeFailure, repoRootFor, repoSlug, requiresFromConfig, rollup, startsHere, withHealth, withRepoRoot, withStartHere,
} from "./test-device.js";
import { TEST_DEVICE } from "../lib/index.js";

const REPO = "AnthonyThomasson/workstation";
const NOW = Date.parse("2026-11-22T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const bound = (extra = {}) => normalizeBinding({ machine: "desktop", os: "windows", home: "C:/Users/me", repoRoots: { [REPO]: "C:/src/workstation" }, ...extra });

test("the binding lives under one shared key", () => {
  assert.equal(TEST_DEVICE, "github-tasks.testDevice");
});

// ---- normalizeBinding ----

test("a binding keeps the machine, os, home, per-repo folders and toggles, and the last health", () => {
  const health = { level: "yellow", at: NOW, checks: [{ id: "gh-scope", level: "yellow", message: "m", fix: "f" }, { id: "git", level: "green", message: "ok" }] };
  const raw = { machine: "desktop", os: "windows", home: "C:/Users/me/", repoRoots: { [REPO]: "C:/src/workstation/" }, startHere: { [REPO]: true }, health };
  assert.deepEqual(normalizeBinding(raw), {
    machine: "desktop", os: "windows", home: "C:/Users/me", repoRoots: { [REPO]: "C:/src/workstation" }, startHere: { [REPO]: true }, health,
  });
});

test("anything malformed is unbound", () => {
  for (const raw of [null, undefined, "desktop", 3, [], [{ machine: "desktop" }], {}, { machine: "" }, { machine: "  ", os: "unix", home: "/h" },
    { machine: "desktop" }, { machine: "desktop", os: "windows" }, { machine: "desktop", os: "darwin", home: "/h" }, { machine: "desktop", os: "unix", home: "" },
    { machine: 7, os: "unix", home: "/h" }]) {
    assert.equal(normalizeBinding(raw), null, JSON.stringify(raw));
  }
});

test("unknown fields are dropped, so a stored hostname, user or key never survives", () => {
  const got = normalizeBinding({ machine: "desktop", os: "unix", home: "/home/me", host: "desktop-8d2jtto", target: "athom@desktop-8d2jtto", user: "athom", key: "ssh-rsa AAAA", extra: 1 });
  assert.deepEqual(Object.keys(got).sort(), ["health", "home", "machine", "os", "repoRoots", "startHere"]);
  assert.doesNotMatch(JSON.stringify(got), /athom|8d2jtto|ssh-rsa/);
});

test("repo keys must look like owner/repo, and a toggle needs a folder and to be exactly true", () => {
  const got = normalizeBinding({
    machine: "m", os: "unix", home: "/h",
    repoRoots: { [REPO]: "/r", "not a repo": "/x", "a/b/c": "/y", "/": "/z", "o/empty": "  ", "o/num": 4, __proto__x: "/q", "o/ok.js-1": "/ok" },
    startHere: { [REPO]: true, "o/ok.js-1": "yes", "o/nofolder": true, bad: true },
  });
  assert.deepEqual(got.repoRoots, { [REPO]: "/r", "o/ok.js-1": "/ok" });
  assert.deepEqual(got.startHere, { [REPO]: true });
});

test("repoRoots, startHere and health of the wrong type are cleared, and a malformed health is none", () => {
  const got = normalizeBinding({ machine: "m", os: "unix", home: "/h", repoRoots: [1], startHere: "x", health: { level: "purple", checks: [], at: 1 } });
  assert.deepEqual(got, { machine: "m", os: "unix", home: "/h", repoRoots: {}, startHere: {}, health: null });
  for (const health of [{ level: "red", checks: "no", at: 1 }, { level: "red", checks: [], at: "now" }, { level: "red", checks: [], at: NaN }, []]) {
    assert.equal(normalizeBinding({ machine: "m", os: "unix", home: "/h", health }).health, null);
  }
});

test("a health keeps only well-formed checks, and a check's unknown fields and blank fix are dropped", () => {
  const { health } = normalizeBinding({
    machine: "m", os: "unix", home: "/h",
    health: { level: "red", at: 5, checks: [{ id: "git", level: "red", message: "no git", fix: "  ", token: "x" }, { id: "", level: "red", message: "x" }, { id: "a", level: "bad", message: "x" }, { id: "b", level: "red" }, null] },
  });
  assert.deepEqual(health, { level: "red", at: 5, checks: [{ id: "git", level: "red", message: "no git" }] });
});

test("normalizing is idempotent", () => {
  const once = bound({ startHere: { [REPO]: true }, health: healthOf([{ id: "git", level: "green", message: "ok" }], NOW) });
  assert.deepEqual(normalizeBinding(once), once);
  assert.deepEqual(normalizeBinding(JSON.parse(JSON.stringify(once))), once);
});

test("bindMachine caches the probe's os and home and nothing else", () => {
  assert.deepEqual(bindMachine("desktop", { on: "desktop", os: "windows", home: "C:/Users/me" }), { machine: "desktop", os: "windows", home: "C:/Users/me", repoRoots: {}, startHere: {}, health: null });
  assert.equal(bindMachine("desktop", null), null);
});

test("setting a repo folder, its Start toggle and the health", () => {
  let b = bindMachine("desktop", { os: "unix", home: "/h" });
  b = withRepoRoot(b, REPO, "/h/w");
  assert.equal(repoRootFor(b, REPO), "/h/w");
  assert.equal(repoRootFor(b, "o/other"), null);
  assert.equal(startsHere(b, REPO), false);
  b = withStartHere(b, REPO, true);
  assert.equal(startsHere(b, REPO), true);
  assert.equal(startsHere(withStartHere(b, "bad", true), "bad"), false);
  b = withHealth(b, healthOf([{ id: "git", level: "green", message: "ok" }], NOW));
  assert.equal(b.health.level, "green");
  b = withRepoRoot(b, REPO, "");
  assert.deepEqual([b.repoRoots, b.startHere], [{}, {}], "clearing the folder clears its toggle");
  assert.equal(withRepoRoot(null, REPO, "/x"), null);
});

// ---- the cheap light ----

const machine = (state = "connected", name = "desktop") => ({ name, state, host: "desktop-8d2jtto", target: "athom@desktop-8d2jtto" });
const deep = (level, at, checks = []) => ({ level, at, checks });

test("unbound has no light", () => {
  assert.equal(cheapHealth(null, [machine()], NOW), null);
});

test("a machine that left the list is red, from the list alone", () => {
  for (const list of [[], [machine("connected", "laptop")], { machines: [] }, undefined, null]) {
    const got = cheapHealth(bound(), list, NOW);
    assert.equal(got.level, "red");
    assert.equal(got.checks[0].message, "`desktop` isn't a Herdr machine any more.");
    assert.ok(got.checks[0].fix);
  }
});

test("a machine that is not connected is red, whatever it was last time", () => {
  for (const entry of [machine("disconnected"), machine("connecting"), { name: "desktop" }]) {
    const got = cheapHealth(bound({ health: deep("green", NOW) }), { machines: [entry] }, NOW);
    assert.equal(got.level, "red");
    assert.equal(got.checks[0].message, "`desktop` isn't connected.");
  }
});

test("connected with no deep result is yellow: Not checked yet", () => {
  const got = cheapHealth(bound(), { machines: [machine()] }, NOW);
  assert.equal(got.level, "yellow");
  assert.equal(got.checks[0].message, "Not checked yet");
});

test("connected with a fresh deep result shows that result's level and checks", () => {
  const checks = [{ id: "gh-scope", level: "yellow", message: "m", fix: "f" }];
  for (const level of ["green", "yellow", "red"]) {
    const got = cheapHealth(bound({ health: deep(level, NOW - DAY, checks) }), [machine()], NOW);
    assert.equal(got.level, level);
    assert.deepEqual(got.checks, checks);
    assert.equal(got.checkedAt, NOW - DAY);
  }
});

test("a deep result older than 7 days is yellow: Last checked N days ago; exactly 7 days is still fresh", () => {
  assert.equal(cheapHealth(bound({ health: deep("green", NOW - STALE_AFTER_MS) }), [machine()], NOW).level, "green");
  const got = cheapHealth(bound({ health: deep("green", NOW - 9.5 * DAY) }), [machine()], NOW);
  assert.equal(got.level, "yellow");
  assert.equal(got.checks[0].message, "Last checked 9 days ago");
  assert.equal(cheapHealth(bound({ health: deep("red", NOW - 8 * DAY) }), [machine()], NOW).level, "yellow", "a stale red is not trusted either");
});

test("a deep result from the future (a clock that moved) is fresh", () => {
  assert.equal(cheapHealth(bound({ health: deep("green", NOW + DAY) }), [machine()], NOW).level, "green");
});

test("failing lists the yellow and red checks, reds first", () => {
  const health = deep("red", NOW, [{ id: "a", level: "green", message: "" }, { id: "b", level: "yellow", message: "" }, { id: "c", level: "red", message: "" }]);
  assert.deepEqual(failing(health).map((c) => c.id), ["c", "b"]);
  assert.deepEqual(failing(null), []);
});

test("rollup: any red is red, else any yellow is yellow, else green", () => {
  const c = (...levels) => levels.map((level, i) => ({ id: String(i), level, message: "" }));
  assert.equal(rollup(c("green", "yellow", "red")), "red");
  assert.equal(rollup(c("yellow", "green")), "yellow");
  assert.equal(rollup(c("green", "green")), "green");
  assert.equal(rollup([]), "green");
});

// ---- the deep check ----

// What the desktop really printed for the script (Git Bash, MINGW64), with no repo folder set.
const DESKTOP = [
  "dc.os=MINGW64_NT-10.0-26200", "dc.git=1", "dc.gh_code=0", "dc.gh_out=github.com",
  "dc.gh_out=  ✓ Logged in to github.com account AnthonyThomasson (keyring)", "dc.gh_out=  - Active account: true",
  "dc.gh_out=  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'", "dc.repo=unset", "dc.disk_kb=21372000", "dc.missing=godot", "dc.mods=same", "dc.done=1",
].join("\n");

const GOOD = [
  "dc.os=MINGW64_NT-10.0-26200", "dc.git=1", "dc.gh_code=0",
  "dc.gh_out=github.com", "dc.gh_out=  ✓ Logged in to github.com account me (keyring)", "dc.gh_out=  - Active account: true", "dc.gh_out=  - Token scopes: 'gist', 'project', 'repo'",
  "dc.repo=found", "dc.main=1", `dc.origin=https://github.com/${REPO}.git`, "dc.disk_kb=50000000", "dc.mods=same", "dc.done=1",
].join("\n");

const input = { machine: "desktop", repo: REPO, repoRoot: "C:/src/workstation", requires: [] };
const run = (stdout, extra = {}) => ({ code: 0, stdout, stderr: "", ...extra });
const by = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));
const withLine = (out, ...replace) => replace.reduce((s, [from, to]) => s.replace(from, to), out);

test("the parser reads each key=value line, and ignores anything else (a login shell's banner)", () => {
  const p = parseDeep(`Welcome to Git Bash\n${GOOD}\n`);
  assert.deepEqual([p.done, p.os, p.git, p.ghCode, p.repo, p.main, p.origin, p.diskKb, p.mods], [true, "MINGW64_NT-10.0-26200", true, 0, "found", true, `https://github.com/${REPO}.git`, 50000000, "same"]);
  assert.equal(p.ghOut.length, 4);
  assert.deepEqual(parseDeep("dc.missing=godot\ndc.missing=python\ndc.mods=differs\ndc.mods_count=4\ndc.mods_file=Files a and b differ\ndc.done=1").missing, ["godot", "python"]);
});

test("the parser reads CRLF like LF", () => {
  const crlf = GOOD.replace(/\n/g, "\r\n") + "\r\n";
  assert.deepEqual(parseDeep(crlf), parseDeep(GOOD));
  assert.equal(parseDeep(crlf).origin, `https://github.com/${REPO}.git`);
  assert.equal(rollup(deepChecks(input, run(crlf))), "green");
});

test("a green device: every group passes", () => {
  const checks = deepChecks(input, run(GOOD));
  assert.equal(rollup(checks), "green");
  assert.deepEqual(checks.map((c) => c.id), ["repo", "git", "gh", "disk", "mods"]);
  assert.ok(checks.every((c) => c.level === "green" && !c.fix));
});

test("truncated output is red, never green", () => {
  const cut = GOOD.slice(0, GOOD.indexOf("dc.disk_kb"));
  for (const stdout of [cut, "", GOOD.replace("\ndc.done=1", ""), "dc.git=1\ndc.done=0"]) {
    const checks = deepChecks(input, run(stdout, { stderr: "timed out after 120s\nmore" }));
    assert.equal(rollup(checks), "red");
    assert.equal(checks.length, 1);
    assert.equal(checks[0].id, "output");
    assert.match(checks[0].message, /didn't finish: timed out after 120s/);
  }
  assert.equal(deepChecks(input, undefined)[0].level, "red");
});

test("red: no repo folder, a path that doesn't exist, a worktree, an origin that isn't the repo", () => {
  const unset = by(deepChecks({ ...input, repoRoot: null }, run(withLine(GOOD, ["dc.repo=found", "dc.repo=unset"]))));
  assert.equal(unset["repo-folder"].level, "red");
  assert.match(unset["repo-folder"].message, /No repo folder is set for AnthonyThomasson\/workstation on `desktop`/);
  assert.ok(unset["repo-folder"].fix);
  const bareNoPath = by(deepChecks({ ...input, repoRoot: null }, run(GOOD)));
  assert.equal(bareNoPath["repo-folder"].level, "red", "a binding with no folder is red even if the script saw one");

  const missing = by(deepChecks(input, run(withLine(GOOD, ["dc.repo=found", "dc.repo=missing"]))));
  assert.match(missing["repo-folder"].message, /C:\/src\/workstation doesn't exist/);

  const worktree = by(deepChecks(input, run(withLine(GOOD, ["dc.main=1", "dc.main=0"]))));
  assert.equal(worktree["repo-main"].level, "red");
  assert.match(worktree["repo-main"].message, /linked worktree/);

  for (const origin of ["https://github.com/someone/else.git", "", "/srv/git/workstation.git"]) {
    const wrong = by(deepChecks(input, run(withLine(GOOD, [`dc.origin=https://github.com/${REPO}.git`, `dc.origin=${origin}`]))));
    assert.equal(wrong["repo-origin"].level, "red", origin);
  }
  assert.match(by(deepChecks(input, run(withLine(GOOD, [`https://github.com/${REPO}.git`, ""]))))["repo-origin"].message, /has no origin/);
});

test("origin matches whatever form GitHub's URL takes, without regard to case", () => {
  for (const origin of [`https://github.com/${REPO}`, `git@github.com:${REPO}.git`, `ssh://git@github.com/${REPO}.git`, `https://github.com/${REPO.toUpperCase()}.git/`, `https://user@github.com/${REPO}.git`]) {
    const checks = deepChecks(input, run(withLine(GOOD, [`https://github.com/${REPO}.git`, origin])));
    assert.equal(by(checks).repo.level, "green", origin);
  }
});

test("a missing repo folder says nothing about the origin or main checkout", () => {
  const checks = deepChecks(input, run(withLine(GOOD, ["dc.repo=found", "dc.repo=missing"], ["dc.main=1", "dc.main=0"])));
  assert.deepEqual(checks.filter((c) => c.level === "red").map((c) => c.id), ["repo-folder"]);
});

test("red: git is missing", () => {
  const checks = by(deepChecks(input, run(withLine(GOOD, ["dc.git=1", "dc.git=0"]))));
  assert.equal(checks.git.level, "red");
  assert.equal(rollup(Object.values(checks)), "red");
});

test("yellow: gh missing, not signed in, or without the project scope, in the doctor's words", () => {
  const gh = (code, lines) => withLine(GOOD, [/dc\.gh_code=0\n(dc\.gh_out=.*\n)+/, `dc.gh_code=${code}\n${lines.map((l) => `dc.gh_out=${l}`).join("\n")}${lines.length ? "\n" : ""}`]);
  const missing = by(deepChecks(input, run(gh(127, []))));
  assert.equal(missing.gh.level, "yellow");
  assert.match(missing.gh.message, /gh isn't installed or can't run/);
  const signedOut = by(deepChecks(input, run(gh(1, ["You are not logged into any GitHub hosts. To log in, run: gh auth login"]))));
  assert.equal(signedOut["gh-auth"].level, "yellow");
  assert.match(signedOut["gh-auth"].message, /gh isn't signed in to GitHub/);
  const scope = by(deepChecks(input, run(gh(0, ["github.com", "  ✓ Logged in to github.com account me (keyring)", "  - Active account: true", "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'"]))));
  assert.equal(scope["gh-scope"].level, "yellow");
  assert.match(scope["gh-scope"].message, /missing the "project" scope/);
  assert.match(scope["gh-scope"].fix, /Sign in on desktop/);
  for (const checks of [missing, signedOut, scope]) assert.equal(rollup(Object.values(checks)), "yellow");
});

test("the real desktop output with no repo folder: red for the folder, yellow for gh's scope, green elsewhere", () => {
  const checks = by(deepChecks({ ...input, repoRoot: null, requires: ["godot"] }, run(DESKTOP)));
  assert.equal(checks["repo-folder"].level, "red");
  assert.equal(checks["gh-scope"].level, "yellow");
  assert.equal(checks.requires.level, "yellow");
  assert.match(checks.requires.message, /godot isn't installed/);
  assert.equal(checks.disk.level, "green");
  assert.equal(checks.mods.level, "green");
  assert.equal(rollup(Object.values(checks)), "red");
});

test("yellow: under 10 GB free; unknown free space is not a finding", () => {
  const free = (kb) => withLine(GOOD, ["dc.disk_kb=50000000", `dc.disk_kb=${kb}`]);
  assert.equal(by(deepChecks(input, run(free(MIN_FREE_KB - 1)))).disk.level, "yellow");
  assert.match(by(deepChecks(input, run(free(6 * 1024 * 1024)))).disk.message, /Only 6\.0 GB is free/);
  assert.equal(by(deepChecks(input, run(free(MIN_FREE_KB)))).disk.level, "green");
  assert.equal(by(deepChecks(input, run(free("")))).disk, undefined);
});

test("yellow: a command the repo's test_device.requires lists is missing", () => {
  const two = by(deepChecks({ ...input, requires: ["godot", "python"] }, run(withLine(GOOD, ["dc.mods=same", "dc.missing=godot\ndc.missing=python\ndc.mods=same"]))));
  assert.equal(two.requires.level, "yellow");
  assert.match(two.requires.message, /^godot, python aren't installed/);
  const found = by(deepChecks({ ...input, requires: ["godot"] }, run(GOOD)));
  assert.equal(found.requires.level, "green");
  assert.equal(by(deepChecks(input, run(GOOD))).requires, undefined, "no list, no check");
});

test("yellow: the installed mod differs from its clone, is missing, or can't be compared", () => {
  const mods = (value, extra = "") => by(deepChecks(input, run(withLine(GOOD, ["dc.mods=same", `dc.mods=${value}${extra}`])))).mods;
  const differs = mods("differs", "\ndc.mods_count=3");
  assert.equal(differs.level, "yellow");
  assert.match(differs.message, /differs from its clone \(3 files\)/);
  assert.match(differs.fix, /sync\.sh/);
  assert.match(mods("differs", "\ndc.mods_count=1").message, /\(1 file\)/);
  for (const value of ["not-installed", "no-sync-json", "no-clone", "unknown", "something-new"]) assert.equal(mods(value).level, "yellow", value);
});

test("repoSlug reads GitHub remotes and nothing else", () => {
  assert.equal(repoSlug("https://github.com/o/r.git"), "o/r");
  assert.equal(repoSlug("git@github.com:o/r"), "o/r");
  assert.equal(repoSlug("https://gitlab.com/o/r.git"), null);
  assert.equal(repoSlug(""), null);
  assert.equal(repoSlug(undefined), null);
});

test("test_device.requires is read from the repo's config", () => {
  assert.deepEqual(requiresFromConfig("test_device:\n  requires:\n    - godot\n    - python\n"), ["godot", "python"]);
  assert.deepEqual(requiresFromConfig("test_device:\n  requires: [godot, godot, 'py thon', 4]\n"), ["godot", "4"], "duplicates and names with spaces are dropped");
  for (const text of ["", "buttons: []\n", "test_device: x\n", "test_device:\n  requires: godot\n", null, ": : :\n\t- ["]) assert.deepEqual(requiresFromConfig(text), []);
});

test("the probe failure is a red check", () => {
  const c = probeFailure("desktop", new Error("Couldn't tell what desktop runs (sh: no answer; Git Bash at C:/Program Files/Git/bin/bash.exe: no answer).\nmore"));
  assert.equal(c.id, "probe");
  assert.equal(c.level, "red");
  assert.match(c.message, /Couldn't run anything on `desktop`: Couldn't tell what desktop runs/);
  assert.match(c.fix, /Git for Windows/);
});

// ---- the script ----

test("the deep script runs once, writes nothing and never pushes", () => {
  assert.doesNotMatch(DEEP_SCRIPT, /\bpush\b|>\s*[^&\s/]|\brm\b|\bmkdir\b|\btee\b/);
  assert.match(DEEP_SCRIPT, /printf 'dc\.done=1\\n'\n$/);
  assert.deepEqual(deepArgs({ repoRoot: "C:/r", requires: ["godot"] }), ["C:/r", "godot"]);
  assert.deepEqual(deepArgs({ repoRoot: null }), [""]);
});

test("the deep script excludes what sync.sh never copies", () => {
  const sync = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../sync/sync.sh"), "utf8");
  for (const skipped of ["RECIPE.md", "preview.png", ".DS_Store", "gpui-kit.d.ts", "jsconfig.json"]) {
    assert.ok(sync.includes(skipped), `${skipped} is skipped by sync.sh`);
    assert.ok(DEEP_SCRIPT.includes(`-x ${skipped}`), `${skipped} is excluded by the deep check`);
  }
});

test("the deep script runs under sh and prints what the parser reads (here, on this computer)", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const out = execFileSync("sh", ["-c", DEEP_SCRIPT, "github-tasks", root, "git", "no-such-command-xyz"], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: "/nonexistent" } });
  const p = parseDeep(out);
  assert.equal(p.done, true);
  assert.equal(p.git, true);
  assert.equal(p.repo, "found");
  assert.deepEqual(p.missing, ["no-such-command-xyz"]);
  assert.equal(p.mods, "not-installed");
  assert.equal(parseDeep(execFileSync("sh", ["-c", DEEP_SCRIPT, "github-tasks", "", ], { encoding: "utf8" })).repo, "unset");
  assert.equal(parseDeep(execFileSync("sh", ["-c", DEEP_SCRIPT, "github-tasks", "/no/such/folder"], { encoding: "utf8" })).repo, "missing");
});

// ---- runDeepCheck, with a fake exec ----

const fakeExec = (answers) => {
  const calls = [];
  const exec = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return answers(cmd, args, opts, calls.length); };
  return { exec, calls, seen: new Map() };
};

test("a deep check is one probe and one script run on the machine, and returns the host and the saved health", async () => {
  const deps = fakeExec((cmd, args) => (args.includes(DEEP_SCRIPT) ? { code: 0, stdout: GOOD, stderr: "" }
    : cmd === "sh" ? { code: 127, stdout: "", stderr: "sh: not found" } : { code: 0, stdout: "MINGW64_NT\nC:\\Users\\me\n", stderr: "" }));
  const got = await runDeepCheck(deps, { ...input, now: NOW });
  assert.deepEqual(got.host, { on: "desktop", os: "windows", home: "C:/Users/me" });
  assert.deepEqual([got.health.level, got.health.at], ["green", NOW]);
  const scripts = deps.calls.filter((c) => c.args.includes(DEEP_SCRIPT));
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].cmd, "C:/Program Files/Git/bin/bash.exe");
  assert.equal(scripts[0].opts.on, "desktop");
  assert.ok(scripts[0].opts.timeout >= 120000);
  assert.deepEqual(scripts[0].args.slice(-1), ["C:/src/workstation"]);
  for (const call of deps.calls) assert.equal(call.opts.on, "desktop");
});

test("a machine that can't run anything is a red probe check, not a throw", async () => {
  const deps = fakeExec(() => ({ code: 1, stdout: "", stderr: "unreachable" }));
  const got = await runDeepCheck(deps, { ...input, now: NOW });
  assert.equal(got.host, null);
  assert.equal(got.health.level, "red");
  assert.equal(got.health.checks[0].id, "probe");
});

test("a script that throws or is cut off is red", async () => {
  let n = 0;
  const deps = fakeExec(() => { if (++n === 1) return { code: 0, stdout: "Linux\n/home/me\n", stderr: "" }; throw new Error("lost the line to desktop during the call"); });
  const got = await runDeepCheck(deps, { ...input, now: NOW });
  assert.equal(got.health.level, "red");
  assert.match(got.health.checks[0].message, /lost the line/);
});

// ---- spaces and the folder prefill ----

test("the prefilled repo folder is the main checkout of a space on that machine whose origin is this repo", () => {
  const spaces = [
    { on: null, mainRoot: "/Users/me/workstation", remote: `https://github.com/${REPO}.git` },
    { on: "desktop", mainRoot: "C:/src/other", remote: "https://github.com/me/other.git" },
    { on: "desktop", mainRoot: null, remote: null },
    { on: "desktop", mainRoot: "C:/src/workstation/", remote: `git@github.com:${REPO.toLowerCase()}.git` },
    { on: "desktop", mainRoot: "D:/second", remote: `https://github.com/${REPO}.git` },
  ];
  assert.equal(pickRepoFolder(spaces, { machine: "desktop", repo: REPO }), "C:/src/workstation");
  assert.equal(pickRepoFolder(spaces, { machine: "laptop", repo: REPO }), null);
  assert.equal(pickRepoFolder(spaces, { machine: "desktop", repo: "me/none" }), null);
  assert.equal(pickRepoFolder([], { machine: "desktop", repo: REPO }), null);
  assert.equal(pickRepoFolder(undefined, { machine: "desktop", repo: REPO }), null);
});

// ---- no timer ----

test("the module exposes no timer, and no code in devices/ starts one", () => {
  for (const name of [...Object.keys(model), ...Object.keys(deepCheck)]) assert.doesNotMatch(name, /timer|interval|poll|schedul|tick|watch/i, name);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
  assert.ok(files.includes("test-device.js"));
  for (const file of files) {
    const code = readFileSync(path.join(dir, file), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(code, /\b(setInterval|setTimeout|setImmediate|requestAnimationFrame)\b/, file);
  }
});
