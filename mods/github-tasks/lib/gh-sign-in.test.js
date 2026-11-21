import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DEVICE_URL, SIGN_IN, SIGN_IN_CLEANUP, SIGN_IN_DEVICE, SIGN_IN_PREPARE, classifyError, preparedFrom, signInFrom, usesDeviceFlow } from "./gh-sign-in.js";

test("reads gh's one-time code and page from its sign-in output", () => {
  const out = "\n! One-time code (AA8B-5FB7) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
  assert.deepEqual(signInFrom(out), { code: "AA8B-5FB7", url: "https://github.com/login/device" });
  assert.deepEqual(signInFrom(""), { code: null, url: null });
  assert.deepEqual(signInFrom("! One-time code (6D7D-8CDC)"), { code: "6D7D-8CDC", url: null });
});

test("names gh's failures", () => {
  assert.equal(classifyError("GraphQL: Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project']"), "no-scope");
  assert.equal(classifyError("To get started with GitHub CLI, please run:  gh auth login"), "no-auth");
  assert.equal(classifyError("HTTP 401: Bad credentials"), "no-auth");
  assert.equal(classifyError("failed to run git: fatal: not a git repository (or any of the parent directories): .git"), "not-a-repo");
  assert.equal(classifyError("no git remotes found"), "not-a-repo");
  assert.equal(classifyError("none of the git remotes configured for this repository point to a known GitHub host"), "not-a-repo");
  assert.equal(classifyError("HTTP 502: Bad gateway"), "other");
  assert.equal(classifyError(undefined), "other");
});

const WRITE_SCOPE_ERROR = "GraphQL: Your token has not been granted the required scopes to execute this query. The 'updateProjectV2ItemFieldValue' field requires one of the following scopes: ['project'], but your token has only been granted the: ['read:project', 'repo'] scopes.";

test("tells a missing write scope from a missing read scope", () => {
  assert.equal(classifyError(WRITE_SCOPE_ERROR), "no-write-scope");
  assert.equal(classifyError("The 'projectsV2' field requires one of the following scopes: ['read:project']"), "no-scope");
});

// The sign-in scripts run for real with a fake gh (and, for Git Bash, a fake cygpath), as auth.js runs them through runs/ shOn.
// The fake gh prints its code like gh does, says which browser it was given, and exits 3.

function runScript(script, args, { cygpath = false, fullPath = cygpath } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sign-in-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "! One-time code (AA8B-5FB7) copied" >&2\necho "args: $*"\necho "browser: ${GH_BROWSER:-none} ${BROWSER:-none}"\nexit 3\n');
  if (cygpath) writeFileSync(join(bin, "cygpath"), '#!/bin/sh\n[ "$1" = -m ] && printf "C:/fake%s\n" "$2"\n');
  for (const f of ["gh", ...(cygpath ? ["cygpath"] : [])]) chmodSync(join(bin, f), 0o755);
  const env = { ...process.env };
  delete env.GH_BROWSER; delete env.BROWSER;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  // fullPath: false keeps Git Bash's own cygpath from being found: only the fake bin and the basics
  env[pathKey] = fullPath ? `${bin}${delimiter}${env[pathKey]}` : `${bin}${delimiter}/usr/bin${delimiter}/bin`;
  return spawnSync("sh", ["-c", script, "github-tasks", ...args], { env, encoding: "utf8" });
}
const waitFor = (path) => { for (let i = 0; i < 200 && !existsSync(path); i++) spawnSync("sleep", ["0.05"]); };
const noGitBash = { skip: process.platform === "win32" && "Git Bash has its own cygpath on the PATH" };

test("the prepare script makes the folder and prints it, then the machine's kernel", noGitBash, () => {
  const r = runScript(SIGN_IN_PREPARE, []);
  assert.equal(r.status, 0, r.stderr);
  const { dir, kernel } = preparedFrom(r.stdout);
  assert.ok(existsSync(dir), dir);
  assert.equal(kernel, spawnSync("uname", ["-s"], { encoding: "utf8" }).stdout.trim());
  assert.equal(runScript(SIGN_IN_CLEANUP, [dir], { fullPath: true }).status, 0);
  assert.equal(existsSync(dir), false);
});

