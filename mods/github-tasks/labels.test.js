import test from "node:test";
import assert from "node:assert/strict";
import { loadLabels, matchLabels, hasLabel } from "./labels.js";
import { GitHubError } from "./loader.js";

const ok = (data) => ({ code: 0, stdout: JSON.stringify(data), stderr: "" });
const fail = (stderr) => ({ code: 1, stdout: "", stderr });
const L = (...names) => names.map((name) => ({ name, color: "ededed" }));

test("loadLabels asks for the repo's labels and returns them by name", async () => {
  let args;
  const gh = async (a) => { args = a; return ok([{ name: "bug", color: "d73a4a" }, { name: "Alpha", color: "fff" }, { name: "workflow:feature" }]); };
  const labels = await loadLabels(gh, "acme/app", {});
  assert.deepEqual(args, ["label", "list", "-R", "acme/app", "--json", "name,color", "-L", "200"]);
  assert.deepEqual(labels.map((l) => l.name), ["Alpha", "bug", "workflow:feature"]);
  assert.equal(labels[2].color, ""); // a missing color does not break the list
});

test("loadLabels drops junk entries and fails on what is not a list", async () => {
  assert.deepEqual((await loadLabels(async () => ok([null, { color: "x" }, { name: "ok" }]), "a/b", {})).map((l) => l.name), ["ok"]);
  await assert.rejects(loadLabels(async () => ok({ message: "nope" }), "a/b", {}), GitHubError);
  await assert.rejects(loadLabels(async () => fail("HTTP 401: Bad credentials"), "a/b", {}), (e) => e.kind === "no-auth");
});

test("matchLabels puts labels that start with the query first, then ones that contain it", () => {
  const labels = L("bug", "debug", "workflow:bug", "workflow:feature", "feature");
  assert.deepEqual(matchLabels(labels, "bug").map((l) => l.name), ["bug", "debug", "workflow:bug"]);
  assert.deepEqual(matchLabels(labels, "WORK").map((l) => l.name), ["workflow:bug", "workflow:feature"]);
  assert.deepEqual(matchLabels(labels, "  feat ").map((l) => l.name), ["feature", "workflow:feature"]);
  assert.deepEqual(matchLabels(labels, "zzz"), []);
});

test("matchLabels with no query gives everything, and limit caps it", () => {
  const labels = L("a", "b", "c", "d");
  assert.equal(matchLabels(labels, "").length, 4);
  assert.equal(matchLabels(labels, undefined).length, 4);
  assert.deepEqual(matchLabels(labels, "", 2).map((l) => l.name), ["a", "b"]);
  assert.deepEqual(matchLabels(L("xa", "xb", "xc"), "x", 2).map((l) => l.name), ["xa", "xb"]);
});

test("hasLabel is an exact match without regard to case", () => {
  const labels = L("Workflow:Feature");
  assert.equal(hasLabel(labels, "workflow:feature"), true);
  assert.equal(hasLabel(labels, " WORKFLOW:FEATURE "), true);
  assert.equal(hasLabel(labels, "workflow"), false);
  assert.equal(hasLabel(labels, ""), false);
  assert.equal(hasLabel([], "x"), false);
});
