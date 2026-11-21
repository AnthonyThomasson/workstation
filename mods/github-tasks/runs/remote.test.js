import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { GIT_BASH, gitWhere, hostArgv, hostOf, hostShell, isWindowsKernel, machinePath, parseProbe, probeMachine, remoteProgram, shArgv, shOn } from "./remote.js";
import { shQuote } from "./run.js";

// A fake exec: answers(cmd, args, opts) -> { code, stdout, stderr } or undefined (program not found). Records every call.
function fakeExec(answers) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return answers(cmd, args, opts) ?? { code: 1, stdout: "", stderr: `cannot start ${cmd}: program not found` };
  };
  return { exec, calls };
}
const unixBox = (cmd) => (cmd === "sh" ? { code: 0, stdout: "Linux\n/home/me\n", stderr: "" } : undefined);
const windowsBox = (cmd) => (cmd === GIT_BASH ? { code: 0, stdout: "MINGW64_NT-10.0-26200\r\nC:/Users/me\r\n", stderr: "" } : undefined);

test("Git Bash, MSYS2 and Cygwin are Windows; Linux and Darwin are not", () => {
  for (const k of ["MINGW64_NT-10.0-26200", "MSYS_NT-10.0", "CYGWIN_NT-10.0", "Windows_NT"]) assert.equal(isWindowsKernel(k), true, k);
  for (const k of ["Linux", "Darwin", "FreeBSD", "", null]) assert.equal(isWindowsKernel(k), false, String(k));
});

test("a probe's two lines are read through CRLF, backslashes and a trailing slash", () => {
  assert.deepEqual(parseProbe("Linux\n/home/me/\n"), { kernel: "Linux", home: "/home/me" });
  assert.deepEqual(parseProbe("MINGW64_NT\r\nC:\\Users\\me\r\n"), { kernel: "MINGW64_NT", home: "C:/Users/me" });
  assert.deepEqual(parseProbe(""), { kernel: "", home: "" });
});

test("a script runs with sh -c on Unix and Git Bash -lc on Windows, its arguments after $0", () => {
  assert.deepEqual(shArgv("unix", "echo $1", ["a b"]), ["sh", ["-c", "echo $1", "github-tasks", "a b"]]);
  assert.deepEqual(shArgv("windows", "echo $1", ["a b"]), [GIT_BASH, ["-lc", "echo $1", "github-tasks", "a b"]]);
  assert.equal(GIT_BASH, "C:/Program Files/Git/bin/bash.exe");
});

test("probeMachine: a Unix machine answers through sh, and Git Bash is never asked", async () => {
  const { exec, calls } = fakeExec(unixBox);
  assert.deepEqual(await probeMachine(exec, "vps"), { on: "vps", os: "unix", home: "/home/me" });
  assert.deepEqual(calls.map((c) => [c.cmd, c.opts]), [["sh", { on: "vps" }]]);
});

test("probeMachine: a Windows machine with no sh answers through Git Bash, with its home as C:/…", async () => {
  const { exec, calls } = fakeExec(windowsBox);
  assert.deepEqual(await probeMachine(exec, "desktop"), { on: "desktop", os: "windows", home: "C:/Users/me" });
  assert.deepEqual(calls.map((c) => c.cmd), ["sh", GIT_BASH]);
  assert.equal(calls[1].args[0], "-lc");
  assert.match(calls[1].args[1], /cygpath -m/);
  assert.deepEqual(calls[1].opts, { on: "desktop" });
});

test("probeMachine: a Windows machine with Git's sh on its PATH is still Windows, its home asked through Git Bash", async () => {
  const { exec } = fakeExec((cmd) => (cmd === "sh" ? { code: 0, stdout: "MINGW64_NT-10.0\n/c/Users/me\n", stderr: "" } : windowsBox(cmd)));
  assert.deepEqual(await probeMachine(exec, "desktop"), { on: "desktop", os: "windows", home: "C:/Users/me" });
});

