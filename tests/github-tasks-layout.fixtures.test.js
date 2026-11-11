// The layout checker's own test: runs tests/github-tasks-layout.test.js's checkLayout on the small mod trees under
// tests/fixtures/github-tasks-layout/ (one tree that passes, one tree per rule that fails) and asserts the exact set of
// file:line failures, then runs the script itself to check its exit code. Run with: node --test tests/github-tasks-layout.fixtures.test.js
// Name the file: a bare `node --test tests/` would also execute the fixtures' own *.test.js, which are only meant to be parsed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLayout } from "./github-tasks-layout.test.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "github-tasks-layout");
const SCRIPT = path.join(HERE, "github-tasks-layout.test.js");
const got = (tree) => checkLayout(path.join(FIXTURES, tree)).map((f) => `${f.file}${f.line ? `:${f.line}` : ""} ${f.rule}`);

// tree -> file:line [rule] for each line of each tree that must fail (a folder-level failure has no line)
const EXPECTED = {
  // an import from outside a folder into anything but its index.js: from main.js, from another folder, from a test; index.js is fine
  "deep-import": ["github/g.test.js:1 deep-import", "github/index.js:1 deep-import", "main.js:1 deep-import"],
  // a file importing its own folder's index.js, code and test alike (the test's own sibling imports are fine)
  "self-index": ["lib/model.js:1 self-index", "lib/model.test.js:1 self-index"],
  // up the stack: a lower folder importing a higher one, and a folder importing prompts-page.js
  "direction": ["lib/a.js:1 direction", "lib/a.js:2 direction"],
  // two folders of one tier importing each other's index.js (editor and settings)
  "sibling": ["editor/index.js:1 sibling"],
  // anything importing main.js: code and test
  "imports-main": ["lib/a.test.js:1 imports-main", "lib/index.js:1 imports-main"],
  // two folders importing each other: reported once, at the first import; the upward edge also breaks the direction rule
  "cycle": ["github/index.js:1 cycle", "lib/index.js:1 direction"],
  // a folder with code and no index.js
  "no-index": ["lib no-index"],
  // a .js file at the top level other than main.js and prompts-page.js, test files included
  "top-level-file": ["model.js:1 top-level-file", "model.test.js:1 top-level-file"],
  // a folder with code that is not in the table (a folder with no .js is not flagged)
  "unknown-folder": ["extras unknown-folder"],
  // an import() whose path is a template with a hole can't be followed; a plain one can
  "dynamic": ["lib/index.js:2 dynamic-import"],
  // not valid JavaScript
  "parse": ["lib/index.js:1 parse"],
};

for (const [tree, expected] of Object.entries(EXPECTED)) {
  test(`reports exactly the expected failures on ${tree}/`, () => {
    assert.deepEqual(got(tree), expected);
  });
}

test("reports nothing for the passing tree", () => {
  // every kind of allowed import: main.js into folders and prompts-page.js, down the stack, within a folder, index re-exports,
  // import(), a test through a folder's index.js, bare and node: specifiers, data folders (icons, starters) with no index.js
  assert.deepEqual(got("pass"), []);
});

test("running the script exits 0 on a passing tree and 1 with sorted file:line output on a failing one", () => {
  const run = (tree) => spawnSync(process.execPath, [SCRIPT, path.join(FIXTURES, tree)], { encoding: "utf8" });
  const ok = run("pass");
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^ok: /);
  const bad = run("direction");
  assert.equal(bad.status, 1);
  const lines = bad.stdout.split("\n").filter((l) => l.includes("[direction]"));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /direction\/lib\/a\.js:1 {2}\[direction\]/);
  assert.match(lines[1], /direction\/lib\/a\.js:2 {2}\[direction\]/);
});

test("a folder that is in the table but absent is fine, and a missing mod folder exits 1", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "layout-"));
  try {
    assert.deepEqual(checkLayout(empty), []);
  } finally { rmSync(empty, { recursive: true, force: true }); }
  const r = spawnSync(process.execPath, [SCRIPT, path.join(FIXTURES, "nope")], { encoding: "utf8" });
  assert.equal(r.status, 1);
});
