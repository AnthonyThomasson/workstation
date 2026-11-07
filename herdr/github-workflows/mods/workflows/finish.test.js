import test from "node:test";
import assert from "node:assert/strict";
import { stageOf, optionFor, statusArgs, defaultBranch, mergeSteps, prArgs, parsePrUrl, prNumber } from "./finish.js";

test("stageOf follows the agents started", () => {
  assert.equal(stageOf({ workers: [], reviewers: [] }), 0);
  assert.equal(stageOf({ workers: [{}], reviewers: [] }), 1);
  assert.equal(stageOf({ workers: [{}], reviewers: [{}] }), 2);
});

test("optionFor matches status names loosely", () => {
  const options = [{ id: "a", name: "Todo" }, { id: "b", name: "In progress" }, { id: "c", name: "In-Review" }];
  assert.equal(optionFor(options, 1).id, "b");
  assert.equal(optionFor(options, 2).id, "c");
  assert.equal(optionFor([{ id: "a", name: "Todo" }], 1), null);
  assert.equal(optionFor(undefined, 1), null);
});

test("optionFor uses the configured names, falling back to the defaults", () => {
  const options = [{ id: "a", name: "Doing" }, { id: "b", name: "Checking" }, { id: "c", name: "In progress" }];
  const statuses = { inProgress: "Doing", inReview: "Checking" };
  assert.equal(optionFor(options, 1, statuses).id, "a");
  assert.equal(optionFor(options, 2, statuses).id, "b");
  assert.equal(optionFor(options, 1, {}).id, "c");
  assert.equal(optionFor(options, 1, null).id, "c");
  assert.equal(optionFor([{ id: "x", name: "In Review" }], 2, { inProgress: "Doing" }).id, "x");
});

test("statusArgs sends the ids as variables", () => {
  const a = statusArgs({ projectId: "P", itemId: "I", fieldId: "F", optionId: "O" });
  assert.ok(a.includes("option=O") && a.includes("item=I") && a[0] === "api");
});

test("defaultBranch", () => {
  assert.equal(defaultBranch("origin/main\n"), "main");
  assert.equal(defaultBranch(""), null);
});

test("mergeSteps checks both folders, then merges, then cleans up", () => {
  const s = mergeSteps({ repoRoot: "/r", workDir: "/r-1", branch: "workflow/1-x", base: "main" });
  assert.deepEqual(s.map((x) => x.args[2]), ["status", "status", "switch", "merge", "worktree", "branch"]);
  assert.equal(s[3].abort[3], "--abort");
  assert.ok(s[0].dirty && s[1].dirty);
});

test("prArgs and the URL", () => {
  assert.deepEqual(prArgs({ branch: "b", title: "T", number: 4 }).slice(-4), ["--title", "#4 T", "--body", "Closes #4"]);
  assert.equal(prArgs({ branch: "b", title: "T" })[5], "T");
  const url = parsePrUrl("Creating...\nhttps://github.com/o/r/pull/12\n");
  assert.equal(url, "https://github.com/o/r/pull/12");
  assert.equal(prNumber(url), "12");
  assert.equal(parsePrUrl("nothing"), null);
});

import { parsePr, branchFinishSteps } from "./finish.js";
test("parsePr and branchFinishSteps", () => {
  assert.deepEqual(parsePr('{"url":"https://github.com/o/r/pull/3","state":"merged","number":3}'), { url: "https://github.com/o/r/pull/3", state: "MERGED", number: 3 });
  assert.equal(parsePr("no pull requests found"), null);
  assert.deepEqual(branchFinishSteps({ repoRoot: "/r", branch: "b", base: "main" }).map((s) => s.args[2]), ["status", "switch", "branch"]);
});
