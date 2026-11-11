import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSettingsSections, promptForRole, SETTINGS_GROUPS, SETTINGS_ENTRIES, groupKey, promptTitle,
} from "./settings-model.js";

const ALL_KEYS = ["group.orchestrators", "group.agents", "newTask", "orchestrator", "refactor", "worker", "reviewer", "investigator"];
const closed = Object.fromEntries(ALL_KEYS.map((k) => [k, false]));

test("the agent sections are grouped: Orchestrators (New Task, Task, Refactor) and Agents (Worker, Reviewer, Investigator)", () => {
  assert.deepEqual(SETTINGS_GROUPS.map((g) => g.label), ["Orchestrators", "Agents"]);
  assert.deepEqual(SETTINGS_GROUPS[0].entries.map((e) => [e.role, e.label]), [["newTask", "New Task"], ["orchestrator", "Task"], ["refactor", "Refactor"]]);
  assert.deepEqual(SETTINGS_GROUPS[1].entries.map((e) => [e.role, e.label]), [["worker", "Worker"], ["reviewer", "Reviewer"], ["investigator", "Investigator"]]);
  assert.deepEqual(SETTINGS_ENTRIES.map((e) => e.role), ["newTask", "orchestrator", "refactor", "worker", "reviewer", "investigator"]);
});

test("an entry never repeats its group's word", () => {
  for (const g of SETTINGS_GROUPS) for (const e of g.entries) {
    assert.doesNotMatch(e.label, /orchestrator|agent/i, e.label);
  }
});

test("only New Task has settings; every other entry opens to a one-line note", () => {
  for (const e of SETTINGS_ENTRIES) {
    if (e.role === "newTask") { assert.equal(e.note, null); continue; }
    assert.ok(e.note && !e.note.includes("\n"), e.role);
  }
  const note = (role) => SETTINGS_ENTRIES.find((e) => e.role === role).note;
  assert.match(note("orchestrator"), /runs a workflow/i);
  assert.match(note("orchestrator"), /plans/);
  assert.match(note("orchestrator"), /Workers, Reviewers and Investigators/);
  assert.match(note("orchestrator"), /decides what to fix/);
  assert.equal(note("refactor"), "Runs a refactor type, and starts Investigators and Workers (prototypes).");
  for (const role of ["worker", "reviewer"]) {
    assert.match(note(role), /Task Orchestrator/);
    assert.match(note(role), /only in workflow runs/);
  }
  assert.match(note("investigator"), /shared read-only agent/);
  assert.match(note("investigator"), /New Task, Task and Refactor Orchestrators can all start it/);
});

test("settings sections start collapsed and only saved booleans reopen them", () => {
  assert.deepEqual(normalizeSettingsSections(), closed);
  assert.deepEqual(normalizeSettingsSections(null), closed);
  assert.deepEqual(normalizeSettingsSections([true]), closed);
  assert.deepEqual(normalizeSettingsSections({ newTask: true, worker: true }), { ...closed, newTask: true, worker: true });
  assert.deepEqual(normalizeSettingsSections({ newTask: "true", orchestrator: 1, reviewer: false, unknown: true }), closed);
});

test("every group and every entry remembers its own open state", () => {
  const saved = Object.fromEntries(ALL_KEYS.map((k) => [k, true]));
  assert.deepEqual(normalizeSettingsSections(saved), saved);
  assert.deepEqual(normalizeSettingsSections({ [groupKey("agents")]: true, refactor: true }), { ...closed, "group.agents": true, refactor: true });
  assert.equal(groupKey("orchestrators"), "group.orchestrators");
});

test("state saved before the grouping still reads: the old four keys keep their value and the new ones start closed", () => {
  const old = { newTask: true, orchestrator: true, worker: false, reviewer: true };
  assert.deepEqual(normalizeSettingsSections(old), { ...closed, newTask: true, orchestrator: true, reviewer: true });
});

test("prompt tab titles name the orchestrators in full", () => {
  assert.equal(promptTitle("newTask"), "New Task Orchestrator prompt");
  assert.equal(promptTitle("orchestrator"), "Task Orchestrator prompt");
  assert.equal(promptTitle("refactor"), "Refactor Orchestrator prompt");
  assert.equal(promptTitle("worker"), "Worker prompt");
  assert.equal(promptTitle("reviewer"), "Reviewer prompt");
  assert.equal(promptTitle("investigator"), "Investigator prompt");
  assert.equal(promptTitle("nope"), "Prompt");
});

test("Refactor opens the real built-in prompt, for a sample refactor type: GitHub's, or the local one when the repo's tasks are local", () => {
  const github = promptForRole("refactor", { repo: "o/app", project: { title: "Board" }, options: [{ name: "Todo" }, { name: "Up Next" }] });
  assert.match(github, /^# You are the Refactor Orchestrator, running the <refactor type name> refactor for o\/app/);
  assert.ok(github.includes("> <the refactor type's orchestrator prompt goes here>"));
  assert.ok(github.includes('"Up Next" or "Todo"'), "the project's own spelling of the statuses");
  assert.ok(github.includes("`<session folder>/spawn investigator <name> '<brief>'`"));
  assert.match(promptForRole("refactor"), /running the <refactor type name> refactor for <repo>/);
  const local = promptForRole("refactor", { local: { mainRoot: "/r/app", todoDir: "/t/to-do", upNextDir: "/t/up-next" } });
  assert.match(local, /^# You are the Refactor Orchestrator, running the <refactor type name> refactor for app/);
  assert.ok(local.includes("`/t/to-do`") && local.includes("The next id is <next id>"));
  assert.ok(local.includes("`<session folder>/spawn worker <job> '<brief>'`"));
  assert.match(local, /Make no `gh` calls/);
});

test("Investigator opens the real read-only investigator prompt", () => {
  assert.match(promptForRole("investigator"), /<the workflow's investigator prompt goes here>/);
});

test("the New Task Orchestrator's helpers' prompt tabs are titled for them", () => {
  assert.equal(promptTitle("newTaskInvestigator"), "New Task investigator prompt");
  assert.equal(promptTitle("newTaskWorker"), "New Task prototype worker prompt");
});

test("built-in role prompts use the sample run placeholders", () => {
  for (const role of ["orchestrator", "worker", "reviewer", "investigator"]) {
    const prompt = promptForRole(role);
    assert.match(prompt, new RegExp(`You are (the Task Orchestrator|an? ${role})`));
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
  assert.deepEqual(Object.keys(normalizeSettingsSections()), ["group.orchestrators", "group.agents", "newTask", "orchestrator", "refactor", "worker", "reviewer", "investigator"]);
});