test("on Git Bash the prepare script prints its folder as a Windows path (cygpath -m), which Herdr reads there", () => {
  const r = runScript(SIGN_IN_PREPARE, [], { cygpath: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(preparedFrom(r.stdout).dir, /^C:\/fake\/.+/);
});

test("on the Mac gh runs detached: the script returns at once, and gh's output and exit code land in the folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "sign-in-dir-"));
  const r = runScript(SIGN_IN, [dir, "auth", "refresh", "-s", "project"], { fullPath: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  waitFor(join(dir, "code"));
  assert.equal(readFileSync(join(dir, "code"), "utf8").trim(), "3");
  assert.match(readFileSync(join(dir, "err"), "utf8"), /One-time code \(AA8B-5FB7\)/);
  assert.match(readFileSync(join(dir, "out"), "utf8"), /args: auth refresh -s project\nbrowser: none none/);
});

test("the device flow runs gh in the foreground with a no-op browser, its output and exit code in the folder when it returns", () => {
  const dir = mkdtempSync(join(tmpdir(), "sign-in-dir-"));
  const r = runScript(SIGN_IN_DEVICE, [dir, "auth", "login", "-w"], { fullPath: true });
  assert.equal(r.status, 0, r.stderr);
  // no waiting: the script only ends once gh has, so a held-open exec (hc exec) never outlives it
  assert.equal(readFileSync(join(dir, "code"), "utf8").trim(), "3");
  assert.deepEqual(signInFrom(readFileSync(join(dir, "err"), "utf8")).code, "AA8B-5FB7");
  assert.match(readFileSync(join(dir, "out"), "utf8"), /args: auth login -w\nbrowser: true true/);
});

test("reads the prepare script's folder and kernel, with Windows line ends", () => {
  assert.deepEqual(preparedFrom("C:/Users/me/AppData/Local/Temp/tmp.x\r\nMINGW64_NT-10.0-26200\r\n"), { dir: "C:/Users/me/AppData/Local/Temp/tmp.x", kernel: "MINGW64_NT-10.0-26200" });
  assert.deepEqual(preparedFrom("/tmp/tmp.x\n"), { dir: "/tmp/tmp.x", kernel: "" });
  assert.deepEqual(preparedFrom(""), { dir: "", kernel: "" });
});

test("the device flow is used on another machine or a non-Mac, and the Mac's own sign-in stays the browser here", () => {
  assert.equal(usesDeviceFlow(null, "Darwin"), false);
  assert.equal(usesDeviceFlow(undefined, "Darwin\n"), false);
  assert.equal(usesDeviceFlow("mini", "Darwin"), true); // a Mac, but not this one: its browser isn't where Anthony is
  assert.equal(usesDeviceFlow("desktop", "MINGW64_NT-10.0"), true);
  assert.equal(usesDeviceFlow(null, "MINGW64_NT-10.0"), true);
  assert.equal(usesDeviceFlow(null, "Linux"), true);
  assert.equal(usesDeviceFlow(null, ""), true); // no uname: not known to be a Mac
});

test("the sign-in's scripts take their arguments as $@ and $1, so they run under sh and Git Bash alike", () => {
  assert.match(SIGN_IN, /^d=\$1; shift; .*gh "\$@"/);
  assert.match(SIGN_IN_DEVICE, /^d=\$1; shift; GH_BROWSER=true BROWSER=true .*gh "\$@"/);
  assert.doesNotMatch(SIGN_IN_DEVICE, /&\s*$/);
  assert.match(SIGN_IN_PREPARE, /cygpath -m "\$d"/);
  assert.equal(SIGN_IN_CLEANUP, 'rm -rf "$1"');
  assert.equal(DEVICE_URL, "https://github.com/login/device");
});
