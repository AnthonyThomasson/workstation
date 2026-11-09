import test from "node:test";
import assert from "node:assert/strict";
import { orderTargets, pickerView, RECENT, SEARCH_CAP } from "./targets.js";

const wt = (path, branch, at) => ({ path, branch, at });
const br = (name, at = 0) => ({ name, at });
const co = (branch, at, idx = 0) => ({ branch, at, idx });

test("worktrees come newest reflog entry first; one with no reflog sorts last, in the order git listed them", () => {
  const out = orderTargets({
    worktrees: [wt("/r", "main", 100), wt("/r-old", "old", 50), wt("/r-none", "none", null), wt("/r-new", "new", 900), wt("/r-none2", "none2", null)],
    branches: [], checkouts: [],
  });
  assert.deepEqual(out.worktrees.map((w) => w.path), ["/r-new", "/r", "/r-old", "/r-none", "/r-none2"]);
});

test("branches come in checkout order: the newest checkout of a branch wins, same-second checkouts go by reflog position", () => {
  const out = orderTargets({
    worktrees: [],
    branches: [br("a"), br("b"), br("c"), br("d")],
    checkouts: [co("a", 100), co("b", 300), co("a", 500), co("c", 300, 1), co("b", 300, 0), co("gone", 900), co("c", 10)],
  });
  assert.deepEqual(out.branches.map((b) => b.name), ["a", "b", "c", "d"], "a (500), then b (300, #0) before c (300, #1), then never checked out");
});

test("branches never checked out sort after the checked-out ones by committer date, newest first, then by name", () => {
  const out = orderTargets({
    worktrees: [],
    branches: [br("zeta", 10), br("alpha", 10), br("fresh", 90), br("picked", 1), br("older", 5)],
    checkouts: [co("picked", 200)],
  });
  assert.deepEqual(out.branches.map((b) => b.name), ["picked", "fresh", "alpha", "zeta", "older"]);
});

test("a branch checked out in a worktree with no checkout entry counts as checked out then; it knows where", () => {
  const out = orderTargets({
    worktrees: [wt("/r", "main", 100), wt("/r-feat", "feat", 700), wt("/r-det", "", 800)],
    branches: [br("main", 1), br("feat", 1), br("other", 999), br("fresh", 998)],
    checkouts: [co("main", 400)],
  });
  assert.deepEqual(out.branches.map((b) => [b.name, b.path]), [["feat", "/r-feat"], ["main", "/r"], ["other", ""], ["fresh", ""]]);
});

test("orderTargets copes with nothing", () => {
  assert.deepEqual(orderTargets({ worktrees: [], branches: [], checkouts: [] }), { worktrees: [], branches: [] });
  assert.deepEqual(orderTargets(null), { worktrees: [], branches: [] });
});

const many = (n, prefix) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, path: "" }));
const manyWt = (n) => Array.from({ length: n }, (_, i) => ({ path: `/w/folder-${i}`, branch: `br-${i}` }));

test("with no query the picker shows the first 5 worktrees and the first 5 branches", () => {
  const v = pickerView({ worktrees: manyWt(8), branches: many(9, "b") }, "");
  assert.equal(RECENT, 5);
  assert.deepEqual(v.worktrees.map((w) => w.branch), ["br-0", "br-1", "br-2", "br-3", "br-4"]);
  assert.deepEqual(v.branches.map((b) => b.name), ["b0", "b1", "b2", "b3", "b4"]);
  assert.deepEqual([v.moreWorktrees, v.moreBranches, v.searching], [3, 4, false]);
  assert.deepEqual(pickerView({ worktrees: manyWt(8), branches: many(9, "b") }, "   ").searching, false, "blank is no query");
  const small = pickerView({ worktrees: manyWt(2), branches: many(1, "b") }, "");
  assert.deepEqual([small.worktrees.length, small.branches.length, small.moreWorktrees, small.moreBranches], [2, 1, 0, 0]);
});

test("a query filters every worktree (branch or folder name) and every branch, case-insensitively", () => {
  const targets = {
    worktrees: [{ path: "/p/Alpha-Tree", branch: "main" }, { path: "/p/two", branch: "feature/Login" }, { path: "/p/det", branch: "" }, ...manyWt(10)],
    branches: [{ name: "main", path: "" }, { name: "feature/Login", path: "" }, { name: "hotfix", path: "" }, ...many(10, "x")],
  };
  let v = pickerView(targets, "ALPHA");
  assert.deepEqual(v.worktrees.map((w) => w.path), ["/p/Alpha-Tree"], "by folder name");
  assert.deepEqual(v.branches, []);
  assert.equal(v.searching, true);
  v = pickerView(targets, "login");
  assert.deepEqual(v.worktrees.map((w) => w.path), ["/p/two"], "by branch name");
  assert.deepEqual(v.branches.map((b) => b.name), ["feature/Login"]);
  v = pickerView(targets, "br-9");
  assert.deepEqual(v.worktrees.map((w) => w.branch), ["br-9"], "reaches past the first 5");
  v = pickerView(targets, "x1");
  assert.deepEqual(v.branches.map((b) => b.name), ["x1"], "x1 only; x10 does not exist");
  v = pickerView(targets, "det");
  assert.deepEqual(v.worktrees.map((w) => w.path), ["/p/det"], "a detached worktree matches by folder");
  v = pickerView(targets, "  feature   tree ");
  assert.deepEqual(v.worktrees, [], "every word must match the same entry: 'tree' is not in the feature worktree");
  v = pickerView(targets, "two feature");
  assert.deepEqual(v.worktrees.map((w) => w.path), ["/p/two"], "words match in any order, across branch and folder");
  assert.deepEqual(pickerView(targets, "nothing like this"), { worktrees: [], branches: [], moreWorktrees: 0, moreBranches: 0, searching: true });
});

test("a query shows every match up to a cap and counts the rest", () => {
  const v = pickerView({ worktrees: manyWt(SEARCH_CAP + 7), branches: many(SEARCH_CAP + 2, "feat-") }, "e");
  assert.equal(SEARCH_CAP, 50);
  assert.equal(v.worktrees.length, SEARCH_CAP);
  assert.equal(v.moreWorktrees, 7);
  assert.equal(v.branches.length, SEARCH_CAP);
  assert.equal(v.moreBranches, 2);
});
