import test from "node:test";
import assert from "node:assert/strict";
import { parseProjectButtons, projectButtonArgv } from "./project-buttons.js";

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
    "/bin/zsh", "-lc", "printf '%s\\n' \"$HOME\"; false; exec '/bin/zsh' -l",
  ]);
  assert.deepEqual(projectButtonArgv("npm test", "/tmp/user's shell"), [
    "/tmp/user's shell", "-lc", "npm test; exec '/tmp/user'\\''s shell' -l",
  ]);
});
