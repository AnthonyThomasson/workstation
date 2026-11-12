import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parse as parseYaml, refactorPrompt } from "../lib/index.js";
import { blank, normalize, validate } from "./workflow-model.js";
import * as refactor from "./refactor-model.js";
import { WORKFLOW, REFACTOR } from "./kinds.js";

const dir = new URL("../starters/", import.meta.url);
const load = (file) => parseYaml(readFileSync(new URL(file, dir), "utf8"));
const PROMPTS = [["orchestrator", "planning"], ["orchestrator", "retro"], ["orchestrator", "prompt"], ["worker", "prompt"], ["reviewer", "prompt"]];

for (const file of ["bug.yaml", "story.yaml", "bug-kimi.yaml", "story-kimi.yaml"]) {
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
    assert.equal(load(file).orchestrator.retro, "Run `/retro` on this run, then propose follow-up tickets with the question tool and add the ones the person picks to To Do.");
  });

  test(`${file} prompts drive the context with skills, not custom instructions`, () => {
    const data = load(file);
    assert.match(data.orchestrator.retro, /`\/retro`/);
    assert.match(data.worker.prompt, /`\/tdd`/);
    assert.match(data.reviewer.prompt, /`\/code-review`/);
  });
}

const REFACTOR_STARTERS = { "redundant-tests.yaml": "Redundant tests", "architecture.yaml": "Architecture", "isolation.yaml": "Isolation", "clean-the-backlog.yaml": "Clean the backlog" };
const CODE_REFACTOR_STARTERS = ["redundant-tests.yaml", "architecture.yaml", "isolation.yaml"];

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
    assert.ok(orchestrator.prompt.trim());
  });

  test(`${file} is a refactor type, not a workflow: no trigger, reviewer, planning or retro`, () => {
    const data = load(file);
    assert.deepEqual(Object.keys(data), ["version", "id", "name", "orchestrator", "investigator", "worker"]);
    assert.deepEqual(Object.keys(data.orchestrator), ["agent", "command", "model", "effort", "prompt"]);
  });
}

for (const file of CODE_REFACTOR_STARTERS) {
  test(`${file} orchestrator makes no changes itself: the candidates the person keeps become tickets`, () => {
    const { prompt } = refactor.parse(readFileSync(new URL(file, dir), "utf8")).orchestrator;
    assert.match(prompt, /make no changes: once the person picks .*, each becomes a ticket/i);
  });

  test(`${file} worker runs /prototype, commits it and reports that it is discarded`, () => {
    const { prompt } = refactor.parse(readFileSync(new URL(file, dir), "utf8")).worker;
    assert.match(prompt, /`\/prototype`/);
    assert.match(prompt, /commit/i);
    assert.match(prompt, /discarded/);
  });
}

test("the Isolation starter uses the mattpocock-skills:codebase-design skill; Architecture runs /codebase-design and writes an HTML report", () => {
  const { prompt } = refactor.parse(readFileSync(new URL("architecture.yaml", dir), "utf8")).orchestrator;
  assert.match(prompt, /`\/codebase-design`/);
  assert.doesNotMatch(prompt, /`\/improve-codebase-architecture`/);
  assert.match(prompt, /HTML file in the temp directory, never in the repo/);
  const isolation = refactor.parse(readFileSync(new URL("isolation.yaml", dir), "utf8")).orchestrator.prompt;
  assert.match(isolation, /`mattpocock-skills:codebase-design` skill to find deepening opportunities/);
  assert.doesNotMatch(isolation, /`\/improve-codebase-architecture`/);
});

// improve-codebase-architecture and grill-with-docs have model invocation turned off, so a starter names skills the agent can load itself.
test("the Story starters grill with mattpocock-skills:grilling and domain-modeling instead of /grill-with-docs", () => {
  for (const file of ["story.yaml", "story-kimi.yaml"]) {
    const text = readFileSync(new URL(file, dir), "utf8");
    assert.match(text, /`mattpocock-skills:grilling` skill/, file);
    assert.match(text, /`mattpocock-skills:domain-modeling` skill to update GLOSSARY\.md and the ADRs/, file);
    assert.doesNotMatch(text, /`\/grill-with-docs`/, file);
  }
});

