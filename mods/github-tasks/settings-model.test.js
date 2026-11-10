import test from "node:test";
import assert from "node:assert/strict";
import { markdownLiteral, normalizeSettingsSections, promptForRole } from "./settings-model.js";

test("settings sections start collapsed and only saved booleans reopen them", () => {
  const closed = { newTask: false, orchestrator: false, worker: false, reviewer: false, investigator: false };
  assert.deepEqual(normalizeSettingsSections(), closed);
  assert.deepEqual(normalizeSettingsSections(null), closed);
  assert.deepEqual(normalizeSettingsSections({ newTask: true, worker: true }), { ...closed, newTask: true, worker: true });
  assert.deepEqual(normalizeSettingsSections({ investigator: true }), { ...closed, investigator: true });
  assert.deepEqual(normalizeSettingsSections({ newTask: "true", orchestrator: 1, reviewer: false, unknown: true }), closed);
});

test("built-in role prompts use the sample run placeholders", () => {
  for (const role of ["orchestrator", "worker", "reviewer", "investigator"]) {
    const prompt = promptForRole(role);
    assert.match(prompt, new RegExp(`You are (the |a |an )?${role}`));
    assert.match(prompt, /<workflow name>/);
    assert.match(prompt, /Ticket: <ticket title> in <owner\/repo>/);
    assert.match(prompt, /<ticket worktree>/);
    assert.match(prompt, /<branch>/);
    assert.doesNotMatch(prompt, /#0 <ticket title>/);
  }
  assert.match(promptForRole("orchestrator"), /<the workflow's planning prompt goes here>/);
  assert.match(promptForRole("worker"), /<the workflow's worker prompt goes here>/);
  assert.match(promptForRole("reviewer"), /<the workflow's reviewer prompt goes here>/);
  assert.match(promptForRole("investigator"), /<the workflow's investigator prompt goes here>/);
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

test("the New Task prompt tab shows the local prompt, with a placeholder id, when the repo's tasks are local", () => {
  const prompt = promptForRole("newTask", { local: { mainRoot: "/r/app", todoDir: "/h/t/to-do", upNextDir: "/h/t/up-next" } });
  assert.match(prompt, /\/h\/t\/to-do/);
  assert.match(prompt, /\/h\/t\/up-next/);
  assert.match(prompt, /next id is <next id>/);
  assert.match(prompt, /no `gh` calls/);
  assert.doesNotMatch(promptForRole("newTask", { repo: "me/app" }), /no `gh` calls/);
});

test("the New Task prompt tab names the session folder's spawn commands with a placeholder folder, for GitHub and local tasks", () => {
  for (const prompt of [promptForRole("newTask", { repo: "me/app" }), promptForRole("newTask", { local: { mainRoot: "/r/app", todoDir: "/t", upNextDir: "/u" } })]) {
    assert.match(prompt, /<session folder>\/spawn investigator <name> '<brief>'/);
    assert.match(prompt, /<session folder>\/spawn worker <job> '<brief>'/);
    assert.match(prompt, /never becomes the ticket's work/);
  }
});

test("the New Task investigator and prototype worker prompts have tabs of their own, with placeholders", () => {
  const investigator = promptForRole("newTaskInvestigator");
  assert.match(investigator, /^# You are an investigator/);
  assert.match(investigator, /read-only/);
  assert.match(investigator, /<session worktree>/);
  assert.match(investigator, /<main checkout>/);
  const worker = promptForRole("newTaskWorker");
  assert.match(worker, /^# You are a prototype worker/);
  assert.match(worker, /throwaway prototype/);
  assert.match(worker, /begins with <session worktree>\)/);
  assert.doesNotMatch(worker, /<job>/);
  assert.match(worker, /discarded/);
  assert.notEqual(investigator, promptForRole("investigator"), "not the ticket run's investigator");
  assert.equal(promptForRole("nope"), null);
});

test("the settings sections are unchanged by the sub-agents, which live inside New Task", () => {
  assert.deepEqual(Object.keys(normalizeSettingsSections()), ["newTask", "orchestrator", "worker", "reviewer", "investigator"]);
});