test("probeMachine: a machine that answers neither says why, and exec throwing counts as no answer", async () => {
  const { exec } = fakeExec(() => undefined);
  await assert.rejects(probeMachine(exec, "gone"), /Couldn't tell what gone runs \(sh: cannot start sh: program not found; Git Bash at C:\/Program Files\/Git\/bin\/bash\.exe: cannot start/);
  await assert.rejects(probeMachine(async () => { throw new Error("no such machine"); }, "x"), /sh: no such machine/);
});

test("remoteProgram: the bare name when it runs, else ~/.local/bin (with .exe on Windows), else null", async () => {
  const win = { on: "desktop", os: "windows", home: "C:/Users/me" }, unix = { on: "vps", os: "unix", home: "/home/me" };
  const onPath = fakeExec((cmd) => (cmd === "claude" ? { code: 0, stdout: "2.1", stderr: "" } : undefined));
  assert.equal(await remoteProgram(onPath.exec, win, "claude"), "claude");
  assert.deepEqual(onPath.calls[0], { cmd: "claude", args: ["--version"], opts: { on: "desktop" } });
  const installed = fakeExec((cmd) => (cmd === "C:/Users/me/.local/bin/claude.exe" ? { code: 0, stdout: "2.1", stderr: "" } : undefined));
  assert.equal(await remoteProgram(installed.exec, win, "claude"), "C:/Users/me/.local/bin/claude.exe");
  const unixInstalled = fakeExec((cmd) => (cmd === "/home/me/.local/bin/claude" ? { code: 0, stdout: "2.1", stderr: "" } : undefined));
  assert.equal(await remoteProgram(unixInstalled.exec, unix, "claude"), "/home/me/.local/bin/claude");
  assert.equal(await remoteProgram(fakeExec(() => undefined).exec, win, "claude"), null);
});

test("hostArgv swaps in the machine's program and runs a custom command through Git Bash on Windows", () => {
  const win = { os: "windows" }, unix = { os: "unix" };
  assert.deepEqual(hostArgv(["claude", "--add-dir", "C:/r"], win, "C:/Users/me/.local/bin/claude.exe"), ["C:/Users/me/.local/bin/claude.exe", "--add-dir", "C:/r"]);
  assert.deepEqual(hostArgv(["claude", "--x"], unix), ["claude", "--x"]);
  assert.deepEqual(hostArgv(["sh", "-c", "my agent"], win), [GIT_BASH, "-lc", "my agent"]);
  assert.deepEqual(hostArgv(["sh", "-c", "my agent"], unix), ["sh", "-c", "my agent"]);
});

test("gitWhere: plain git here, hc exec --on there", () => {
  assert.equal(gitWhere(null), "git");
  assert.equal(gitWhere("desktop"), "hc exec --on desktop -- git");
});

test("hostShell: plain git and test here; hc exec --on there, through Git Bash on Windows", () => {
  assert.deepEqual(hostShell(null, shQuote), ["rgit() { git \"$@\"; }", "exists() { [ -e \"$1\" ]; }"]);
  const unix = hostShell({ on: "vps", os: "unix" }, shQuote).join("\n");
  assert.match(unix, /^machine='vps'$/m);
  assert.ok(unix.includes('hc exec --on "$machine" --timeout 600 -- sh -c "$s" github-tasks "$@"'));
  const win = hostShell({ on: "desktop", os: "windows" }, shQuote).join("\n");
  assert.ok(win.includes(`hc exec --on "$machine" --timeout 600 -- 'C:/Program Files/Git/bin/bash.exe' -lc "$s" github-tasks "$@"`));
  assert.ok(!win.includes("-- sh -c"));
});

// The preamble run for real: a fake hc that runs `exec ... -- <cmd>` here, with Git Bash standing for bash (-c, not -lc, so no
// login profile can print into what git says).
function runPreamble(host, body) {
  const dir = mkdtempSync(join(tmpdir(), "remote-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "log");
  writeFileSync(join(bin, "hc"), `#!/bin/sh
printf '%s\\n' "$*" >> ${shQuote(log)}
[ "$1" = exec ] || exit 0
shift; while [ "$1" != -- ]; do shift; done; shift
if [ "$1" = ${shQuote(GIT_BASH)} ]; then shift; shift; set -- bash -c "$@"; fi
exec "$@"
`);
  chmodSync(join(bin, "hc"), 0o755);
  mkdirSync(join(dir, "it's here")); // a quote and a space, to be sure the arguments go through whole
  const script = join(dir, "s");
  writeFileSync(script, `#!/bin/sh\n${hostShell(host, shQuote).join("\n")}\n${body}\n`);
  chmodSync(script, 0o755);
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH"; // Path on Windows: never two of them
  env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ""}`;
  env.D = dir.replace(/\\/g, "/"); // the folder as git sees it: /tmp/… here, C:/… on Windows (as a run's paths there are)
  const r = spawnSync("sh", [script], { env, encoding: "utf8", cwd: dir });
  let calls = "";
  try { calls = readFileSync(log, "utf8"); } catch { /* no hc call */ }
  return { ...r, dir, calls };
}

for (const host of [null, { on: "vps", os: "unix" }, { on: "desktop", os: "windows" }]) {
  test(`hostShell run for real (${host?.os ?? "here"}): rgit passes its arguments whole, exists tells a path that is there from one that isn't`, () => {
    const r = runPreamble(host, `rgit -C "$D/it's here" init -q && echo git=ok; exists "$D/it's here/.git" && echo there; exists "$D/nope" || echo absent`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "", r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n"), ["git=ok", "there", "absent"]);
    if (host) assert.match(r.calls, new RegExp(`^exec --on ${host.on} --timeout 600 -- `, "m"));
  });
}

test("shOn: here it is plain sh with no probe and no machine", async () => {
  const { exec, calls } = fakeExec(() => ({ code: 0, stdout: "ok", stderr: "" }));
  let probed = 0;
  const r = await shOn({ exec, probe: async () => { probed++; return { os: "windows" }; }, seen: new Map() }, null, "echo $1", ["x"]);
  assert.equal(r.stdout, "ok");
  assert.equal(probed, 0);
  assert.deepEqual(calls, [{ cmd: "sh", args: ["-c", "echo $1", "github-tasks", "x"], opts: undefined }]);
});

test("shOn: on a Windows machine it runs Git Bash -lc, probing the machine once for any number of calls", async () => {
  const { exec, calls } = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }));
  let probed = 0;
  const deps = { exec, probe: async (_e, on) => { probed++; return { on, os: "windows", home: "C:/Users/me" }; }, seen: new Map() };
  await shOn(deps, "desktop", "a", ["1"]);
  await shOn(deps, "desktop", "b", []);
  assert.equal(probed, 1);
  assert.deepEqual(calls, [
    { cmd: GIT_BASH, args: ["-lc", "a", "github-tasks", "1"], opts: { on: "desktop" } },
    { cmd: GIT_BASH, args: ["-lc", "b", "github-tasks"], opts: { on: "desktop" } },
  ]);
});

