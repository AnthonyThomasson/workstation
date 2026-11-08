import test from "node:test";
import { EFFORTS } from "./model.js";
import { parse as parseYaml } from "./yaml.js";
import assert from "node:assert/strict";
import { blank, normalize, validate, slug, snapshot, isDirty, serialize, parse, uniqueLabels, ROLES, PERMISSIONS, PERMISSION_LABELS, PERMISSION_HINTS, AGENTS, CUSTOM, AGENT_LABELS, MATCHES, SCOPES, SCOPE_LABELS, SCOPE_HINTS, isFallback } from "./workflow-model.js";

const valid = (over = {}) => {
  const w = blank();
  w.name = "Feature work";
  w.trigger.labels = ["workflow:feature"];
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
  const role0 = { prompt: "", agent: "claude", command: "", model: "", effort: "medium" };
  for (const role of ROLES) assert.deepEqual(w[role], role === "orchestrator" ? { ...role0, planning: "", retro: "" } : { ...role0, permissions: "auto" });
  assert.deepEqual(w.trigger, { labels: [], match: "any" });
  assert.equal("global" in w, false); // where it is kept is the folder's business
  assert.equal("strategy" in w, false);
});

test("a file that still has a strategy loads, ignores it, and drops it on the next save", () => {
  assert.equal("strategy" in normalize({ strategy: "worktree" }), false);
  assert.equal("strategy" in parse(JSON.stringify({ name: "Old", strategy: "branch" })), false);
  assert.deepEqual(validate(valid({ strategy: "fork" })), []);
  assert.equal(/strategy/.test(serialize(valid({ strategy: "worktree" }))), false);
  assert.equal(isDirty(valid(), { ...valid(), strategy: "worktree" }), false);
});

test("worker and reviewer permissions default to auto and only ask overrides that default", () => {
  for (const role of ["worker", "reviewer"]) {
    assert.equal(blank()[role].permissions, "auto");
    assert.equal(normalize({})[role].permissions, "auto");
    assert.equal(normalize({ [role]: { permissions: "ask" } })[role].permissions, "ask");
    assert.equal(normalize({ [role]: { permissions: "invalid" } })[role].permissions, "auto");
  }
  assert.equal(normalize({ orchestrator: { permissions: "ask" } }).orchestrator.permissions, undefined);
});

test("the editor offers Auto and Ask with Claude-specific worker and reviewer hints", () => {
  assert.deepEqual(PERMISSIONS, ["auto", "ask"]);
  assert.deepEqual(PERMISSION_LABELS, { auto: "Auto", ask: "Ask" });
  for (const role of ["worker", "reviewer"]) {
    assert.match(PERMISSION_HINTS[role], /Auto: runs commands without asking/);
    assert.match(PERMISSION_HINTS[role], /Ask: asks before each shell command/);
    assert.match(PERMISSION_HINTS[role], /Claude/);
  }
  assert.match(PERMISSION_HINTS.reviewer, /edits are always refused/i);
});

test("worker and reviewer permissions survive a save and make the workflow dirty when changed", () => {
  const base = valid();
  const edited = { ...base, worker: { ...base.worker, permissions: "ask" }, reviewer: { ...base.reviewer, permissions: "ask" } };
  assert.equal(isDirty(base, edited), true);
  const saved = parseYaml(serialize(edited));
  assert.equal(saved.worker.permissions, "ask");
  assert.equal(saved.reviewer.permissions, "ask");
  assert.equal(saved.orchestrator.permissions, undefined);
  assert.deepEqual(parse(serialize(edited)), normalize(edited));
});

test("a file that still has testing or tests loads, ignores them, and drops them on the next save", () => {
  const base = valid();
  const old = { ...base, worker: { ...base.worker, testing: "npm test" }, reviewer: { ...base.reviewer, tests: "node --test" } };
  const loaded = normalize(old);
  assert.equal("testing" in loaded.worker, false);
  assert.equal("tests" in loaded.reviewer, false);
  assert.deepEqual(validate(old), []);
  const saved = parseYaml(serialize(old));
  assert.equal("testing" in saved.worker, false);
  assert.equal("tests" in saved.reviewer, false);
  assert.equal(isDirty(base, old), false);
});

