import test from "node:test";
import assert from "node:assert/strict";
import { ASK_WITH_TOOL, newTaskPrompt, newTaskStart, refactorPrompt } from "./orchestrator-prompts.js";

test("the shared question-tool sentence says what to do with and without the tool", () => {
  assert.equal(ASK_WITH_TOOL, "Ask each question with your built-in question tool (AskUserQuestion in Claude Code), not as plain text. If you have no such tool, ask in plain text.");
});

test("the New Task prompt asks questions with the built-in question tool, one at a time", () => {
  const text = newTaskPrompt({ repo: "o/r" });
  assert.ok(text.includes(ASK_WITH_TOOL));
  assert.ok(text.includes("Ask one question at a time, say what you would pick and why"));
});

const WAIT_LINE = "Don't do anything yet. Say you are ready and ask the person what they want to make, then wait for their answer.";

test("the New Task prompt with no description still waits for the person", () => {
  const text = newTaskPrompt({ repo: "o/r" });
  assert.ok(text.includes(WAIT_LINE));
  assert.equal(newTaskPrompt({ repo: "o/r", description: "  \n " }), text, "a blank description is none");
});

test("the New Task prompt with a description quotes it in place of the wait line, and has the agent read the code first", () => {
  const text = newTaskPrompt({ repo: "o/r", description: "Add dark mode\n\nto the settings page" });
  assert.ok(!text.includes(WAIT_LINE), "it no longer asks what they want to make");
  assert.ok(!text.includes("ask the person what they want to make"));
  assert.ok(text.includes("> Add dark mode\n>\n> to the settings page"), "every line of it, quoted");
  assert.match(text, /First read the code that is relevant to it/);
  assert.match(text, /Then grill them until the task is well defined/);
});

test("the rest of the New Task prompt is the same with and without a description", () => {
  const without = newTaskPrompt({ repo: "o/r" }).split("\n");
  const withIt = newTaskPrompt({ repo: "o/r", description: "x" }).split("\n");
  const from = (lines) => lines.slice(lines.findIndex((l) => l.startsWith("Then grill them until the task is well defined.")));
  const head = (lines) => lines.slice(0, lines.indexOf("## What to do") + 2);
  assert.deepEqual(head(withIt), head(without));
  assert.deepEqual(from(withIt), from(without));
});

test("a Refactor prompt allows approved changes to existing tickets, not just new tickets", () => {
  const text = refactorPrompt({
    repo: "o/r",
    type: { name: "Clean the backlog", orchestrator: { prompt: "Propose status changes, edits, comments and a new order." } },
  });
  assert.match(text, /change status, edit, comment on or reorder existing tickets/i);
  assert.match(text, /apply only the changes the person approves/i);
  assert.match(text, /## While you work[\s\S]*don't change anything on GitHub: don't create or change any ticket until the person approves that change/i);
});

test("newTaskStart: the typed description is trimmed and left otherwise as typed", () => {
  assert.match(newTaskStart("  fix it  "), /^The person has already said what they want to make:\n\n> fix it\n\n/);
  assert.equal(newTaskStart(undefined), WAIT_LINE);
});