test("shOn: on a Unix machine it runs sh -c there; a probe that fails resolves as a failed command, with the reason", async () => {
  const { exec, calls } = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }));
  await shOn({ exec, probe: async (_e, on) => ({ on, os: "unix", home: "/home/me" }), seen: new Map() }, "vps", "a");
  assert.deepEqual(calls, [{ cmd: "sh", args: ["-c", "a", "github-tasks"], opts: { on: "vps" } }]);
  const r = await shOn({ exec, probe: async () => { throw new Error("Couldn't tell what gone runs"); }, seen: new Map() }, "gone", "a");
  assert.deepEqual(r, { code: 1, stdout: "", stderr: "Couldn't tell what gone runs" });
  assert.equal(calls.length, 1); // nothing ran on a machine it couldn't place
});

test("hostOf: a machine is probed once and its host kept; a probe that fails is not kept, so the next call asks again", async () => {
  let probed = 0;
  let up = false;
  const deps = { exec: async () => ({}), probe: async (_e, on) => { probed++; if (!up) throw new Error(`${on} is off`); return { on, os: "windows", home: "C:/Users/me" }; }, seen: new Map() };
  await assert.rejects(hostOf(deps, "desktop"), /desktop is off/);
  up = true;
  assert.deepEqual(await hostOf(deps, "desktop"), { on: "desktop", os: "windows", home: "C:/Users/me" });
  await hostOf(deps, "desktop");
  assert.equal(probed, 2);
});

