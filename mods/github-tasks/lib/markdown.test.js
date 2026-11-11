import test from "node:test";
import assert from "node:assert/strict";
import { markdownLiteral } from "./markdown.js";

test("Markdown-ready prompts keep placeholders visible and leave code untouched", () => {
  const source = [
    "Ticket <ticket title>: <workflow name>, <repo>, <project>.",
    "Inline `<branch>` stays unchanged.",
    "```sh",
    "printf '%s\\n' '<run folder>'",
    "```",
  ].join("\n");
  assert.equal(markdownLiteral(source), [
    "Ticket \\<ticket title>: \\<workflow name>, \\<repo>, \\<project>.",
    "Inline `<branch>` stays unchanged.",
    "```sh",
    "printf '%s\\n' '<run folder>'",
    "```",
  ].join("\n"));
});
