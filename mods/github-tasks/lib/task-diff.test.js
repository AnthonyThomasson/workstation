import test from "node:test";
import assert from "node:assert/strict";
import { snapshot, labelDiff, changes, isDirty, checkTask } from "./task-diff.js";

test("a snapshot sorts and de-duplicates labels and fills what's missing", () => {
  assert.deepEqual(snapshot({ title: "T", labels: ["b", "a", "b"] }), { title: "T", body: "", labels: ["a", "b"], status: null });
  assert.deepEqual(snapshot(undefined), { title: "", body: "", labels: [], status: null });
});

test("says which labels to add and remove", () => {
  assert.deepEqual(labelDiff(["a", "b"], ["b", "c"]), { add: ["c"], remove: ["a"] });
  assert.deepEqual(labelDiff([], []), { add: [], remove: [] });
  assert.deepEqual(labelDiff(undefined, ["x"]), { add: ["x"], remove: [] });
});

test("changes names only what differs, and drafts have no labels", () => {
  const before = { title: "A", body: "x", labels: ["bug"], status: "Todo" };
  assert.deepEqual(changes(before, before), {});
  assert.deepEqual(changes(before, { ...before, title: "B", status: "Done", labels: ["bug", "ui"] }), { title: "B", status: "Done", labels: { add: ["ui"], remove: [] } });
  assert.deepEqual(changes(before, { ...before, body: "" }), { body: "" });
  assert.deepEqual(changes(before, { ...before, labels: [] }, { draft: true }), {});
  assert.equal(isDirty(before, { ...before, labels: ["bug"] }), false);
  assert.equal(isDirty(before, { ...before, body: "y" }), true);
});

test("a save needs a title and a status the project has", () => {
  const options = [{ id: "1", name: "Todo" }];
  assert.equal(checkTask({ title: "  " }, options), "A task needs a title.");
  assert.equal(checkTask({ title: "T", status: "Nope" }, options), 'The project has no "Nope" status.');
  assert.equal(checkTask({ title: "T", status: "Todo" }, options), null);
  assert.equal(checkTask({ title: "T", status: null }, options), null);
});