test("hostOf and shOn share what they found: a host found for a start is the one shOn's scripts run as", async () => {
  const { exec, calls } = fakeExec(windowsBox);
  const deps = { exec, seen: new Map() };
  assert.equal((await hostOf(deps, "desktop")).os, "windows");
  const probes = calls.length;
  await shOn(deps, "desktop", 'mkdir -p "$1"', ["C:/Users/me/run"]);
  assert.equal(calls.length, probes + 1); // no second probe
  assert.deepEqual(calls.at(-1), { cmd: GIT_BASH, args: ["-lc", 'mkdir -p "$1"', "github-tasks", "C:/Users/me/run"], opts: { on: "desktop" } });
});

// machinePath run for real: a fake cygpath stands in for Git Bash's, and with none the path is printed as it is.
function printed(ref, { cygpath }) {
  const dir = mkdtempSync(join(tmpdir(), "machine-path-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  if (cygpath) { writeFileSync(join(bin, "cygpath"), '#!/bin/sh\n[ "$1" = -m ] && printf "C:/msys64%s\n" "$2"\n'); chmodSync(join(bin, "cygpath"), 0o755); }
  const env = { ...process.env, D: "/tmp/tmp.x" };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = cygpath ? `${bin}${delimiter}${env[pathKey]}` : `${bin}${delimiter}/usr/bin${delimiter}/bin`;
  return spawnSync("sh", ["-c", machinePath(ref)], { env, encoding: "utf8" });
}

test("machinePath prints a Git Bash path as Windows names it (cygpath -m), so Herdr's file calls find it there", () => {
  const r = printed('"$D"', { cygpath: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "C:/msys64/tmp/tmp.x\n");
});

test("machinePath prints a path as it is where there is no cygpath (any Unix)", { skip: process.platform === "win32" && "Git Bash has its own cygpath on the PATH" }, () => {
  const r = printed('"$D"', { cygpath: false });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "/tmp/tmp.x\n");
});

test("machinePath is the snippet the Windows probe and the sign-in use, its argument kept quoted", () => {
  assert.equal(machinePath('"$HOME"'), `if command -v cygpath >/dev/null 2>&1; then cygpath -m "$HOME"; else printf '%s\\n' "$HOME"; fi`);
});

test("shOn passes a timeout through to exec, beside on; without one exec gets exactly what it did before", async () => {
  const { exec, calls } = fakeExec((cmd) => (cmd === "sh" || cmd === GIT_BASH ? { code: 0, stdout: "", stderr: "" } : undefined));
  const deps = { exec, probe: async (_e, on) => ({ on, os: "windows", home: "C:/Users/me" }), seen: new Map() };
  await shOn(deps, "desktop", "a", ["1"], { timeout: 600000 });
  assert.deepEqual(calls.at(-1), { cmd: GIT_BASH, args: ["-lc", "a", "github-tasks", "1"], opts: { on: "desktop", timeout: 600000 } });
  await shOn(deps, "desktop", "b");
  assert.deepEqual(calls.at(-1).opts, { on: "desktop" });
  await shOn(deps, null, "c", [], { timeout: 5000 });
  assert.deepEqual(calls.at(-1), { cmd: "sh", args: ["-c", "c", "github-tasks"], opts: { timeout: 5000 } });
  await shOn(deps, null, "d");
  assert.equal(calls.at(-1).opts, undefined); // here, no options at all, as before
});
