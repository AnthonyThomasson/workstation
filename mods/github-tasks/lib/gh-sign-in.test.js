import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { SIGN_IN, SIGN_IN_CLEANUP, classifyError, signInFrom } from "./gh-sign-in.js";

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

// The sign-in script run for real with a fake gh (and, for Git Bash, a fake cygpath), as auth.js runs it through runs/ shOn.

function runScript(script, args, { cygpath = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sign-in-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "! One-time code (AA8B-5FB7) copied" >&2\necho "args: $*"\nexit 3\n');
  if (cygpath) writeFileSync(join(bin, "cygpath"), '#!/bin/sh\n[ "$1" = -m ] && printf "C:/fake%s\n" "$2"\n');
  for (const f of ["gh", ...(cygpath ? ["cygpath"] : [])]) chmodSync(join(bin, f), 0o755);
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  // without a fake cygpath, one of Git Bash's own must not be found either: only the fake bin and the basics
  env[pathKey] = cygpath ? `${bin}${delimiter}${env[pathKey]}` : `${bin}${delimiter}/usr/bin${delimiter}/bin`;
  return spawnSync("sh", ["-c", script, "github-tasks", ...args], { env, encoding: "utf8" });
}
const waitFor = (path) => { for (let i = 0; i < 200 && !existsSync(path); i++) spawnSync("sleep", ["0.05"]); };

test("the sign-in prints its folder at once, and gh's output and exit code land in it", { skip: process.platform === "win32" && "Git Bash has its own cygpath on the PATH" }, () => {
  const r = runScript(SIGN_IN, ["auth", "refresh", "-s", "project"]);
  assert.equal(r.status, 0, r.stderr);
  const dir = r.stdout.trim();
  assert.ok(existsSync(dir), dir);
  waitFor(join(dir, "code"));
  assert.equal(readFileSync(join(dir, "code"), "utf8").trim(), "3");
  assert.match(readFileSync(join(dir, "err"), "utf8"), /One-time code \(AA8B-5FB7\)/);
  assert.equal(readFileSync(join(dir, "out"), "utf8").trim(), "args: auth refresh -s project");
  assert.equal(runScript(SIGN_IN_CLEANUP, [dir]).status, 0);
  assert.equal(existsSync(dir), false);
});

test("on Git Bash the sign-in prints its folder as a Windows path (cygpath -m), which Herdr reads there", () => {
  const r = runScript(SIGN_IN, ["auth", "login"], { cygpath: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^C:\/fake\/.+/);
});

test("the sign-in's scripts take their arguments as $@ and $1, so they run under sh and Git Bash alike", () => {
  assert.match(SIGN_IN, /gh "\$@"/);
  assert.match(SIGN_IN, /cygpath -m "\$d"/);
  assert.equal(SIGN_IN_CLEANUP, 'rm -rf "$1"');
});
