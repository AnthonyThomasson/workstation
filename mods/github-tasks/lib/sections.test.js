import test from "node:test";
import assert from "node:assert/strict";
import { SECTIONS, emptyNote, initialOpen, investigationsAlone, sectionPlan, sectionText } from "./sections.js";

test("the sections are Investigations, Up Next, Backlog, In Progress, In Review, in that order", () => {
  assert.deepEqual(SECTIONS.map((s) => s.label), ["Investigations", "Up Next", "Backlog", "In Progress", "In Review"]);
  assert.deepEqual(SECTIONS.map((s) => s.id), ["investigations", "next", "backlog", "progress", "review"]);
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

test("the plan follows the order whatever order the lists are given in", () => {
  const plan = sectionPlan({ backlog: [1], review: [2], progress: [3], investigations: [4], next: [5] }, initialOpen());
  assert.deepEqual(plan.map((s) => s.id), ["investigations", "next", "backlog", "progress", "review"]);
  assert.deepEqual(plan.filter((s) => s.open).map((s) => s.items), [[4], [5], [3], [2]]);
});

test("Investigations show alone when the ticket lists can't be drawn, but only with a context and a repo known", () => {
  const items = [{ id: "a" }, { id: "b" }];
  const gh = { ctx: {}, remote: false, mainRoot: "/r", repo: "o/r", items };
  const [inv, ...rest] = investigationsAlone(gh, initialOpen());
  assert.deepEqual([inv.id, inv.title, inv.items, rest], ["investigations", "Investigations · 2", items, []]);
  assert.equal(investigationsAlone({ ...gh, mainRoot: null }, initialOpen()).length, 1, "the GitHub name is enough");
  assert.equal(investigationsAlone({ ...gh, mainRoot: null, repo: null }, initialOpen()).length, 0, "no repo known");
  assert.equal(investigationsAlone({ ...gh, ctx: null }, initialOpen()).length, 0, "no context");
  assert.equal(investigationsAlone({ ...gh, repo: null, remote: true }, initialOpen()).length, 0, "a remote space has no checkout here");
  assert.equal(investigationsAlone({ ...gh, repo: null }, initialOpen()).length, 1, "a checkout here is enough");
  assert.equal(investigationsAlone({ ...gh, items: [] }, initialOpen())[0].empty, "Nothing in Investigations.");
  assert.deepEqual(investigationsAlone(gh, { investigations: false })[0].items, [], "the same collapse state");
});
