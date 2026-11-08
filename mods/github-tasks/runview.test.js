import test from "node:test";
import assert from "node:assert/strict";
import { agentsFor, keep, lsQueries, orchestratorOf, parseLs, row, statusColor, statusLabel } from "./runview.js";

// What `hc ls --all --json` gives for a terminal: no labels, the query was the filter.
const ls = (address, extra = {}) => ({ address, name: `n-${address}`, state: "live", status: "working", ...extra });
const agentsOf = (terminals, id = "r1", extra = {}) => agentsFor({ id, terminals, listed: null, saved: [], ...extra });

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

test("a row falls back on the title, the name and the address", () => {
  assert.equal(row(term("t1", "worker", { title: "Fix login" })).detail, "Fix login");
  assert.equal(row({ address: "t1", state: "live", name: "x" }).name, "x");
  assert.equal(row({ address: "t1", state: "live" }).name, "t1");
  assert.equal(row({ address: "t1", state: "live" }).status, "unknown");
});

test("a finished terminal says finished whatever it last reported", () => {
  assert.equal(row(term("t1", "worker", { state: "finished", status: "working" })).status, "finished");
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

test("a run with no agents yet has empty lists", () => {
  for (const found of [agentsOf([]), agentsOf(undefined), agentsFor({ id: "r1" })]) {
    assert.deepEqual(found, { workers: [], reviewers: [], needsYou: 0, kept: [] });
  }
});

test("the queries ask for the run's workers, reviewers and final reviewer, finished ones included", () => {
  assert.deepEqual(lsQueries("r1"), {
    worker: ["ls", "--all", "--label", "herdr.workflow.run=r1", "--label", "herdr.role=worker", "--json"],
    reviewer: ["ls", "--all", "--label", "herdr.workflow.run=r1", "--label", "herdr.role=reviewer", "--json"],
    final: ["ls", "--all", "--label", "herdr.workflow.run=r1", "--label", "herdr.role=reviewer", "--label", "herdr.workflow.final=1", "--json"],
  });
});

test("the answer of hc ls is read, and anything else is no answer", () => {
  assert.deepEqual(parseLs('{"hidden_finished":0,"terminals":[{"address":"t1"}]}'), [{ address: "t1" }]);
  assert.deepEqual(parseLs('{"terminals":[]}'), []);
  assert.equal(parseLs(""), null);
  assert.equal(parseLs("not json"), null);
  assert.equal(parseLs("{}"), null);
});

test("agents the core lists are shown with their role from the query, finished ones too", () => {
  const found = agentsFor({ id: "r1", terminals: [], saved: [], listed: {
    worker: [ls("t1"), ls("t2", { state: "finished", status: undefined })],
    reviewer: [ls("t3", { state: "finished" })],
    final: [],
  } });
  assert.deepEqual(found.workers.map((r) => [r.address, r.name, r.status, r.live]), [["t1", "n-t1", "working", true], ["t2", "n-t2", "finished", false]]);
  assert.deepEqual(found.reviewers.map((r) => [r.address, r.status, r.live, r.role]), [["t3", "finished", false, "reviewer"]]);
});

test("a finished reviewer that is only in the core's list still counts as finished, not running", () => {
  const { reviewers, needsYou } = agentsFor({ id: "r1", terminals: [], saved: [], listed: { reviewer: [ls("t3", { state: "finished", status: "blocked" })] } });
  assert.deepEqual(reviewers.map((r) => [r.status, r.needsYou]), [["finished", false]]);
  assert.equal(needsYou, 0);
});

test("a live terminal gives the status and the report, and its label the name", () => {
  const found = agentsFor({ id: "r1", saved: [],
    terminals: [term("t1", "worker", { status: "blocked", report: { msg: "Which branch?" }, labels: { "herdr.workflow.name": "login" }, created_ms: 5 })],
    listed: { worker: [ls("t1", { status: "working" })] } });
  assert.deepEqual(found.workers.map((r) => [r.name, r.status, r.detail, r.needsYou, r.started]), [["login", "blocked", "Which branch?", true, 5]]);
  assert.equal(found.needsYou, 1);
});

test("a live terminal the list hasn't shown yet is listed", () => {
  const found = agentsFor({ id: "r1", saved: [], listed: { worker: [], reviewer: [], final: [] }, terminals: [term("t1", "worker")] });
  assert.deepEqual(found.workers.map((r) => r.address), ["t1"]);
});

test("a terminal the core says finished reads finished whatever it last reported", () => {
  const found = agentsFor({ id: "r1", saved: [], listed: null, terminals: [term("t1", "worker", { state: "finished", status: "working" })] });
  assert.deepEqual(found.workers.map((r) => [r.status, r.live, r.needsYou]), [["finished", false, false]]);
});

test("the final reviewer is marked by its own query, and stays marked", () => {
  const listed = { worker: [], reviewer: [ls("t1"), ls("t2")], final: [ls("t2")] };
  const found = agentsFor({ id: "r1", terminals: [], saved: [], listed });
  assert.deepEqual(found.reviewers.map((r) => [r.address, r.final]), [["t1", false], ["t2", true]]);
  // the live terminal has the label too; without it (a core that dropped it) the query still says final
  const withTerm = agentsFor({ id: "r1", saved: [], listed, terminals: [term("t2", "reviewer")] });
  assert.equal(withTerm.reviewers.find((r) => r.address === "t2").final, true);
  // and once saved, it is final even when no query answers
  const later = agentsFor({ id: "r1", terminals: [], listed: null, saved: found.kept });
  assert.deepEqual(later.reviewers.map((r) => [r.address, r.final, r.live]), [["t1", false, false], ["t2", true, false]]);
});

test("a reload lists the saved agents as finished, until the core or a terminal says otherwise", () => {
  const first = agentsFor({ id: "r1", listed: null, saved: [], terminals: [term("t1", "worker", { status: "blocked", report: { msg: "Asking" }, created_ms: 1 }), term("t2", "worker", { created_ms: 2 })] });
  assert.deepEqual(first.workers.map((r) => r.status), ["blocked", "working"]);
  const saved = JSON.parse(JSON.stringify(first.kept)); // through shared state
  const reloaded = agentsFor({ id: "r1", listed: null, terminals: [term("t2", "worker", { created_ms: 2 })], saved });
  assert.deepEqual(reloaded.workers.map((r) => [r.address, r.status, r.live, r.needsYou, r.detail]), [["t2", "working", true, false, ""], ["t1", "finished", false, false, "Asking"]]);
  assert.equal(reloaded.needsYou, 0);
  const listedAgain = agentsFor({ id: "r1", terminals: [], saved, listed: { worker: [ls("t1")] } });
  assert.equal(listedAgain.workers.find((r) => r.address === "t1").status, "working");
});

test("what is kept is what a reload needs", () => {
  const { kept } = agentsOf([term("t1", "reviewer", { labels: { "herdr.workflow.final": "1", "herdr.workflow.name": "last" }, report: { msg: "Reading" }, created_ms: 7 })]);
  assert.deepEqual(kept, [{ address: "t1", name: "last", role: "reviewer", final: true, detail: "Reading", started: 7 }]);
  assert.deepEqual(keep(kept[0]), kept[0]);
});

test("a name from a label is not replaced by the terminal's name, but the terminal's name fills a gap", () => {
  const saved = [{ address: "t1", name: "login", role: "worker", final: false, detail: "", started: 1 }];
  const a = agentsFor({ id: "r1", saved, listed: { worker: [ls("t1")] }, terminals: [] });
  assert.equal(a.workers[0].name, "login");
  const b = agentsFor({ id: "r1", saved, listed: null, terminals: [term("t1", "worker", { name: "t1-term", labels: { "herdr.workflow.name": undefined } })] });
  assert.equal(b.workers[0].name, "login");
  const c = agentsFor({ id: "r1", saved: [], listed: { worker: [ls("t9")] }, terminals: [] });
  assert.equal(c.workers[0].name, "n-t9");
});

test("ordering: running first, then by start, and unknown starts keep the order the core listed", () => {
  const found = agentsFor({ id: "r1", saved: [], terminals: [], listed: { worker: [ls("tc", { state: "finished" }), ls("ta"), ls("tb", { state: "finished" }), ls("td")], reviewer: [], final: [] } });
  assert.deepEqual(found.workers.map((r) => r.address), ["ta", "td", "tc", "tb"]);
  const started = agentsOf([term("t1", "worker", { state: "finished", created_ms: 1 }), term("t3", "worker", { created_ms: 3 }), term("t2", "worker", { created_ms: 2 }), term("t0", "worker", { state: "finished", created_ms: 0.5 })]);
  assert.deepEqual(started.workers.map((r) => r.address), ["t2", "t3", "t0", "t1"]);
});

test("other runs' and other roles' terminals are left out of the list too", () => {
  const found = agentsFor({ id: "r1", saved: [], listed: null, terminals: [term("t1", "orchestrator"), term("t2", "worker", { labels: { "herdr.workflow.run": "r2" } }), term("t3", "worker")] });
  assert.deepEqual(found.workers.map((r) => r.address), ["t3"]);
  assert.deepEqual(found.reviewers, []);
});