test("Clean the backlog reads the whole backlog with gh, uses investigator batches and never a worker", () => {
  const r = refactor.parse(readFileSync(new URL("clean-the-backlog.yaml", dir), "utf8"));
  const { prompt } = r.orchestrator;
  assert.match(prompt, /read every To Do and Up Next ticket with `gh`/i);
  assert.match(prompt, /Up Next tickets are context only/i);
  assert.match(prompt, /never reorder, edit or close Up Next/i);
  assert.match(prompt, /each investigator a batch of To Do tickets/i);
  assert.match(prompt, /against the code and `git log`/i);
  assert.match(prompt, /never start a worker/i);
  assert.match(prompt, /GLOSSARY\.md/);
  assert.match(prompt, /ADRs/);
  assert.match(prompt, /To Do is empty.*say so and stop/is);
  assert.match(prompt, /In Progress, In Review or Done.*never change/is);
  assert.doesNotMatch(readFileSync(new URL("clean-the-backlog.yaml", dir), "utf8"), /`\/(?:to-tickets|triage|domain-modeling|prototype)`/);
});

test("Clean the backlog presents four reasoned proposal groups and applies only multi-selected items in order", () => {
  const { prompt } = refactor.parse(readFileSync(new URL("clean-the-backlog.yaml", dir), "utf8")).orchestrator;
  for (const group of ["Stale tickets", "Merges", "New To Do order", "Up Next picks"]) assert.match(prompt, new RegExp(group));
  assert.match(prompt, /one line of reasoning per item/i);
  assert.match(prompt, /multi-select/i);
  assert.match(prompt, /skip.*group.*no proposals/i);
  assert.match(prompt, /only.*chosen.*merges.*Won't Do.*reorder.*Up Next/is);
  assert.match(prompt, /Up Next picks.*at most 3/i);
  assert.match(prompt, /Focus text.*priority message/i);
  assert.match(prompt, /how it shaped the order/i);
  assert.match(prompt, /no Focus.*impact, dependencies and age/i);
});

test("the generated Clean the backlog prompt refers to Focus without pointing the wrong way", () => {
  const type = refactor.parse(readFileSync(new URL("clean-the-backlog.yaml", dir), "utf8"));
  const text = refactorPrompt({ repo: "o/r", type, focus: "bells and notifications first" });
  assert.doesNotMatch(text, /Focus text above/i);
  const reference = text.indexOf("Focus text");
  const focus = text.indexOf("The person asked you to focus on: bells and notifications first");
  assert.ok(reference >= 0 && focus > reference, "the actual focus follows the starter's position-independent reference");
});

test("Clean the backlog merges and closes stale tickets without deleting issues", () => {
  const { prompt } = refactor.parse(readFileSync(new URL("clean-the-backlog.yaml", dir), "utf8")).orchestrator;
  assert.match(prompt, /most complete ticket.*keep/i);
  assert.match(prompt, /description and checklist.*rewritten.*cover/i);
  assert.match(prompt, /each other ticket.*Won't Do.*Merged into #N/is);
  assert.match(prompt, /stale.*comment.*reason/is);
  assert.match(prompt, /set.*Won't Do.*comment.*`gh issue close .*--reason "not planned"`/is);
  assert.match(prompt, /no Won't Do status.*say so.*don't close anything/is);
  assert.match(prompt, /never delete/i);
});

test("Clean the backlog uses project-position mutations, orders Up Next picks and reports partial failures", () => {
  const { prompt } = refactor.parse(readFileSync(new URL("clean-the-backlog.yaml", dir), "utf8")).orchestrator;
  assert.match(prompt, /updateProjectV2ItemPosition/);
  assert.match(prompt, /`gh api graphql`/);
  assert.match(prompt, /github\/loader\.js.*moveItem/);
  assert.match(prompt, /afterId/);
  assert.match(prompt, /refresh.*Tasks sidebar/i);
  assert.match(prompt, /Status.*Up Next.*order proposed/is);
  assert.match(prompt, /`gh` call fails.*which changes were applied.*which were not.*don't retry blindly/is);
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
  assert.deepEqual(WORKFLOW.starters.map((n) => `${n}.yaml`), ["bug.yaml", "story.yaml", "bug-kimi.yaml", "story-kimi.yaml"]);
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

test("each code refactor starter's worker runs /prototype", () => {
  for (const file of CODE_REFACTOR_STARTERS) assert.match(refactor.parse(readFileSync(new URL(file, dir), "utf8")).worker.prompt, /`\/prototype`/, file);
});

test("a workflow starter is not a valid refactor type: it has no refactor prompt", () => {
  for (const file of ["bug.yaml", "story.yaml"]) assert.ok(refactor.validate(refactor.parse(readFileSync(new URL(file, dir), "utf8"))).length > 0, file);
});
