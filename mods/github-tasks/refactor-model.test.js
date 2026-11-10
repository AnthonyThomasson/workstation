import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "./yaml.js";
import * as wf from "./workflow-model.js";
import {
  VERSION, ROLES, ROLE_LABELS, AGENTS, CUSTOM, EFFORTS, SCOPES, SCOPE_LABELS, SCOPE_HINTS, slug,
  blank, normalize, validate, snapshot, isDirty, serialize, parse,
} from "./refactor-model.js";

const valid = (over = {}) => {
  const r = blank();
  r.name = "Redundant tests";
  r.orchestrator.prompt = "Find duplicate tests.";
  return { ...r, ...over };
};

test("a refactor type has an orchestrator and an investigator, labelled for people", () => {
  assert.equal(VERSION, 1);
  assert.deepEqual(ROLES, ["orchestrator", "investigator"]);
  assert.deepEqual(ROLE_LABELS, { orchestrator: "Orchestrator", investigator: "Investigator" });
  assert.deepEqual(Object.keys(blank()), ["version", "id", "name", "orchestrator", "investigator"]);
});

test("it shares the workflow helpers instead of copying them", () => {
  assert.equal(slug, wf.slug);
  assert.equal(AGENTS, wf.AGENTS);
  assert.equal(CUSTOM, wf.CUSTOM);
  assert.equal(SCOPES, wf.SCOPES);
  assert.equal(SCOPE_LABELS, wf.SCOPE_LABELS);
  assert.deepEqual(EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
});

test("the scope hints name the refactors folders", () => {
  assert.match(SCOPE_HINTS.global, /~\/\.config\/herdr-app\/refactors/);
  assert.match(SCOPE_HINTS.repo, /\.herdr\/refactors/);
  assert.deepEqual(Object.keys(SCOPE_HINTS), SCOPES);
});

test("normalize survives junk, keeps an unknown agent, and has no trigger, permissions, planning or retro", () => {
  const r = normalize({ name: "  X ", investigator: { agent: "newagent", model: " m ", effort: 3, permissions: "ask" }, orchestrator: null, trigger: { labels: ["a"] } });
  assert.equal(r.name, "X");
  assert.equal(r.investigator.agent, "newagent");
  assert.equal(r.investigator.model, "m");
  assert.equal(r.investigator.effort, "medium");
  assert.deepEqual(r.orchestrator, { prompt: "", agent: "claude", command: "", model: "", effort: "medium" });
  assert.deepEqual(Object.keys(r.investigator).sort(), ["agent", "command", "effort", "model", "prompt"]);
  assert.equal("trigger" in r, false);
  assert.deepEqual(normalize(null), normalize({}));
});

test("a complete refactor type has no problems; the investigator prompt is optional", () => {
  assert.deepEqual(validate(valid()), []);
  assert.equal(valid().investigator.prompt, "");
});

test("a refactor type needs a name and an orchestrator prompt", () => {
  assert.deepEqual(validate(blank()), [
    { field: "name", message: "Give the refactor a name." },
    { field: "orchestrator.prompt", message: "Give the refactor a prompt." },
  ]);
  assert.deepEqual(validate(valid({ orchestrator: { ...valid().orchestrator, prompt: "  \n " } })).map((p) => p.message), ["Give the refactor a prompt."]);
});

test("a name needs a letter or a number, and a new one cannot take another's id", () => {
  assert.equal(validate(valid({ name: "!!!" }))[0].message, "The name needs a letter or a number.");
  assert.deepEqual(validate(valid(), ["redundant-tests"]).map((p) => p.field), ["name"]);
  assert.deepEqual(validate(valid({ id: "redundant-tests" }), ["redundant-tests"]), []); // an existing one keeps its own id
  assert.deepEqual(validate(valid(), ["other"]), []);
});

test("agents, custom commands and efforts are checked as for workflows", () => {
  const r = valid();
  r.orchestrator.effort = "extreme";
  r.investigator.agent = CUSTOM;
  assert.deepEqual(validate(r).map((p) => p.field), ["orchestrator.effort", "investigator.command"]);
  r.investigator.command = "my-agent --go";
  r.orchestrator.effort = "max";
  assert.deepEqual(validate(r), []);
});

test("only a custom agent keeps a command", () => {
  assert.equal(normalize({ investigator: { agent: "claude", command: "x" } }).investigator.command, "");
  assert.equal(normalize({ investigator: { agent: CUSTOM, command: " x " } }).investigator.command, "x");
});

test("dirty tracking sees edits and ignores shape noise", () => {
  const base = valid({ id: "redundant-tests" });
  assert.equal(isDirty(base, { ...base, junk: 1 }), false);
  assert.equal(snapshot(base), snapshot(normalize(base)));
  const edited = structuredClone(base);
  edited.investigator.prompt = "Look wide.";
  assert.equal(isDirty(base, edited), true);
  const renamed = structuredClone(base);
  renamed.orchestrator.model = "opus";
  assert.equal(isDirty(base, renamed), true);
});

test("serialize and parse round-trip, in a fixed key order with settings before prompts", () => {
  const r = valid({ id: "redundant-tests" });
  r.investigator.prompt = "Report what you find.";
  const text = serialize(r);
  assert.ok(text.endsWith("\n") && !text.startsWith("{"));
  const data = parseYaml(text);
  assert.deepEqual(Object.keys(data), ["version", "id", "name", "orchestrator", "investigator"]);
  assert.deepEqual(Object.keys(data.orchestrator), ["agent", "command", "model", "effort", "prompt"]);
  assert.deepEqual(Object.keys(data.investigator), ["agent", "command", "model", "effort", "prompt"]);
  assert.deepEqual(parse(text), normalize(r));
});

test("parse rejects what is not a refactor type", () => {
  assert.throws(() => parse("{nope"), /not valid JSON/);
  assert.throws(() => parse("- a"), /not a refactor object/);
  assert.throws(() => parse("nope"), /not valid YAML/);
  assert.throws(() => parse(""), /not a refactor object/);
});

test("a workflow's own parse still says workflow", () => {
  assert.throws(() => wf.parse("- a"), /not a workflow object/);
});
