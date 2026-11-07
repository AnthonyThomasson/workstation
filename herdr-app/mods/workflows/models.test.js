import test from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_MODELS, parseCodexModels, parseKimiModels, modelsFor, matchModels, hasModel } from "./models.js";

const cache = (models) => JSON.stringify({ fetched_at: "x", models });
const ids = (list) => list.map((m) => m.id);

test("Claude's models are the ones its /model menu offers, with the id --model takes", () => {
  assert.deepEqual(ids(CLAUDE_MODELS), ["opus", "opus[1m]", "claude-fable-5-1", "sonnet", "haiku"]);
  assert.ok(CLAUDE_MODELS.every((m) => m.id && m.name));
});

test("Codex's cache gives its listed models, not the hidden ones", () => {
  const list = parseCodexModels(cache([
    { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" },
    { slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list" },
    { slug: "gpt-5.6-terra", visibility: "list" },
  ]));
  assert.deepEqual(list, [{ id: "gpt-6-luna", name: "GPT-6 Luna" }, { id: "gpt-5.6-terra", name: "gpt-5.6-terra" }]);
});

test("a Codex cache that is missing, broken or shaped differently gives no models", () => {
  assert.deepEqual(parseCodexModels(null), []);
  assert.deepEqual(parseCodexModels("{nope"), []);
  assert.deepEqual(parseCodexModels("[]"), []);
  assert.deepEqual(parseCodexModels(JSON.stringify({ models: "x" })), []);
  assert.deepEqual(parseCodexModels(cache([null, 3, { slug: "" }, { display_name: "no slug" }])), []);
});

test("modelsFor gives each agent its own list, and an agent without one gets none", () => {
  const have = { codex: [{ id: "gpt-6-luna", name: "GPT-6 Luna" }], kimi: [{ id: "kimi-code/k3", name: "K3" }] };
  assert.equal(modelsFor("claude", have), CLAUDE_MODELS);
  assert.equal(modelsFor("codex", have), have.codex);
  assert.equal(modelsFor("kimi", have), have.kimi);
  assert.deepEqual(modelsFor("codex"), []);
  assert.deepEqual(modelsFor("kimi", { codex: have.codex }), []);
  assert.deepEqual(modelsFor("gemini", have), []);
  assert.deepEqual(modelsFor("custom", have), []);
  assert.deepEqual(modelsFor("", have), []);
});

test("matchModels finds a model by any word of its id or name, in any case", () => {
  assert.deepEqual(ids(matchModels(CLAUDE_MODELS, "SON")), ["sonnet"]);
  assert.deepEqual(ids(matchModels(CLAUDE_MODELS, "op 1m")), ["opus[1m]"]);
  assert.deepEqual(ids(matchModels(CLAUDE_MODELS, "5.5")), ["opus", "opus[1m]", "sonnet", "haiku"]); // found in the name
  assert.deepEqual(matchModels(CLAUDE_MODELS, "gpt"), []);
});

test("matchModels puts ids that start with the query first", () => {
  const list = [{ id: "x-opus", name: "Other" }, { id: "opus", name: "Opus" }, { id: "y", name: "Opus too" }];
  assert.deepEqual(ids(matchModels(list, "opus")), ["opus", "y", "x-opus"]);
});

test("matchModels with no query gives the list, and limit caps it", () => {
  assert.equal(matchModels(CLAUDE_MODELS, "").length, 5);
  assert.equal(matchModels(CLAUDE_MODELS, "   ").length, 5);
  assert.equal(matchModels(CLAUDE_MODELS, undefined).length, 5);
  assert.deepEqual(ids(matchModels(CLAUDE_MODELS, "", 2)), ["opus", "opus[1m]"]);
  assert.deepEqual(matchModels([], "x"), []);
});

test("hasModel is an exact id match without regard to case", () => {
  assert.equal(hasModel(CLAUDE_MODELS, "OPUS"), true);
  assert.equal(hasModel(CLAUDE_MODELS, " sonnet "), true);
  assert.equal(hasModel(CLAUDE_MODELS, "opus 5.5"), false); // a name, not an id
  assert.equal(hasModel(CLAUDE_MODELS, ""), false);
  assert.equal(hasModel([], "opus"), false);
});

const KIMI = `default_model = "kimi-code/k3.1-pro"

[providers."managed:kimi-code"]
base_url = "https://example.invalid"
api_key = "SECRET-DO-NOT-READ"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
display_name = "K2.8 Preview"
support_efforts = [ "low", "high", "max" ]

[models."kimi-code/k3"]
model = "k3"
display_name = "K3"

[models."kimi-code/k3.1-pro"]
model = "k3.1-pro"
display_name = "K3.1 Pro"   # the one in default_model

[thinking]
display_name = "not a model"

[[hooks]]
display_name = "nor is this"
`;

test("Kimi Code's config gives its models by the name --model takes, the default first", () => {
  const list = parseKimiModels(KIMI);
  assert.deepEqual(list, [
    { id: "kimi-code/k3.1-pro", name: "K3.1 Pro" },
    { id: "kimi-code/kimi-for-coding", name: "K2.8 Preview" },
    { id: "kimi-code/k3", name: "K3" },
  ]);
});

test("reading Kimi's config takes only the model sections, whatever else it holds", () => {
  const list = parseKimiModels(KIMI);
  assert.ok(!JSON.stringify(list).includes("SECRET"));
  assert.ok(!list.some((m) => /thinking|hook|provider/i.test(m.id) || /not a model|nor is this/.test(m.name)));
});

test("a Kimi model without a display name is called by the last part of its name", () => {
  assert.deepEqual(parseKimiModels('[models."kimi-code/plain"]\nmodel = "plain"\n'), [{ id: "kimi-code/plain", name: "plain" }]);
  assert.deepEqual(parseKimiModels("[models.bare]\ndisplay_name = \"Bare\"\n"), [{ id: "bare", name: "Bare" }]); // unquoted section name
});

test("without a default, or when it names no model, the file's order stays", () => {
  const two = '[models."a/one"]\ndisplay_name = "One"\n[models."a/two"]\ndisplay_name = "Two"\n';
  assert.deepEqual(parseKimiModels(two).map((m) => m.id), ["a/one", "a/two"]);
  assert.deepEqual(parseKimiModels(`default_model = "a/gone"\n${two}`).map((m) => m.id), ["a/one", "a/two"]);
  assert.deepEqual(parseKimiModels(`default_model = "a/two"\n${two}`).map((m) => m.id), ["a/two", "a/one"]);
});

test("a default_model inside a section is not the default", () => {
  const text = '[models."a/one"]\ndisplay_name = "One"\n[models."a/two"]\ndisplay_name = "Two"\n[other]\ndefault_model = "a/two"\n';
  assert.deepEqual(parseKimiModels(text).map((m) => m.id), ["a/one", "a/two"]);
});

test("a Kimi config that is missing, empty or has no models gives none", () => {
  for (const text of [null, undefined, "", "\n\n", "default_model = \"x\"\n", "[thinking]\nenabled = true\n", "not toml at all [[["]) {
    assert.deepEqual(parseKimiModels(text), []);
  }
});

test("Kimi's model names complete like any other", () => {
  const list = parseKimiModels(KIMI);
  assert.deepEqual(ids(matchModels(list, "k3")), ["kimi-code/k3.1-pro", "kimi-code/k3"]); // by name, ids with it first
  assert.deepEqual(ids(matchModels(list, "pro")), ["kimi-code/k3.1-pro"]);
  assert.equal(hasModel(list, "kimi-code/k3"), true);
});
