import test from "node:test";
import assert from "node:assert/strict";
import { agentsOf, orchestratorOf, row, statusColor, statusLabel, withGone } from "./runview.js";

const term = (address, role, extra = {}) => ({
  address, state: "live", status: "working", created_ms: 1,
  ...extra,
  labels: { "herdr.workflow.run": "r1", "herdr.role": role, "herdr.workflow.name": address, ...extra.labels },
});

test("only this run's terminals are listed, by role", () => {
  const other = term("t9", "worker", { labels: { "herdr.workflow.run": "r2" } });
  const plain = { address: "t8", state: "live" };
  const { workers, reviewers } = agentsOf([term("t1", "worker"), term("t2", "reviewer"), term("t3", "orchestrator"), other, plain], "r1");
  assert.deepEqual(workers.map((r) => r.address), ["t1"]);
  assert.deepEqual(reviewers.map((r) => r.address), ["t2"]);
});

test("a run with no agents yet has empty lists", () => {
  assert.deepEqual(agentsOf([], "r1"), { workers: [], reviewers: [], needsYou: 0 });
  assert.deepEqual(agentsOf(undefined, "r1"), { workers: [], reviewers: [], needsYou: 0 });
});

test("live agents come first, then the order they started", () => {
  const list = agentsOf([
    term("t1", "worker", { state: "finished", created_ms: 1 }),
    term("t3", "worker", { created_ms: 3 }),
    term("t2", "worker", { created_ms: 2 }),
  ], "r1").workers;
  assert.deepEqual(list.map((r) => r.address), ["t2", "t3", "t1"]);
});

test("blocked agents count as needing the person, finished ones never do", () => {
  const { needsYou } = agentsOf([
    term("t1", "worker", { status: "blocked" }),
    term("t2", "reviewer", { status: "blocked" }),
    term("t3", "worker", { status: "blocked", state: "finished" }),
  ], "r1");
  assert.equal(needsYou, 2);
});

test("a row reads both the app's and hc's status shapes", () => {
  assert.equal(row(term("t1", "worker", { status: "working", report: { msg: "Reading" } })).detail, "Reading");
  const fromHc = row(term("t1", "worker", { status: { state: "done", msg: "All set" } }));
  assert.equal(fromHc.status, "done");
  assert.equal(fromHc.detail, "All set");
});

test("a row carries whether it is the final reviewer", () => {
  assert.equal(row(term("t1", "reviewer", { labels: { "herdr.workflow.final": "1" } })).final, true);
  assert.equal(row(term("t1", "reviewer")).final, false);
  assert.equal(agentsOf([term("t1", "reviewer", { labels: { "herdr.workflow.final": "1" } })], "r1").reviewers[0].final, true);
});

test("a final reviewer the core forgot stays marked final", () => {
  const seen = new Map();
  withGone(agentsOf([term("t1", "reviewer", { labels: { "herdr.workflow.final": "1" } })], "r1").reviewers, seen);
  const later = withGone([], seen);
  assert.deepEqual(later.map((r) => [r.final, r.live]), [[true, false]]);
});

test("a row falls back on the title, the name and the address", () => {
  assert.equal(row(term("t1", "worker", { title: "Fix login" })).detail, "Fix login");
  assert.equal(row({ address: "t1", state: "live", name: "x" }).name, "x");
  assert.equal(row({ address: "t1", state: "live" }).name, "t1");
  assert.equal(row({ address: "t1", state: "live" }).status, "unknown");
});

test("a finished terminal says finished whatever it last reported", () => {
  assert.equal(row(term("t1", "worker", { state: "finished", status: "working" })).status, "finished");
});

test("an agent the core forgot stays listed, as finished", () => {
  const seen = new Map();
  const first = withGone(agentsOf([term("t1", "worker", { status: "blocked" }), term("t2", "worker", { created_ms: 2 })], "r1").workers, seen);
  assert.deepEqual(first.map((r) => r.status), ["blocked", "working"]);
  const later = withGone(agentsOf([term("t2", "worker", { created_ms: 2 })], "r1").workers, seen);
  assert.deepEqual(later.map((r) => [r.address, r.status, r.live, r.needsYou]), [["t2", "working", true, false], ["t1", "finished", false, false]]);
});

test("the orchestrator is found by address", () => {
  assert.equal(orchestratorOf([term("t1", "orchestrator")], "t1").address, "t1");
  assert.equal(orchestratorOf([], "t1"), null);
});

test("every status has words and a color", () => {
  const t = { working: "w", blocked: "b", done: "d", idle: "i", ansi1: "e", dim: "f", unknown: "u" };
  assert.equal(statusLabel("blocked"), "Needs you");
  assert.equal(statusLabel("odd"), "odd");
  assert.equal(statusColor("blocked", t), "b");
  assert.equal(statusColor("odd", t), "u");
});
