import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FIND_SCRIPT, bindFlow, checkFlow, findRepoFolder, parseFound } from "./bind.js";
import { DEEP_SCRIPT } from "./test-device.js";
import { GIT_BASH } from "../runs/index.js";

const REPO = "AnthonyThomasson/workstation";
const NOW = Date.parse("2026-11-22T12:00:00Z");
const DEEP_OK = ["dc.os=MINGW64_NT", "dc.git=1", "dc.gh_code=0", "dc.gh_out=  - Token scopes: 'project', 'repo'", "dc.repo=found", "dc.main=1",
  `dc.origin=https://github.com/${REPO}.git`, "dc.disk_kb=99999999", "dc.mods=same", "dc.done=1"].join("\r\n");

// A fake Herdr exec for a Windows machine called desktop: sh isn't there, Git Bash is, and git answers about two folders.
function fake({ probeFails = false, deep = DEEP_OK } = {}) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (probeFails) return { code: 1, stdout: "", stderr: "no answer" };
    if (cmd === "sh") return { code: 1, stdout: "", stderr: "sh: not found" };
    if (cmd === GIT_BASH && args[1] === FIND_SCRIPT) {
      const known = { "C:/work/other": ["C:/work/other", "git@github.com:someone/else.git"], "C:/work/ws": ["C:/work/ws", `https://github.com/${REPO}.git`] };
      const out = args.slice(3).filter((f) => known[f]).map((f) => `fr.main=${known[f][0]}\r\nfr.origin=${known[f][1]}\r\n`).join("");
      return { code: 0, stdout: out, stderr: "" };
    }
    if (cmd === GIT_BASH && args[1] === DEEP_SCRIPT) return { code: 0, stdout: deep, stderr: "" };
    if (cmd === GIT_BASH) return { code: 0, stdout: "MINGW64_NT-10.0\nC:/Users/me\n", stderr: "" };
    throw new Error(`unexpected ${cmd}`);
  };
  return { exec, calls };
}
const finds = (calls) => calls.filter((c) => c.args?.[1] === FIND_SCRIPT);
const probes = (calls) => calls.filter((c) => c.args?.[1] !== DEEP_SCRIPT && c.args?.[1] !== FIND_SCRIPT);
const deeps = (calls) => calls.filter((c) => c.args?.[1] === DEEP_SCRIPT);

test("findRepoFolder: ONE script for all the folders; takes the main checkout whose origin is the repo", async () => {
  const { exec, calls } = fake();
  const found = await findRepoFolder({ exec, seen: new Map([["desktop", { on: "desktop", os: "windows", home: "C:/Users/me" }]]) }, { machine: "desktop", repo: REPO, folders: ["C:/work/other", "C:/work/ws", "C:/work/never"] });
  assert.equal(found, "C:/work/ws");
  assert.equal(calls.length, 1, "one spawn for every folder");
  assert.equal(calls[0].cmd, GIT_BASH);
  assert.deepEqual(calls[0].args.slice(3), ["C:/work/other", "C:/work/ws", "C:/work/never"]);
  assert.equal(calls[0].opts.on, "desktop");
  assert.ok(!calls.some((c) => c.cmd === "git"));
});

test("findRepoFolder: null when no space matches, none are given, no repo, or the script fails", async () => {
  const seen = () => new Map([["desktop", { on: "desktop", os: "windows", home: "C:/Users/me" }]]);
  const { exec, calls } = fake();
  assert.equal(await findRepoFolder({ exec, seen: seen() }, { machine: "desktop", repo: REPO, folders: ["C:/work/other", "C:/nope"] }), null);
  assert.equal(await findRepoFolder({ exec, seen: seen() }, { machine: "desktop", repo: REPO, folders: [] }), null);
  assert.equal(await findRepoFolder({ exec, seen: seen() }, { machine: "desktop", repo: "", folders: ["C:/work/ws"] }), null);
  assert.equal(calls.length, 1, "no folders or no repo asks nothing");
  const broken = async () => ({ code: 2, stdout: `fr.main=C:/work/ws\nfr.origin=https://github.com/${REPO}\n`, stderr: "" });
  assert.equal(await findRepoFolder({ exec: broken, seen: seen() }, { machine: "desktop", repo: REPO, folders: ["C:/work/ws"] }), null);
  const throws = async () => { throw new Error("gone"); };
  assert.equal(await findRepoFolder({ exec: throws, seen: seen() }, { machine: "desktop", repo: REPO, folders: ["C:/work/ws"] }), null);
});

test("parseFound pairs each main checkout with its origin, CRLF-safe, ignoring other lines", () => {
  assert.deepEqual(parseFound("noise\r\nfr.main=C:/a\r\nfr.origin=git@github.com:o/a.git\r\nfr.main=C:/b\r\nfr.origin=\r\n"),
    [{ mainRoot: "C:/a", remote: "git@github.com:o/a.git" }, { mainRoot: "C:/b", remote: "" }]);
  assert.deepEqual(parseFound("fr.origin=x\n"), []);
  assert.deepEqual(parseFound(undefined), []);
});

