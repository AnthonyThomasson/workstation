import test from "node:test";
import assert from "node:assert/strict";
import { matchWorkflows } from "./match.js";
import { parse } from "./workflow-model.js";

const wf = (id, trigger) => ({ ...parse(JSON.stringify({ name: id, trigger })), id, scope: "global" });
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
