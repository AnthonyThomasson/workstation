// The checker's own test: runs tests/mod-isolation.test.js's checkMods on tests/fixtures/mods/ (a fake mods/ tree with
// one bad case per rule, a clean mod, and a clean mod that reads legacy keys) and asserts the exact set of file:line
// failures. Run with: node --test tests/mod-isolation.fixtures.test.js
// Name the file: a bare `node --test tests/` would also execute the fixtures' own *.test.js, which are only meant to be parsed.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkMods } from "./mod-isolation.test.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mods");

// file:line [rule]: what the fixture line is
const EXPECTED = [
  // imports: into another mod, export-from, a dynamic import that can't be followed (own.js's import is fine)
  "alpha/imports.js:1 import",
  "alpha/imports.js:2 import",
  "alpha/imports.js:4 import",
  // file paths: another real mod, in a template, an unknown name, a name built at run time, no trailing slash
  "alpha/paths.js:1 file-path",
  "alpha/paths.js:2 file-path",
  "alpha/paths.js:3 file-path",
  "alpha/paths.js:6 file-path",
  "alpha/paths.js:7 file-path",
  // own.js and helper.js are not *.test.js, so they are mod code even though only the test imports helper.js: fake names fail too
  "alpha/own.js:1 file-path",
  "alpha/helper.js:1 file-path",
  "alpha/helper.js:2 file-path",
  // overlays: another mod, an unknown name, one found through popup(), a spread object, an unknown value
  "alpha/overlays.js:5 overlay",
  "alpha/overlays.js:6 overlay",
  "alpha/overlays.js:7 overlay",
  "alpha/overlays.js:9 overlay",
  "alpha/overlays.js:10 overlay",
  // shared keys: wrong prefix through consts / imports / re-exports / namespace, can't be followed, missing key
  "alpha/state.js:10 shared-key",
  "alpha/state.js:12 shared-key",
  "alpha/state.js:14 shared-key",
  "alpha/state.js:16 shared-key",
  "alpha/state.js:19 shared-key",
  "alpha/state.js:20 shared-key",
  "alpha/state.js:21 shared-key",
  "alpha/state.js:23 shared-key",
  "alpha/state.js:24 shared-key",
  "alpha/state.js:25 shared-key",
  // pass-through wrappers and positional arguments, followed into the same mod's function
  "alpha/channel.js:5 shared-key",
  "alpha/channel.js:8 shared-key",
  "alpha/migrate.js:5 shared-key",
  // bare references to shared: exported object, handed to a function outside the mod, alias called with a bad key
  "alpha/bare.js:3 shared-key",
  "alpha/bare.js:4 shared-key",
  "alpha/bare.js:6 shared-key",
  "alpha/broken.js:1 parse",
  // shared/setShared reached any way but a plain named import: re-exports, h["shared"], an alias of the namespace, a destructured
  // namespace, the default import, import("herdr"). Plain calls through them are followed; anything else can't be, so it fails.
  "alpha/reexport-herdr.js:1 shared-key",
  "alpha/reexport-herdr.js:2 shared-key",
  "alpha/reexport-herdr.js:3 shared-key",
  "alpha/herdr-namespace.js:2 shared-key",
  "alpha/herdr-namespace.js:3 shared-key",
  "alpha/herdr-namespace.js:5 shared-key",
  "alpha/herdr-namespace.js:7 shared-key",
  "alpha/herdr-default.js:2 shared-key",
  "alpha/herdr-dynamic.js:1 shared-key",
  // a parameter's default is not what it holds: each call site's argument is (a call site that isn't a list written out fails)
  "alpha/loops.js:3 shared-key",
  "alpha/loops.js:9 shared-key",
  // openOverlay found through aliases (as, const, a namespace, an object), a computed "mod" key, an unresolvable computed key
  "alpha/overlay-aliases.js:3 overlay",
  "alpha/overlay-aliases.js:5 overlay",
  "alpha/overlay-aliases.js:6 overlay",
  "alpha/overlay-aliases.js:7 overlay",
  "alpha/overlay-aliases.js:8 overlay",
  "alpha/overlay-aliases.js:10 overlay",
  // a mods/ path built at run time in mod code: "mods/" + name, ${"mods"}/beta, "mods" + "/beta" (join("mods", x) is fine)
  "alpha/run-time-paths.js:2 file-path",
  "alpha/run-time-paths.js:3 file-path",
  "alpha/run-time-paths.js:4 file-path",
  // the line is where the matched text is: inside a multi-line template, after a line continuation, in the template's second part
  "alpha/multiline.js:2 file-path",
  "alpha/multiline.js:5 file-path",
  "alpha/multiline.js:7 file-path",
  // shared-key and overlay report the line of the offending argument or property, not of the call
  "alpha/args.js:3 shared-key",
  "alpha/args.js:7 overlay",
  // scan scope: a dot-folder is scanned, symlinked files and folders fail, absolute and file: imports fail
  ".dot/a.js:1 file-path",
  "alpha/linked.js:1 symlink",
  "alpha/linkdir:1 symlink",
  "alpha/absolute.js:1 import",
  "alpha/absolute.js:2 import",
  "alpha/absolute.js:3 import",
  // *.test.js: only real mods fail; "demo" and "skillshare.x" pass
  "alpha/fake.test.js:2 import",
  "alpha/fake.test.js:6 file-path",
  "alpha/fake.test.js:9 overlay",
  "alpha/fake.test.js:11 shared-key",
];

test("reports exactly the expected failures on the fixtures", () => {
  const got = checkMods(root).map((f) => `${f.file}:${f.line} ${f.rule}`);
  assert.deepEqual(got, [...EXPECTED].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).sort(byFileLine));
});

test("reports nothing for the clean mods", () => {
  const got = checkMods(root).filter((f) => f.file.startsWith("clean/") || f.file.startsWith("skills/") || f.file.startsWith("beta/"));
  assert.deepEqual(got, []);
});

test("gives the same answer twice", () => {
  assert.deepEqual(checkMods(root), checkMods(root));
});

// The checker sorts by file, then numeric line.
function byFileLine(a, b) {
  const [fa, la] = a.split(" ")[0].split(":"), [fb, lb] = b.split(" ")[0].split(":");
  return fa < fb ? -1 : fa > fb ? 1 : Number(la) - Number(lb);
}