test("the agent and effort lists hold what Herdr and the editor offer", () => {
  assert.ok(AGENTS.includes("claude") && AGENTS.includes("codex") && AGENTS.includes("kimi"));
  assert.deepEqual(EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(new Set(AGENTS).size, AGENTS.length);
});

test("normalize survives junk and keeps an agent it does not know", () => {
  const w = normalize({ name: "  X ", trigger: "nope", worker: { agent: "newagent", model: " m ", effort: 3 }, orchestrator: null });
  assert.equal(w.name, "X");
  assert.deepEqual(w.trigger, { labels: [], match: "any" });
  assert.equal(w.worker.agent, "newagent");
  assert.equal(w.worker.model, "m");
  assert.equal(w.worker.effort, "medium");
  assert.deepEqual(w.orchestrator, { prompt: "", agent: "claude", command: "", model: "", effort: "medium", planning: "", retro: "" });
  assert.deepEqual(normalize(null), normalize({}));
});

test("a workflow with no trigger labels is valid, and is the fallback", () => {
  const w = valid();
  w.trigger.labels = [];
  assert.deepEqual(validate(w), []);
  assert.equal(isFallback(w), true);
  assert.equal(isFallback(valid()), false);
  assert.deepEqual(parseYaml(serialize(w)).trigger, { labels: [], match: "any" });
  assert.equal(isFallback(parse(serialize(w))), true);
});

test("a complete workflow has no problems", () => {
  assert.deepEqual(validate(valid()), []);
});

test("validate names each missing piece", () => {
  const fields = validate(blank()).map((p) => p.field);
  assert.deepEqual(fields, ["name"]); // empty prompts are fine
});

test("validate accepts empty prompts, and rejects an unknown effort", () => {
  const w = valid();
  w.worker.prompt = "   ";
  w.reviewer.agent = "";
  w.orchestrator.effort = "extreme";
  const fields = validate(w).map((p) => p.field);
  // an empty agent normalizes to the default, so only the prompt and the effort are wrong
  assert.deepEqual(fields.sort(), ["orchestrator.effort"]);
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

test("the orchestrator's planning and retro prompts are optional and survive a round-trip", () => {
  const w = valid({ id: "x" });
  assert.deepEqual(validate(w), []);
  w.orchestrator.planning = "Plan it";
  w.orchestrator.retro = "Look back";
  const back = parse(serialize(w));
  assert.equal(back.orchestrator.planning, "Plan it");
  assert.equal(back.orchestrator.retro, "Look back");
  assert.equal(back.worker.planning, undefined);
});

test("serialize and parse round-trip, in a fixed key order", () => {
  const w = valid({ id: "feature-work" });
  const text = serialize(w);
  assert.ok(text.endsWith("\n") && !text.startsWith("{"));
  assert.deepEqual(Object.keys(parseYaml(text)), ["version", "id", "name", "trigger", "orchestrator", "worker", "reviewer"]);
  assert.deepEqual(Object.keys(parseYaml(text).orchestrator), ["agent", "command", "model", "effort", "prompt", "planning", "retro"]);
  assert.deepEqual(Object.keys(parseYaml(text).worker), ["agent", "command", "model", "effort", "permissions", "prompt"]);
  assert.deepEqual(parse(text), normalize(w));
});

test("parse rejects what is not a workflow", () => {
  assert.throws(() => parse("{nope"), /not valid JSON/);
  assert.throws(() => parse("- a"), /not a workflow object/);
  assert.throws(() => parse("nope"), /not valid YAML/);
  assert.throws(() => parse(""), /not a workflow object/);
});

test("a custom agent carries the command that opens it", () => {
  assert.equal(CUSTOM, "custom");
  assert.ok(!AGENTS.includes(CUSTOM)); // it is not a Herdr kind
  assert.equal(AGENT_LABELS[CUSTOM], "Custom command");
  const w = normalize({ worker: { agent: "custom", command: "  my-agent --fast  " } });
  assert.equal(w.worker.agent, "custom");
  assert.equal(w.worker.command, "my-agent --fast");
});

test("only a custom agent keeps a command; switching away drops it", () => {
  assert.equal(normalize({ worker: { agent: "codex", command: "left over" } }).worker.command, "");
  assert.equal(normalize({ worker: { command: "x" } }).worker.command, ""); // the default agent is claude
  assert.equal(normalize({ worker: { agent: "custom", command: 5 } }).worker.command, "");
});

test("a custom agent needs a command, for each role that has one", () => {
  const w = valid();
  w.worker.agent = "custom";
  assert.deepEqual(validate(w).map((p) => p.field), ["worker.command"]);
  w.worker.command = "  ";
  assert.deepEqual(validate(w).map((p) => p.field), ["worker.command"]);
  w.worker.command = "my-agent";
  assert.deepEqual(validate(w), []);
  w.reviewer.agent = "custom";
  assert.deepEqual(validate(w).map((p) => p.field), ["reviewer.command"]);
});

test("a custom command survives a save and a read, and editing it is a change", () => {
  const w = valid({ id: "x" });
  w.orchestrator.agent = "custom";
  w.orchestrator.command = "aider --model sonnet";
  const back = parse(serialize(w));
  assert.equal(back.orchestrator.agent, "custom");
  assert.equal(back.orchestrator.command, "aider --model sonnet");
  assert.equal(isDirty(w, { ...w, orchestrator: { ...w.orchestrator, command: "aider" } }), true);
  // a command typed for an agent that is not custom is no change at all
  const claude = valid();
  assert.equal(isDirty(claude, { ...claude, worker: { ...claude.worker, command: "ignored" } }), false);
});

test("a file saved before custom agents existed reads with no command", () => {
  const old = parse(JSON.stringify({ name: "Old", worker: { prompt: "p", agent: "codex", model: "m", effort: "high" } }));
  assert.equal(old.worker.command, "");
  assert.equal(old.worker.agent, "codex");
});

test("a trigger holds several labels, trimmed, each once whatever its case", () => {
  assert.deepEqual(uniqueLabels([" bug ", "Bug", "", "  ", "workflow:x", 7, null, "BUG"]), ["bug", "workflow:x"]);
  assert.deepEqual(uniqueLabels("bug"), []);
  assert.deepEqual(uniqueLabels(undefined), []);
  const w = normalize({ trigger: { labels: ["a", " b ", "A"], match: "all" } });
  assert.deepEqual(w.trigger, { labels: ["a", "b"], match: "all" });
});

test("the trigger matches any of its labels unless it says all", () => {
  assert.deepEqual(MATCHES, ["any", "all"]);
  assert.equal(normalize({ trigger: { labels: ["a"] } }).trigger.match, "any");
  assert.equal(normalize({ trigger: { labels: ["a"], match: 3 } }).trigger.match, "any");
  assert.equal(normalize({ trigger: { labels: ["a"], match: "all" } }).trigger.match, "all");
});

test("an unknown match is a problem, and any and all are not", () => {
  assert.deepEqual(validate(valid({ trigger: { labels: ["a", "b"], match: "all" } })), []);
  assert.deepEqual(validate(valid({ trigger: { labels: ["a", "b"], match: "any" } })), []);
  assert.deepEqual(validate(valid({ trigger: { labels: ["a", "b"], match: "most" } })).map((p) => p.field), ["match"]);
});

test("a trigger with no labels, or only blank ones, is the fallback and is valid", () => {
  for (const labels of [[], ["  ", ""]]) {
    const w = valid({ trigger: { labels, match: "any" } });
    assert.deepEqual(validate(w), []);
    assert.equal(isFallback(w), true);
  }
});

test("a file from before triggers had several labels reads as one label", () => {
  const old = parse(JSON.stringify({ name: "Old", trigger: { label: "  workflow:feature " } }));
  assert.deepEqual(old.trigger, { labels: ["workflow:feature"], match: "any" });
  assert.deepEqual(normalize({ trigger: { label: "" } }).trigger.labels, []);
  assert.deepEqual(normalize({ trigger: { label: 4 } }).trigger.labels, []);
  // the new list wins when a file somehow has both
  assert.deepEqual(normalize({ trigger: { label: "old", labels: ["new"] } }).trigger.labels, ["new"]);
});

test("a trigger is saved as labels and match only, so an old file is rewritten in the new shape", () => {
  const w = valid({ id: "x", trigger: { labels: ["a", "b"], match: "all" } });
  const saved = parseYaml(serialize(w));
  assert.deepEqual(saved.trigger, { labels: ["a", "b"], match: "all" });
  const migrated = parseYaml(serialize(parse(JSON.stringify({ id: "x", name: "X", trigger: { label: "a" } }))));
  assert.deepEqual(migrated.trigger, { labels: ["a"], match: "any" });
  assert.deepEqual(parse(serialize(w)).trigger, w.trigger);
});

test("adding, removing or reordering trigger labels, or changing the match, is a change", () => {
  const base = valid();
  assert.equal(isDirty(base, { ...base, trigger: { ...base.trigger, labels: [...base.trigger.labels, "extra"] } }), true);
  assert.equal(isDirty(base, { ...base, trigger: { ...base.trigger, match: "all" } }), true);
  assert.equal(isDirty(base, { ...base, trigger: { ...base.trigger, labels: [" workflow:feature "] } }), false); // only trimmed
  // the spelling is saved as typed, so recasing a label changes the file, and so does the order
  assert.equal(isDirty(base, { ...base, trigger: { ...base.trigger, labels: ["WORKFLOW:FEATURE"] } }), true);
  const two = valid({ trigger: { labels: ["a", "b"], match: "any" } });
  assert.equal(isDirty(two, { ...two, trigger: { ...two.trigger, labels: ["b", "a"] } }), true);
  assert.equal(isDirty(two, { ...two, trigger: { ...two.trigger, labels: ["a", "b", "A"] } }), false); // a repeat is dropped
});

test("the scopes are global and repo, each with a name and a hint", () => {
  assert.deepEqual(SCOPES, ["global", "repo"]);
  for (const scope of SCOPES) { assert.ok(SCOPE_LABELS[scope]); assert.ok(SCOPE_HINTS[scope]); }
});

test("a file from before scopes, with a global flag, reads and is saved without it", () => {
  const old = parse(JSON.stringify({ id: "x", name: "X", global: true, trigger: { labels: ["a"] } }));
  assert.equal("global" in old, false);
  assert.equal("global" in parseYaml(serialize(old)), false);
});

test("the global scope says where it is kept, with no repo or sync tool in it", () => {
  assert.match(SCOPE_HINTS.global, /~\/\.config\/herdr-app\/workflows/);
  assert.doesNotMatch(SCOPE_HINTS.global, new RegExp(["work" + "station", "skill" + "share"].join("|"), "i"));
});