test("FIND_SCRIPT, run by a real sh: a worktree's folder gives the main checkout, non-repos give nothing, nothing is written", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "find-")));
  const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  const main = path.join(root, "main"), plain = path.join(root, "plain"), wt = path.join(root, "wt");
  mkdirSync(main); mkdirSync(plain);
  git(main, "init", "-q"); git(main, "remote", "add", "origin", `https://github.com/${REPO}.git`);
  writeFileSync(path.join(main, "f"), "x"); git(main, "add", "f"); git(main, "commit", "-qm", "x"); git(main, "worktree", "add", "-q", "--detach", wt);
  const out = execFileSync("sh", ["-c", FIND_SCRIPT, "github-tasks", plain, wt, path.join(root, "missing"), main], { encoding: "utf8" });
  assert.deepEqual(parseFound(out), [{ mainRoot: main, remote: `https://github.com/${REPO}.git` }, { mainRoot: main, remote: `https://github.com/${REPO}.git` }]);
});

test("bindFlow probes once, caches {os, home} and saves before the deep check, then saves the health", async () => {
  const { exec, calls } = fake();
  const saved = [];
  const r = await bindFlow({ exec, seen: new Map() }, { machine: "desktop", repo: REPO, folders: ["C:/work/ws"], requires: [], now: NOW, onBound: (b) => saved.push(b) });
  assert.equal(r.error, undefined);
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].machine, saved[0].os, saved[0].home, saved[0].health], ["desktop", "windows", "C:/Users/me", null]);
  assert.equal(r.binding.repoRoots[REPO], "C:/work/ws", "prefilled from the space");
  assert.equal(r.binding.health.level, "green");
  assert.equal(r.binding.health.at, NOW);
  assert.equal(probes(calls).filter((c) => c.cmd === GIT_BASH).length, 1, "one Git Bash probe");
  assert.equal(finds(calls).length, 1, "one script looks through the machine's spaces");
  assert.equal(deeps(calls).length, 1, "one deep check script");
  // the deep check got the folder that was just found
  assert.equal(deeps(calls)[0].args[3], "C:/work/ws");
});

test("bindFlow stores nothing but the machine name, os, home and folders", async () => {
  const { exec } = fake();
  const r = await bindFlow({ exec, seen: new Map() }, { machine: "desktop", repo: REPO, folders: [], requires: [], now: NOW });
  assert.deepEqual(Object.keys(r.binding).sort(), ["health", "home", "machine", "os", "repoRoots", "startHere"]);
  assert.doesNotMatch(JSON.stringify(r.binding), /desktop-8d2jtto|athom@/);
});

test("bindFlow with a failing probe stays unbound and says why", async () => {
  const { exec, calls } = fake({ probeFails: true });
  const saved = [];
  const r = await bindFlow({ exec, seen: new Map() }, { machine: "desktop", repo: REPO, folders: [], requires: [], now: NOW, onBound: (b) => saved.push(b) });
  assert.equal(r.binding, null);
  assert.match(r.error, /Couldn't tell what desktop runs/);
  assert.deepEqual(saved, []);
  assert.equal(deeps(calls).length, 0);
});

test("checkFlow runs the deep check once on the cached host (no probe) and saves the health into the binding", async () => {
  const { exec, calls } = fake({ deep: DEEP_OK.replace("dc.mods=same", "dc.mods=differs\r\ndc.mods_count=2") });
  const binding = { machine: "desktop", os: "windows", home: "C:/Users/me", repoRoots: { [REPO]: "C:/work/ws" }, startHere: {}, health: null };
  const r = await checkFlow({ exec, seen: new Map() }, { binding, repo: REPO, folders: [], requires: ["godot"], now: NOW });
  assert.equal(probes(calls).length, 0, "the cached os and home are used, nothing re-probed");
  assert.equal(deeps(calls).length, 1);
  assert.deepEqual(deeps(calls)[0].args.slice(3), ["C:/work/ws", "godot"]);
  assert.equal(r.health.level, "yellow");
  assert.equal(r.health.at, NOW);
  assert.equal(r.repoRoots[REPO], "C:/work/ws");
});

test("checkFlow with no folder yet looks for one in the machine's spaces first, and keeps a folder that is already set", async () => {
  const a = fake();
  const unset = { machine: "desktop", os: "windows", home: "C:/Users/me", repoRoots: {}, startHere: {}, health: null };
  const r = await checkFlow({ exec: a.exec }, { binding: unset, repo: REPO, folders: ["C:/work/ws"], requires: [], now: NOW });
  assert.equal(r.repoRoots[REPO], "C:/work/ws");
  assert.equal(probes(a.calls).length, 0, "checkFlow with no seen map still uses the binding's cached host");
  const b = fake();
  const set = { ...unset, repoRoots: { [REPO]: "C:/typed/path" } };
  await checkFlow({ exec: b.exec, seen: new Map() }, { binding: set, repo: REPO, folders: ["C:/work/ws"], requires: [], now: NOW });
  assert.equal(finds(b.calls).length, 0, "a typed folder is never replaced by a prefill");
  assert.equal(probes(b.calls).length, 0, "and the cached host means no probe");
});

test("a failing deep check is saved as red health, never thrown", async () => {
  const { exec } = fake({ deep: "dc.os=x\r\n" });
  const binding = { machine: "desktop", os: "windows", home: "C:/Users/me", repoRoots: {}, startHere: {}, health: null };
  const r = await checkFlow({ exec, seen: new Map() }, { binding, repo: REPO, folders: [], requires: [], now: NOW });
  assert.equal(r.health.level, "red");
});
