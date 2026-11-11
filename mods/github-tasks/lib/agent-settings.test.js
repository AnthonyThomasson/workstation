import test from "node:test";
import assert from "node:assert/strict";
import { groomArgv, normalizeGroomer, normalizeSubAgent } from "./agent-settings.js";

test("the grooming agent's command carries the chosen model and effort", () => {
  assert.deepEqual(groomArgv("claude", ["claude"], { model: "opus", effort: "high" }), ["claude", "--model", "opus", "--effort", "high"]);
  assert.deepEqual(groomArgv("claude", ["claude"], {}), ["claude", "--effort", "medium"]);
  assert.deepEqual(groomArgv("codex", ["codex"], { model: "gpt-x", effort: "low" }), ["codex", "-m", "gpt-x", "-c", "model_reasoning_effort=low"]);
  assert.deepEqual(groomArgv("kimi", ["kimi"], { model: "k" }), ["kimi", "--model", "k"]);
  assert.deepEqual(normalizeGroomer({ agent: " codex ", effort: "bogus" }), { agent: "codex", model: "", effort: "medium" });
});

test("a sub-agent's saved settings default to claude, the agent's own model and medium effort, however little or much is saved", () => {
  const fresh = { agent: "claude", model: "", effort: "medium" };
  for (const raw of [undefined, null, {}, "nope", 3, [], { agent: null }, { agent: "  ", model: 4, effort: "bogus" }]) assert.deepEqual(normalizeSubAgent(raw), fresh, JSON.stringify(raw));
  assert.deepEqual(normalizeSubAgent({ agent: " codex ", model: " gpt-x ", effort: "high" }), { agent: "codex", model: "gpt-x", effort: "high" });
  assert.deepEqual(normalizeSubAgent({ model: "opus" }), { agent: "claude", model: "opus", effort: "medium" });
  assert.equal(normalizeSubAgent({ agent: "custom" }).agent, "claude", "a custom command has no place here");
  assert.deepEqual(normalizeSubAgent({ agent: "kimi", extra: 1 }), { agent: "kimi", model: "", effort: "medium" }, "old or unknown fields are dropped");
  assert.deepEqual(normalizeGroomer(undefined), { agent: null, model: "", effort: "medium" }, "the New Task Orchestrator's own default is unchanged");
});
