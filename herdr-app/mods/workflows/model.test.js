import test from "node:test";
import assert from "node:assert/strict";
import { blank, normalize, validate, slug, snapshot, isDirty, serialize, parse, ROLES, EFFORTS, AGENTS, STRATEGIES } from "./model.js";

const valid = (over = {}) => {
  const w = blank();
  w.name = "Feature work";
  w.trigger.label = "workflow:feature";
  for (const role of ROLES) w[role].prompt = `${role} prompt`;
  return { ...w, ...over };
};

test("slug makes a file name from a name", () => {
  assert.equal(slug("Feature development!"), "feature-development");
  assert.equal(slug("  --A  b--  "), "a-b");
  assert.equal(slug("Café Ünïcode"), "cafe-unicode");
  assert.equal(slug("!!!"), "");
  assert.equal(slug(undefined), "");
});

test("a blank workflow has every role with a default agent and effort", () => {
  const w = blank();
  for (const role of ROLES) assert.deepEqual(w[role], { prompt: "", agent: "claude", model: "", effort: "medium" });
  assert.deepEqual(w.trigger, { label: "" });
  assert.equal(w.global, false);
  assert.equal(w.strategy, "branch");
});

test("the work strategy is a branch or a worktree, and an older file without one is a branch", () => {
  assert.deepEqual(STRATEGIES, ["branch", "worktree"]);
  assert.equal(normalize({}).strategy, "branch");
  assert.equal(normalize({ strategy: "worktree" }).strategy, "worktree");
  assert.equal(normalize({ strategy: 7 }).strategy, "branch");
  assert.equal(parse(JSON.stringify({ name: "Old" })).strategy, "branch");
});

test("an unknown work strategy is a problem, and the two real ones are not", () => {
  assert.deepEqual(validate(valid({ strategy: "worktree" })), []);
  assert.deepEqual(validate(valid({ strategy: "branch" })), []);
  assert.deepEqual(validate(valid({ strategy: "fork" })).map((p) => p.field), ["strategy"]);
});

test("changing the strategy makes a workflow dirty", () => {
  const base = valid();
  assert.equal(isDirty(base, { ...base, strategy: "worktree" }), true);
});

test("the agent and effort lists hold what Herdr and the editor offer", () => {
  assert.ok(AGENTS.includes("claude") && AGENTS.includes("codex") && AGENTS.includes("kimi"));
  assert.deepEqual(EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(new Set(AGENTS).size, AGENTS.length);
});

test("normalize survives junk and keeps an agent it does not know", () => {
  const w = normalize({ name: "  X ", global: "yes", trigger: "nope", worker: { agent: "newagent", model: " m ", effort: 3 }, orchestrator: null });
  assert.equal(w.name, "X");
  assert.equal(w.global, false); // only a real true counts
  assert.equal(w.trigger.label, "");
  assert.equal(w.worker.agent, "newagent");
  assert.equal(w.worker.model, "m");
  assert.equal(w.worker.effort, "medium");
  assert.deepEqual(w.orchestrator, { prompt: "", agent: "claude", model: "", effort: "medium" });
  assert.deepEqual(normalize(null), normalize({}));
});

test("a complete workflow has no problems", () => {
  assert.deepEqual(validate(valid()), []);
});

test("validate names each missing piece", () => {
  const fields = validate(blank()).map((p) => p.field);
  assert.deepEqual(fields, ["name", "trigger", "orchestrator.prompt", "worker.prompt", "reviewer.prompt"]);
});

test("validate rejects a whitespace prompt, an empty agent and an unknown effort", () => {
  const w = valid();
  w.worker.prompt = "   ";
  w.reviewer.agent = "";
  w.orchestrator.effort = "extreme";
  const fields = validate(w).map((p) => p.field);
  // an empty agent normalizes to the default, so only the prompt and the effort are wrong
  assert.deepEqual(fields.sort(), ["orchestrator.effort", "worker.prompt"]);
});

test("a name needs a letter or a number, and a new one cannot take another's id", () => {
  assert.equal(validate(valid({ name: "!!!" }))[0].field, "name");
  assert.equal(validate(valid(), ["feature-work"])[0].message, "A workflow with that name already exists.");
  // an existing workflow keeps its id, so its own id being taken is fine
  assert.deepEqual(validate(valid({ id: "feature-work" }), ["feature-work"]), []);
});

test("dirty tracking sees edits and ignores shape noise", () => {
  const base = valid();
  assert.equal(isDirty(base, JSON.parse(JSON.stringify(base))), false);
  assert.equal(isDirty(base, { ...base, name: "Other" }), true);
  const edited = valid(); edited.worker.effort = "high";
  assert.equal(isDirty(base, edited), true);
  assert.equal(isDirty({ ...base, extra: 1 }, base), false);
  assert.equal(snapshot(base), snapshot(normalize(base)));
});

test("serialize and parse round-trip, in a fixed key order", () => {
  const w = valid({ id: "feature-work", global: true, strategy: "worktree" });
  const text = serialize(w);
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(Object.keys(JSON.parse(text)), ["version", "id", "name", "global", "strategy", "trigger", "orchestrator", "worker", "reviewer"]);
  assert.deepEqual(Object.keys(JSON.parse(text).worker), ["prompt", "agent", "model", "effort"]);
  assert.deepEqual(parse(text), normalize(w));
});

test("parse rejects what is not a workflow", () => {
  assert.throws(() => parse("{nope"), /not valid JSON/);
  assert.throws(() => parse("[]"), /not a workflow object/);
  assert.throws(() => parse("null"), /not a workflow object/);
});
