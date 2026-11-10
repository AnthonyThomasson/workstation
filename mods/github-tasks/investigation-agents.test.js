import test from "node:test";
import assert from "node:assert/strict";
import { investigationAgentsFor, investigationQueries, shortFolder, workerFolder } from "./investigation-agents.js";

const term = (address, role, extra = {}) => ({
  address, state: "live", status: "working", created_ms: 1, name: `inv-a-${address}`,
  ...extra,
  labels: { "herdr.investigation": "inv-a", "herdr.role": role, "herdr.workflow.name": address, ...extra.labels },
});
const ls = (address, extra = {}) => ({ address, name: `inv-a-${address}`, state: "live", status: "working", ...extra });
const found = (terminals, extra = {}) => investigationAgentsFor({ id: "inv-a", workDir: "/w/repo/inv-a", terminals, listed: null, saved: [], ...extra });

test("the queries ask the core for the session's investigators and workers by label", () => {
  const q = investigationQueries("inv-a");
  assert.deepEqual(q.investigator, ["ls", "--all", "--label", "herdr.investigation=inv-a", "--label", "herdr.role=investigator", "--json"]);
  assert.deepEqual(q.worker, ["ls", "--all", "--label", "herdr.investigation=inv-a", "--label", "herdr.role=worker", "--json"]);
});

test("only this session's investigators and workers are listed, by role", () => {
  const other = term("t9", "worker", { labels: { "herdr.investigation": "inv-b" } });
  const agent = term("t3", "investigation");
  const { investigators, workers } = found([term("t1", "investigator"), term("t2", "worker"), agent, other, { address: "t8", state: "live" }]);
  assert.deepEqual(investigators.map((r) => r.address), ["t1"]);
  assert.deepEqual(workers.map((r) => r.address), ["t2"]);
});

test("a row has the name the agent was given, its status and what it says it is doing", () => {
  const { investigators } = found([term("t1", "investigator", { labels: { "herdr.workflow.name": "auth-flow" }, status: { state: "blocked", msg: "which provider?" } })]);
  assert.equal(investigators[0].name, "auth-flow");
  assert.equal(investigators[0].status, "blocked");
  assert.equal(investigators[0].detail, "which provider?");
  assert.equal(investigators[0].needsYou, true);
});

test("without a name label the name is the terminal's, minus the session id", () => {
  const k = term("t1", "investigator", { name: "inv-a-docs" });
  delete k.labels["herdr.workflow.name"];
  assert.equal(found([k]).investigators[0].name, "docs");
});

test("a worker's detail is its worktree folder, shortened", () => {
  const { workers } = found([term("t2", "worker", { labels: { "herdr.workflow.name": "login", "herdr.workflow.folder": "/w/repo/inv-a--login" } })]);
  assert.equal(workers[0].detail, "…--login");
});

test("a worker known only from hc ls gets its folder from the session's, and its name", () => {
  const { workers } = found([], { listed: { investigator: null, worker: [ls("t2", { name: "inv-a-login" })] } });
  assert.deepEqual(workers.map((r) => [r.name, r.detail]), [["login", "…--login"]]);
});

test("workerFolder and shortFolder", () => {
  assert.equal(workerFolder("/w/repo/inv-a", "login"), "/w/repo/inv-a--login");
  assert.equal(shortFolder("/w/repo/inv-a--login"), "…--login");
  assert.equal(shortFolder("/w/repo/plain"), "plain");
  assert.equal(shortFolder(""), "");
});

test("live ones come first, then the order they started", () => {
  const { investigators } = found([
    term("t1", "investigator", { state: "finished", created_ms: 1 }),
    term("t3", "investigator", { created_ms: 3 }),
    term("t2", "investigator", { created_ms: 2 }),
  ]);
  assert.deepEqual(investigators.map((r) => r.address), ["t2", "t3", "t1"]);
});

test("an agent that finished keeps its row, as finished", () => {
  const { workers } = found([term("t2", "worker", { state: "finished", status: "done" })]);
  assert.equal(workers[0].live, false);
  assert.equal(workers[0].status, "finished");
});

test("a saved agent the core has forgotten stays, as finished, and a live one overrides it", () => {
  const saved = [
    { address: "t1", name: "gone", role: "investigator", started: 1 },
    { address: "t2", name: "login", role: "worker", started: 2 },
    { address: "t3", name: "nope", role: "orchestrator", started: 3 },
  ];
  const { investigators, workers, kept } = found([term("t2", "worker", { labels: { "herdr.workflow.name": "login" } })], { saved });
  assert.deepEqual(investigators.map((r) => [r.name, r.status, r.live]), [["gone", "finished", false]]);
  assert.deepEqual(workers.map((r) => [r.name, r.status, r.live]), [["login", "working", true]]);
  assert.deepEqual(kept.map((r) => r.address).sort(), ["t1", "t2"]);
});

test("kept has no detail, so it only changes when the list does", () => {
  const { kept } = found([term("t1", "investigator", { status: { state: "working", msg: "reading" } })]);
  assert.equal("detail" in kept[0], false);
});
