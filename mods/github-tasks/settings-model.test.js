import test from "node:test";
import assert from "node:assert/strict";
import { markdownLiteral, normalizeSettingsSections, promptForRole } from "./settings-model.js";

test("settings sections start collapsed and only saved booleans reopen them", () => {
  const closed = { newTask: false, orchestrator: false, worker: false, reviewer: false };
  assert.deepEqual(normalizeSettingsSections(), closed);
  assert.deepEqual(normalizeSettingsSections(null), closed);
  assert.deepEqual(normalizeSettingsSections({ newTask: true, worker: true }), { ...closed, newTask: true, worker: true });
  assert.deepEqual(normalizeSettingsSections({ newTask: "true", orchestrator: 1, reviewer: false, unknown: true }), closed);
});

test("built-in role prompts use the sample run placeholders", () => {
  for (const role of ["orchestrator", "worker", "reviewer"]) {
    const prompt = promptForRole(role);
    assert.match(prompt, new RegExp(`You are (the |a )?${role}`));
    assert.match(prompt, /<workflow name>/);
    assert.match(prompt, /Ticket: <ticket title> in <owner\/repo>/);
    assert.match(prompt, /<ticket worktree>/);
    assert.match(prompt, /<branch>/);
    assert.doesNotMatch(prompt, /#0 <ticket title>/);
  }
  assert.match(promptForRole("orchestrator"), /<the workflow's planning prompt goes here>/);
  assert.match(promptForRole("worker"), /<the workflow's worker prompt goes here>/);
  assert.match(promptForRole("reviewer"), /<the workflow's reviewer prompt goes here>/);
});

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

test("the New Task prompt waits for the person, grills on acceptance criteria and asks about status", () => {
  const prompt = promptForRole("newTask", { repo: "me/app", project: { title: "Work" }, options: [{ name: "Todo" }, { name: "Up next" }] });
  assert.match(prompt, /me\/app/);
  assert.match(prompt, /acceptance criteria/);
  assert.match(prompt, /"Up next" or "Todo"/);
  assert.match(promptForRole("newTask"), /<project>/);
});
