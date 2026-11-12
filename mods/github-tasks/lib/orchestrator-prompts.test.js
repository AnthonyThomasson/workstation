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
  assert.match(text, /Then work through these steps/);
});

test("the rest of the New Task prompt is the same with and without a description", () => {
  const without = newTaskPrompt({ repo: "o/r" }).split("\n");
  const withIt = newTaskPrompt({ repo: "o/r", description: "x" }).split("\n");
  const from = (lines) => lines.slice(lines.findIndex((l) => l.startsWith("Then work through these steps.")));
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

// ---- The New Task prompt follows mattpocock-skills' to-tickets ----------------------------------------------

const NT = newTaskPrompt({ repo: "o/r", project: { title: "Board" }, groomed: "Up next", backlog: "Todo" });
const at = (needle) => {
  const i = NT.indexOf(needle);
  assert.ok(i >= 0, `missing: ${needle}`);
  return i;
};

test("the New Task prompt gathers context first: a referenced issue in full, the glossary, ADRs and .out-of-scope", () => {
  assert.match(NT, /gh issue view <n> --comments/);
  assert.match(NT, /GLOSSARY\.md, its ADRs and `\.out-of-scope\/`/);
  assert.ok(at("1. Gather context") < at("2. Explore the code") && at("2. Explore the code") < at("3. Grill the person"));
  assert.match(NT, /read-only/);
  assert.match(NT, /a prefactor you find becomes its own first ticket, which blocks the rest/);
});

test("the New Task prompt grills only on what it can't look up, one question at a time with a recommended answer", () => {
  assert.match(NT, /Grill the person only on what you can't find out yourself\. Ask one question at a time, say what you would pick and why/);
  assert.ok(NT.includes(ASK_WITH_TOOL));
});

test("the New Task prompt drafts tracer-bullet tickets that fit one workflow run, expand/migrate/contract for wide refactors", () => {
  assert.match(NT, /tracer bullets: each a thin vertical slice through every layer/);
  assert.match(NT, /one Herdr workflow run/);
  assert.match(NT, /only the tickets that genuinely gate it/);
  assert.match(NT, /expand, migrate, contract/);
  assert.match(NT, /contract ticket blocked by every batch/);
});

test("the New Task prompt checks overlap against the board's statuses as the project spells them and .out-of-scope", () => {
  assert.match(NT, /a duplicate in "Todo" or "Up next", a match in "Won't Do", or a match in `\.out-of-scope\/`/);
});

test("the New Task breakdown lists Blocked by, Ready to start and a plain-text dependency graph, in dependency order", () => {
  for (const field of ["**Title**", "**What it delivers**", "**Acceptance criteria**", "**Blocked by**", "**Ready to start**: yes when it has no open blockers"]) at(field);
  assert.match(NT, /numbered list in dependency order, blockers first/);
  assert.match(NT, /dependency graph as plain text: one edge per line, blocker first \(`1 → 2`/);
  assert.match(NT, /granularity is right[\s\S]*each blocking edge is right[\s\S]*merged or split/);
  assert.match(NT, /until the person approves it/);
});

test("the New Task prompt recommends the groomed status for ready tickets and the backlog for blocked ones", () => {
  assert.match(NT, /recommend "Up next" for a ticket that is ready to start and "Todo" for a blocked one/);
});

test("the New Task prompt creates nothing before yes, then creates blockers first with native dependencies", () => {
  assert.ok(at("8. Ask which status") < at("## Creating the tickets, once the person says yes"), "asked before creating");
  assert.ok(at("## Creating the tickets") < at("## While you work"));
  assert.match(NT, /## While you work\n\n- Don't create anything until the person says to\./);
  assert.match(NT, /Don't write code\./);
  assert.match(NT, /Create them in dependency order, blockers first/);
  assert.ok(at("blockers first, so every blocker has an issue number") < at("dependencies/blocked_by"));
  assert.ok(NT.includes("`gh api --method POST repos/o/r/issues/<n>/dependencies/blocked_by -F issue_id=<blocker database id>`"));
  assert.ok(NT.includes("`gh api repos/o/r/issues/<blocker> --jq .id`"), "the blocker's database id, not its number");
  assert.match(NT, /When that fails, put a `Blocked by: #<blocker>` line at the top/);
  assert.match(NT, /Stop at the first create that fails/);
  assert.match(NT, /Create the tickets on the GitHub Project "Board" with the status they chose/);
});

test("the New Task ticket body is to-tickets' issue template; sub-issues of a source issue, which is never changed", () => {
  const parent = at("`## Parent`"), what = at("`## What to build`"), criteria = at("`## Acceptance criteria` as a `- [ ]` checklist"), blocked = at("`## Blocked by`");
  assert.ok(parent < what && what < criteria && criteria < blocked);
  assert.match(NT, /no file paths or code, except a decision-rich snippet from a prototype/);
  assert.ok(NT.includes("`gh issue create --parent <n>`"));
  assert.match(NT, /Never close, edit or comment on the parent/);
});

test("the New Task prompt writes no HTML report: the generic report system is a sketch only", () => {
  assert.doesNotMatch(NT, /\.html|REPORT\.md|render\.mjs|schema\.json/);
});
