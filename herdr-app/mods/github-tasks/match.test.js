import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow, matchWorkflows, skillshareSource } from "./match.js";

const wf = (id, trigger) => parseWorkflow(JSON.stringify({ name: id, trigger }), { id, scope: "global" });
const ids = (list) => list.map((w) => w.id);

test("a workflow starts for a ticket with any one of its labels", () => {
  const list = [wf("bug", { labels: ["bug", "crash"], match: "any" }), wf("docs", { labels: ["docs"], match: "any" })];
  assert.deepEqual(ids(matchWorkflows(list, ["Crash"])), ["bug"]);
});

test("match all needs every label", () => {
  const list = [wf("both", { labels: ["a", "b"], match: "all" })];
  assert.deepEqual(ids(matchWorkflows(list, ["a"])), []);
  assert.deepEqual(ids(matchWorkflows(list, ["b", "A"])), ["both"]);
});

test("several workflows can match", () => {
  const list = [wf("one", { labels: ["x"] }), wf("two", { labels: ["x", "y"] }), wf("three", { labels: ["z"] })];
  assert.deepEqual(ids(matchWorkflows(list, ["x"])), ["one", "two"]);
});

test("the no-label workflow is the fallback, only when nothing else matches", () => {
  const list = [wf("fallback", { labels: [] }), wf("bug", { labels: ["bug"] })];
  assert.deepEqual(ids(matchWorkflows(list, ["bug"])), ["bug"]);
  assert.deepEqual(ids(matchWorkflows(list, ["other"])), ["fallback"]);
  assert.deepEqual(ids(matchWorkflows(list, [])), ["fallback"]);
});

test("no workflows, no matches", () => {
  assert.deepEqual(matchWorkflows([], ["bug"]), []);
});

test("an older file with a single label still triggers", () => {
  assert.deepEqual(parseWorkflow('{"name":"old","trigger":{"label":"bug"}}', { id: "old", scope: "repo" }).trigger.labels, ["bug"]);
});

test("a file that is not a workflow object is refused", () => {
  assert.throws(() => parseWorkflow("nope", { id: "x", scope: "global" }), /not valid YAML/);
  assert.throws(() => parseWorkflow("- a", { id: "x", scope: "global" }), /not a workflow object/);
});

test("skillshare's skills folder is read from its config", () => {
  assert.equal(skillshareSource("sources:\n  skills: ~/skills # here\nother: 1\n", "/h"), "/h/skills");
  assert.equal(skillshareSource("", "/h"), "/h/.config/skillshare/skills");
});

test("a YAML workflow file reads, and so does an old JSON one", () => {
  const y = parseWorkflow("name: Features\ntrigger:\n  labels:\n    - feature\n  match: all\nworker:\n  testing: |\n    run it\n", { id: "f", scope: "global" });
  assert.deepEqual(y.trigger, { labels: ["feature"], match: "all" });
  assert.equal(y.worker.testing, "run it\n");
});
