import test from "node:test";
import assert from "node:assert/strict";
import { parse, stringify } from "./yaml.js";

test("strings of every shape survive a round-trip", () => {
  const strings = ["", " ", "a", "true", "123", "a: b", "x #y", "line1\nline2", "line1\nline2\n", "a\n\nb\n\n\n", "\n\nx", "  lead\nx", "tab\there", 'quote"s', "ünï", "- dash", "a\r\nb", "trail ", "\n"];
  for (const s of strings) {
    const doc = { a: { k: s, l: [s, "x"] }, n: 1, b: true, e: [] };
    assert.deepEqual(parse(stringify(doc)), doc, JSON.stringify(s));
  }
});

test("a long prompt is written as a readable block", () => {
  const text = stringify({ name: "F", worker: { prompt: "Do it\n\nthen more\n" } });
  assert.match(text, /prompt: \|\n {4}Do it\n\n {4}then more\n/);
});

test("hand-written YAML reads: comments, quotes, folded blocks, flow lists", () => {
  const doc = parse("# note\nname: 'It''s'  # x\nlist:\n- a\n- \"b\"\nf: >\n  one\n  two\n\n  three\nk: [x, y]\n");
  assert.deepEqual(doc, { name: "It's", list: ["a", "b"], f: "one two\nthree\n", k: ["x", "y"] });
});

test("bad YAML says which line", () => {
  assert.throws(() => parse("a: 1\nb\n"), /line 2/);
  assert.throws(() => parse("a: 1\na: 2\n"), /written twice/);
  assert.throws(() => parse("a:\n\tb: 1\n"), /tabs/);
});
