import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSettingsSections, promptForRole } from "./settings-model.js";

test("settings sections start collapsed and only saved booleans reopen them", () => {
  const closed = { grooming: false, orchestrator: false, worker: false, reviewer: false };
  assert.deepEqual(normalizeSettingsSections(), closed);
  assert.deepEqual(normalizeSettingsSections(null), closed);
  assert.deepEqual(normalizeSettingsSections({ grooming: true, worker: true }), { ...closed, grooming: true, worker: true });
  assert.deepEqual(normalizeSettingsSections({ grooming: "true", orchestrator: 1, reviewer: false, unknown: true }), closed);
});

test("the grooming prompt keeps the current repo, project and status spellings", () => {
  const prompt = promptForRole("grooming", {
    repo: "me/app",
    project: { title: "Work" },
    options: [{ name: "Todo" }, { name: "Up next" }],
  });
  assert.match(prompt, /me\/app/);
  assert.match(prompt, /Work/);
  assert.match(prompt, /Todo/);
  assert.match(prompt, /Up next/);
  const empty = promptForRole("grooming");
  assert.match(empty, /<repo>/);
  assert.match(empty, /<project>/);
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
