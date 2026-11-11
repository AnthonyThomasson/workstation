// The layout checker's own test: runs tests/github-tasks-layout.test.js's checkLayout, with a fake table of its own (not the real
// folder names: those change), on the small mod trees under tests/fixtures/github-tasks-layout/ (one tree that passes, one tree
// per rule that fails) and asserts the exact set of
// file:line failures, then runs the script itself to check its exit code. Run with: node --test tests/github-tasks-layout.fixtures.test.js
// Name the file: a bare `node --test tests/` would also execute the fixtures' own *.test.js, which are only meant to be parsed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLayout } from "./github-tasks-layout.test.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "github-tasks-layout");
const SCRIPT = path.join(HERE, "github-tasks-layout.test.js");
// The fixtures' table: ui-a, ui-b and ui-c share the top tier; core is pure.
const LAYOUT = {
  top: ["main.js", "shell.js"],
  entry: "main.js",
  data: ["icons", "starters"],
  tiers: [["ui-a", "ui-b", "ui-c"], ["feature"], ["service"], ["domain"], ["adapter"], ["core"]],
  pure: ["core"],
};
const got = (tree) => checkLayout(path.join(FIXTURES, tree), LAYOUT).map((f) => `${f.file}${f.line ? `:${f.line}` : ""} ${f.rule}`);

// tree -> file:line [rule] for each line of each tree that must fail (a folder-level failure has no line)
const EXPECTED = {
  // an import from outside a folder into anything but its index.js: from main.js, from another folder, from a test; index.js is fine
  "deep-import": ["adapter/g.test.js:1 deep-import", "adapter/index.js:1 deep-import", "main.js:1 deep-import"],
  // a file importing its own folder's index.js, code and test alike (the test's own sibling imports are fine)
  "self-index": ["core/model.js:1 self-index", "core/model.test.js:1 self-index"],
  // up the stack: a lower folder importing a higher one, and a folder importing a top file (shell.js)
  "direction": ["core/a.js:1 direction", "core/a.js:2 direction"],
  // two folders of one tier importing each other's index.js (ui-a and ui-b)
  "sibling": ["ui-a/index.js:1 sibling"],
  // anything importing main.js: code and test
  "imports-main": ["core/a.test.js:1 imports-main", "core/index.js:1 imports-main"],
  // two folders importing each other: reported once, at the first import; the upward edge also breaks the direction rule
  "cycle": ["adapter/index.js:1 cycle", "core/index.js:1 direction"],
  // a folder with code and no index.js
  "no-index": ["core no-index"],
  // a .js file at the top level other than main.js and shell.js, test files included
  "top-level-file": ["model.js:1 top-level-file", "model.test.js:1 top-level-file"],
  // a folder with code that is not in the table (a folder with no .js is not flagged)
  "unknown-folder": ["extras unknown-folder"],
  // an import() whose path is a template with a hole can't be followed; a plain one can
  "dynamic": ["core/index.js:2 dynamic-import"],
  // a pure folder (core) importing herdr, gpui-kit or gpui-base: import, export-from, export *, import(), in a test too; a folder
  // that is not pure (adapter) may, and node: modules are fine
  "pure-import": ["core/index.js:1 pure-import", "core/index.js:3 pure-import", "core/view.js:1 pure-import", "core/view.js:2 pure-import", "core/view.test.js:3 pure-import"],
  // not valid JavaScript
  "parse": ["core/index.js:1 parse"],
};

for (const [tree, expected] of Object.entries(EXPECTED)) {
  test(`reports exactly the expected failures on ${tree}/`, () => {
    assert.deepEqual(got(tree), expected);
  });
}

test("reports nothing for the passing tree", () => {
  // every kind of allowed import: main.js into folders and shell.js, down the stack, within a folder, index re-exports,
  // import(), a test through a folder's index.js, bare and node: specifiers, data folders (icons, starters) with no index.js
  assert.deepEqual(got("pass"), []);
});

// The script itself uses the real table, so these use trees that fail or pass whatever the table says: an empty mod, and a mod with
// stray top-level files (b.js written before a.js, to see the output sorted).
test("running the script exits 0 on a passing tree and 1 with sorted file:line output on a failing one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "layout-"));
  try {
    const run = () => spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    const ok = run();
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /^ok: /);
    writeFileSync(path.join(dir, "b.js"), "export default 1;\n");
    writeFileSync(path.join(dir, "a.js"), "export default 1;\n");
    const bad = run();
    assert.equal(bad.status, 1);
    const lines = bad.stdout.split("\n").filter((l) => l.includes("[top-level-file]"));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /a\.js:1 {2}\[top-level-file\]/);
    assert.match(lines[1], /b\.js:1 {2}\[top-level-file\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a folder that is in the table but absent is fine, and a missing mod folder exits 1", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "layout-"));
  try {
    assert.deepEqual(checkLayout(empty, LAYOUT), []);
  } finally { rmSync(empty, { recursive: true, force: true }); }
  const r = spawnSync(process.execPath, [SCRIPT, path.join(FIXTURES, "nope")], { encoding: "utf8" });
  assert.equal(r.status, 1);
});
