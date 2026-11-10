import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parse as parseYaml } from "./yaml.js";
import { blank, normalize, validate } from "./workflow-model.js";
import * as refactor from "./refactor-model.js";
import { WORKFLOW, REFACTOR } from "./kinds.js";

const dir = new URL("./starters/", import.meta.url);
const load = (file) => parseYaml(readFileSync(new URL(file, dir), "utf8"));
const PROMPTS = [["orchestrator", "planning"], ["orchestrator", "retro"], ["orchestrator", "prompt"], ["worker", "prompt"], ["reviewer", "prompt"]];

for (const file of ["bug.yaml", "story.yaml"]) {
  test(`${file} passes the workflow model with no problems`, () => {
    const data = load(file);
    assert.deepEqual(validate(normalize(data)), []);
    assert.equal(normalize(data).id, data.id);
  });

  test(`${file} has no investigator section and loads with the investigator defaults`, () => {
    const data = load(file);
    assert.equal("investigator" in data, false);
    assert.deepEqual(normalize(data).investigator, blank().investigator);
  });

  test(`${file} retro proposes follow-up tickets with the question tool and adds the picked ones to To Do`, () => {
    assert.equal(load(file).orchestrator.retro, "Look back on what slowed the run and what to write down for next time, then propose follow-up tickets with the question tool and add the ones the person picks to To Do.");
  });

  test(`${file} prompts do not mention a skill`, () => {
    const data = load(file);
    for (const [role, key] of PROMPTS) assert.doesNotMatch(data[role][key], /skill|mattpocock/i, `${file} ${role}.${key}`);
  });
}

const REFACTOR_STARTERS = { "redundant-tests.yaml": "Redundant tests", "architecture.yaml": "Architecture", "isolation.yaml": "Isolation" };

for (const [file, name] of Object.entries(REFACTOR_STARTERS)) {
  test(`${file} parses and validates as a refactor type, id and name matching`, () => {
    const text = readFileSync(new URL(file, dir), "utf8"), r = refactor.parse(text);
    assert.deepEqual(refactor.validate(r), []);
    assert.equal(r.name, name);
    assert.equal(r.id, refactor.slug(name));
    assert.equal(`${r.id}.yaml`, file);
    assert.equal(r.version, 1);
  });

  test(`${file} runs a Claude opus/high orchestrator, a sonnet/medium investigator and a sonnet/high prototype worker`, () => {
    const { orchestrator, investigator, worker } = refactor.parse(readFileSync(new URL(file, dir), "utf8"));
    assert.deepEqual([orchestrator.agent, orchestrator.model, orchestrator.effort], ["claude", "opus", "high"]);
    assert.deepEqual([investigator.agent, investigator.model, investigator.effort], ["claude", "sonnet", "medium"]);
    assert.deepEqual([worker.agent, worker.model, worker.effort], ["claude", "sonnet", "high"]);
    assert.match(worker.prompt, /throwaway prototype/);
    assert.match(worker.prompt, /commit/i);
    assert.match(worker.prompt, /discarded/);
    assert.ok(orchestrator.prompt.trim());
  });

  test(`${file} orchestrator makes no changes itself: the candidates the person keeps become tickets`, () => {
    const { prompt } = refactor.parse(readFileSync(new URL(file, dir), "utf8")).orchestrator;
    assert.match(prompt, /make no changes: once the person picks .*, each becomes a ticket/i);
  });

  test(`${file} is a refactor type, not a workflow: no trigger, reviewer, planning or retro`, () => {
    const data = load(file);
    assert.deepEqual(Object.keys(data), ["version", "id", "name", "orchestrator", "investigator", "worker"]);
    assert.deepEqual(Object.keys(data.orchestrator), ["agent", "command", "model", "effort", "prompt"]);
  });
}

test("the Architecture starter follows the improve-codebase-architecture approach, with no HTML report", () => {
  const { prompt } = refactor.parse(readFileSync(new URL("architecture.yaml", dir), "utf8")).orchestrator;
  for (const word of ["git log", "shallow", "seam", "locality", "deletion test", "Strong", "Worth exploring", "Speculative"]) assert.match(prompt, new RegExp(word, "i"));
  assert.match(prompt, /do not write an html report/i);
});

test("each kind's starter display names match the starters' names, in order", () => {
  for (const kind of [WORKFLOW, REFACTOR]) {
    const names = kind.starters.map((n) => kind.model.parse(readFileSync(new URL(`${n}.yaml`, dir), "utf8")).name);
    assert.deepEqual(kind.labels.starterNames, names);
  }
});

test("each kind carries its own change signal and list/editor wording", () => {
  assert.equal(WORKFLOW.changed, "github-tasks.workflows.changed");
  assert.equal(REFACTOR.changed, "github-tasks.refactors.changed");
  assert.deepEqual([WORKFLOW.labels.listTitle, WORKFLOW.labels.newLabel, WORKFLOW.labels.emptyText], ["Workflows", "New workflow", "No workflows yet. Make one with New workflow."]);
  assert.deepEqual([REFACTOR.labels.listTitle, REFACTOR.labels.newLabel, REFACTOR.labels.emptyText], ["Refactors", "New refactor", "No refactor types yet. Make one with New refactor."]);
  assert.equal(WORKFLOW.labels.editorNoun, "workflow");
  assert.equal(REFACTOR.labels.editorNoun, "refactor type");
});

test("each kind lists exactly its own starters, and together they are every file in starters/", () => {
  assert.deepEqual(WORKFLOW.starters.map((n) => `${n}.yaml`), ["bug.yaml", "story.yaml"]);
  assert.deepEqual(REFACTOR.starters.map((n) => `${n}.yaml`), Object.keys(REFACTOR_STARTERS));
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  assert.deepEqual(files, [...WORKFLOW.starters, ...REFACTOR.starters].map((n) => `${n}.yaml`).sort());
});

test("the redundant-tests starter verifies in a scratch copy and never edits the person's tree", () => {
  const { prompt } = refactor.parse(readFileSync(new URL("redundant-tests.yaml", dir), "utf8")).orchestrator;
  assert.match(prompt, /scratch copy/i);
  assert.match(prompt, /never delete or skip a test in the person's own tree/i);
  assert.doesNotMatch(prompt, /delete or skip each proposed test/i);
});

test("no starter names the skill it was inspired by", () => {
  for (const file of Object.keys(REFACTOR_STARTERS)) assert.doesNotMatch(readFileSync(new URL(file, dir), "utf8"), /mattpocock|improve-codebase/i, file);
});

test("a workflow starter is not a valid refactor type: it has no refactor prompt", () => {
  for (const file of ["bug.yaml", "story.yaml"]) assert.ok(refactor.validate(refactor.parse(readFileSync(new URL(file, dir), "utf8"))).length > 0, file);
});
