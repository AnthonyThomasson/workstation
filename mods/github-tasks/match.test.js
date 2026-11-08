import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow, matchWorkflows, globalWorkflowsDir, repoWorkflowsDir } from "./match.js";

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

test("global workflows are in the workflows folder of the Herdr home, a repo's in its .herdr folder", () => {
  assert.equal(globalWorkflowsDir("/home/me/.config/herdr-app"), "/home/me/.config/herdr-app/workflows");
  assert.equal(globalWorkflowsDir("/scratch/home/"), "/scratch/home/workflows");
  assert.equal(repoWorkflowsDir("/code/app"), "/code/app/.herdr/workflows");
});

test("a YAML workflow file reads, and so does an old JSON one", () => {
  const y = parseWorkflow("name: Features\ntrigger:\n  labels:\n    - feature\n  match: all\nworker:\n  testing: |\n    run it\n", { id: "f", scope: "global" });
  assert.deepEqual(y.trigger, { labels: ["feature"], match: "all" });
  assert.equal(y.worker.testing, "run it\n");
});

test("the reviewer's test commands are read, and a file without them has none", () => {
  const y = parseWorkflow("name: F\nreviewer:\n  tests: |\n    node --test\n    npm test\n", { id: "f", scope: "global" });
  assert.equal(y.reviewer.tests, "node --test\nnpm test\n");
  assert.equal(parseWorkflow("name: F\n", { id: "f", scope: "global" }).reviewer.tests, "");
});

test("a file that still has a strategy is read and the strategy is ignored", () => {
  const y = parseWorkflow("name: F\nstrategy: worktree\n", { id: "f", scope: "global" });
  assert.equal("strategy" in y, false);
});
