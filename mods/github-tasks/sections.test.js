import test from "node:test";
import assert from "node:assert/strict";
import { SECTIONS, emptyNote, initialOpen, sectionPlan, sectionText } from "./sections.js";

test("the sections are Up Next, Investigations, In Progress, In Review, Backlog, in that order", () => {
  assert.deepEqual(SECTIONS.map((s) => s.label), ["Up Next", "Investigations", "In Progress", "In Review", "Backlog"]);
  assert.deepEqual(SECTIONS.map((s) => s.id), ["next", "investigations", "progress", "review", "backlog"]);
});

test("Investigations is expanded by default, like every section but Backlog", () => {
  assert.equal(SECTIONS.find((s) => s.id === "investigations").open, true);
  assert.deepEqual(initialOpen(), { next: true, investigations: true, progress: true, review: true, backlog: false });
});

test("a header reads label · count", () => {
  assert.equal(sectionText("Investigations", 3), "Investigations · 3");
  const plan = sectionPlan({ investigations: [{ id: "a" }, { id: "b" }] }, initialOpen());
  assert.equal(plan.find((s) => s.id === "investigations").title, "Investigations · 2");
  assert.equal(plan.find((s) => s.id === "next").title, "Up Next · 0");
});

test("an empty expanded section says Nothing in <label>.", () => {
  assert.equal(emptyNote("Investigations"), "Nothing in Investigations.");
  const plan = sectionPlan({}, initialOpen());
  assert.equal(plan.find((s) => s.id === "investigations").empty, "Nothing in Investigations.");
  assert.equal(plan.find((s) => s.id === "backlog").empty, null, "a collapsed section says nothing");
  assert.equal(sectionPlan({ investigations: [{ id: "a" }] }, initialOpen()).find((s) => s.id === "investigations").empty, null);
});

test("collapsing hides the rows but keeps the count", () => {
  const lists = { investigations: [{ id: "a" }], backlog: [{ id: "t" }] };
  const open = { ...initialOpen(), investigations: false, backlog: true };
  const plan = sectionPlan(lists, open);
  const inv = plan.find((s) => s.id === "investigations"), backlog = plan.find((s) => s.id === "backlog");
  assert.deepEqual([inv.open, inv.items, inv.count, inv.title], [false, [], 1, "Investigations · 1"]);
  assert.deepEqual([backlog.open, backlog.items.length], [true, 1]);
});

test("the plan follows the order whatever order the lists are given in, in GitHub and local mode alike", () => {
  const plan = sectionPlan({ backlog: [1], review: [2], progress: [3], investigations: [4], next: [5] }, initialOpen());
  assert.deepEqual(plan.map((s) => s.id), ["next", "investigations", "progress", "review", "backlog"]);
  assert.deepEqual(plan.slice(0, 4).map((s) => s.items), [[5], [4], [3], [2]]);
});
