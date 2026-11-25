import test from "node:test";
import assert from "node:assert/strict";
import { GIT_BASH, localOs, shArgv, shellArgv, toolArgv } from "./shell.js";

test("this computer is Windows only when Herdr's window says so; macOS, Linux and no window are Unix", () => {
  assert.equal(localOs("windows"), "windows");
  for (const p of ["macos", "linux", undefined, null, ""]) assert.equal(localOs(p), "unix", String(p));
});

test("a script runs as sh -c on Unix and Git Bash -lc on Windows, $1… being its args", () => {
  assert.equal(GIT_BASH, "C:/Program Files/Git/bin/bash.exe");
  assert.deepEqual(shArgv("unix", "echo $1", ["a b"]), ["sh", ["-c", "echo $1", "github-tasks", "a b"]]);
  assert.deepEqual(shArgv("windows", "echo $1", ["a b"]), [GIT_BASH, ["-lc", "echo $1", "github-tasks", "a b"]]);
  assert.deepEqual(shArgv(undefined, "x"), ["sh", ["-c", "x", "github-tasks"]]);
});

test("a Unix tool runs as itself on Unix, exactly as before, and through Git Bash's exec on Windows", () => {
  assert.deepEqual(toolArgv("unix", "mv", ["-f", "a", "b"]), ["mv", ["-f", "a", "b"]]);
  assert.deepEqual(toolArgv(undefined, "rm", ["-rf", "/x"]), ["rm", ["-rf", "/x"]]);
  assert.deepEqual(toolArgv("windows", "mkdir", ["-p", "C:/Users/me/run"]), [GIT_BASH, ["-lc", 'exec "$@"', "github-tasks", "mkdir", "-p", "C:/Users/me/run"]]);
  assert.deepEqual(toolArgv("windows", "chmod"), [GIT_BASH, ["-lc", 'exec "$@"', "github-tasks", "chmod"]]);
});

test("a sh -c terminal argv goes through Git Bash on Windows; any other argv, or another OS, is left as it is", () => {
  const custom = ["sh", "-c", "my agent --go"];
  assert.deepEqual(shellArgv(custom, "windows"), [GIT_BASH, "-lc", "my agent --go"]);
  assert.equal(shellArgv(custom, "unix"), custom);
  assert.equal(shellArgv(custom, undefined), custom);
  const claude = ["claude", "--model", "opus"];
  assert.equal(shellArgv(claude, "windows"), claude);
  const long = ["sh", "-c", "x", "extra"];
  assert.equal(shellArgv(long, "windows"), long);
});

test("on Unix the tool argv still runs the tool: the Windows form's exec \"$@\" runs it with its arguments untouched", { skip: process.platform === "win32" && "sh is Git Bash's here" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const [, args] = toolArgv("windows", "printf", ["%s|", "a b", "c"]);
  const r = spawnSync("sh", ["-c", ...args.slice(1)], { encoding: "utf8" });
  assert.equal(r.stdout, "a b|c|");
});
