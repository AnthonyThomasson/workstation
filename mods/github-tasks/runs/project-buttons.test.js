import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseProjectButtons, projectButtonArgv } from "./project-buttons.js";
import { GIT_BASH } from "./remote.js";

// A real shell to run the buttons' argv with: /bin/sh, or Git Bash on Windows (Node there doesn't find /bin/sh). Skipped without one.
const SHELL = process.platform === "win32" ? GIT_BASH : "/bin/sh";
const hasShell = { skip: !existsSync(SHELL) && `no shell at ${SHELL}` };
const why = (r) => r.stderr ?? r.error?.message ?? "";

test("a missing config or no buttons is empty, not an error", () => {
  for (const source of [null, "", "# no config yet\n", "other: true\n", "buttons: []\n"]) {
    assert.deepEqual(parseProjectButtons(source), { buttons: [], errors: [] });
  }
});
test("project buttons read their name and command from the repository config", () => {
  const source = "buttons:\n  - name: Godot\n    command: godot --editor --path .\n  - name: Tests\n    command: npm test\n";
  assert.deepEqual(parseProjectButtons(source), {
    buttons: [{ name: "Godot", command: "godot --editor --path ." }, { name: "Tests", command: "npm test" }],
    errors: [],
  });
});

test("invalid buttons are reported by position while valid buttons are kept", () => {
  const source = "buttons:\n  - name: Godot\n    command: godot --editor --path .\n  - name: No command\n  - command: npm test\n  - name: Tests\n    command: npm test\n";
  assert.deepEqual(parseProjectButtons(source), {
    buttons: [{ name: "Godot", command: "godot --editor --path ." }, { name: "Tests", command: "npm test" }],
    errors: ["Button 2 has no command.", "Button 3 has no name."],
  });
});

test("bad YAML becomes a short error instead of breaking the run page", () => {
  assert.deepEqual(parseProjectButtons("buttons: [\n"), {
    buttons: [],
    errors: ["Invalid YAML: line 1: a [list] is not closed"],
  });
});

test("a project command runs in the user's login shell, which stays open when it ends", () => {
  assert.deepEqual(projectButtonArgv("printf '%s\\n' \"$HOME\"; false", "/bin/zsh"), [
    "/bin/zsh", "-lc", "eval 'printf '\\''%s\\n'\\'' \"$HOME\"; false'; exec '/bin/zsh' -l",
  ]);
  assert.deepEqual(projectButtonArgv("npm test", "/tmp/user's shell"), [
    "/tmp/user's shell", "-lc", "eval 'npm test'; exec '/tmp/user'\\''s shell' -l",
  ]);
});

test("a YAML block command with a trailing newline finishes, then runs the fresh shell", hasShell, () => {
  const { buttons, errors } = parseProjectButtons("buttons:\n  - name: Multiline\n    command: |\n      printf 'command-ran\\n'\n");
  assert.deepEqual(errors, []);
  const argv = projectButtonArgv(buttons[0].command, SHELL);
  const r = spawnSync(argv[0], argv.slice(1), { input: "printf 'shell-ran\\n'\n", encoding: "utf8" });
  assert.equal(r.status, 0, why(r));
  assert.match(r.stdout, /command-ran/);
  assert.match(r.stdout, /shell-ran/);
});

test("a trailing shell comment cannot swallow the fresh shell", hasShell, () => {
  const argv = projectButtonArgv("printf 'command-ran\\n' # comment", SHELL);
  const r = spawnSync(argv[0], argv.slice(1), { input: "printf 'shell-ran\\n'\n", encoding: "utf8" });
  assert.equal(r.status, 0, why(r));
  assert.match(r.stdout, /command-ran/);
  assert.match(r.stdout, /shell-ran/);
});

test("on Windows a button runs through Git Bash (the page passes GIT_BASH as the shell): the command, then a Git Bash login shell", () => {
  const GIT_BASH = "C:/Program Files/Git/bin/bash.exe";
  assert.deepEqual(projectButtonArgv("npm test", GIT_BASH), [GIT_BASH, "-lc", "eval 'npm test'; exec 'C:/Program Files/Git/bin/bash.exe' -l"]);
});
