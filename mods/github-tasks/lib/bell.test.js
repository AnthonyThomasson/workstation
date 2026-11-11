import test from "node:test";
import assert from "node:assert/strict";
import { BACK_AFTER, SHAKE_FOR, Shakes, bellFirst, bellTip, bellToast, waitingAgents } from "./bell.js";

const RUN = "herdr.workflow.run";
const term = (address, status, over = {}) => ({ address, name: `r1-${address}`, state: "live", status, labels: { [RUN]: "r1" }, created_ms: 1, ...over });

test("an agent of the run that is blocked or in error needs the person", () => {
  const found = waitingAgents([term("a", "working"), term("b", "blocked"), term("c", "error"), term("d", "idle"), term("e", "done")], RUN, "r1");
  assert.deepEqual(found.map((a) => [a.address, a.status]), [["b", "blocked"], ["c", "error"]]);
});

test("only live agents of that run count: not finished ones, other runs, or terminals with no label", () => {
  const found = waitingAgents([
    term("a", "blocked", { state: "ended" }),
    term("b", "blocked", { labels: { [RUN]: "r2" } }),
    term("c", "blocked", { labels: {} }),
    term("d", "blocked", { labels: undefined }),
    term("e", "blocked"),
  ], RUN, "r1");
  assert.deepEqual(found.map((a) => a.address), ["e"]);
});

test("the status can be a word or an object with a state, as terminals() and hc give it", () => {
  const found = waitingAgents([term("a", { state: "blocked", msg: "which one?" }), term("b", { state: "working" })], RUN, "r1");
  assert.deepEqual(found.map((a) => a.address), ["a"]);
});

test("blocked comes before error, then the oldest first", () => {
  const found = waitingAgents([term("a", "error", { created_ms: 1 }), term("b", "blocked", { created_ms: 9 }), term("c", "blocked", { created_ms: 5 })], RUN, "r1");
  assert.deepEqual(found.map((a) => a.address), ["c", "b", "a"]);
});

test("the agent's name is the terminal's, without the run's prefix", () => {
  const [a] = waitingAgents([term("a", "blocked", { name: "r1-worker-2" })], RUN, "r1");
  assert.equal(a.name, "worker-2");
  const [b] = waitingAgents([term("b", "blocked", { name: "other" })], RUN, "r1");
  assert.equal(b.name, "other");
  const [c] = waitingAgents([term("c", "blocked", { name: undefined })], RUN, "r1");
  assert.equal(c.name, "c", "no name: its address");
});

test("no id, no terminals, no label: nobody waits", () => {
  assert.deepEqual(waitingAgents(undefined, RUN, "r1"), []);
  assert.deepEqual(waitingAgents([term("a", "blocked")], RUN, ""), []);
  assert.deepEqual(waitingAgents([term("a", "blocked")], RUN, null), []);
});

test("rows needing the person go first, each group keeping its own order", () => {
  const items = ["a", "b", "c", "d", "e"];
  assert.deepEqual(bellFirst(items, (x) => x === "c" || x === "e"), ["c", "e", "a", "b", "d"]);
  assert.deepEqual(bellFirst(items, () => false), items);
  assert.deepEqual(bellFirst(items, () => true), items);
  assert.deepEqual(bellFirst([], () => true), []);
  assert.deepEqual(bellFirst(undefined, () => true), []);
});

test("bellFirst does not change the list it is given", () => {
  const items = ["a", "b"];
  bellFirst(items, (x) => x === "b");
  assert.deepEqual(items, ["a", "b"]);
});

test("the bell's tip names the agent, and how many more", () => {
  const blocked = { address: "a", name: "worker-2", status: "blocked" }, error = { address: "b", name: "reviewer", status: "error" };
  assert.equal(bellTip([blocked]), "worker-2 needs you. Click to answer.");
  assert.equal(bellTip([error]), "reviewer hit an error. Click to look.");
  assert.equal(bellTip([blocked, error]), "worker-2 needs you (and 1 more). Click to answer.");
  assert.equal(bellTip([blocked, error, error]), "worker-2 needs you (and 2 more). Click to answer.");
  assert.equal(bellTip([]), "");
});

test("the first look at a row never shakes it, even if it already needs the person", () => {
  const s = new Shakes();
  s.observe(new Map([["a", true], ["b", false]]), 1000);
  assert.equal(s.phase("a", 1000), null);
  assert.equal(s.phase("b", 1000), null);
});

test("a row that starts needing the person shakes once: out, then back, then still", () => {
  const s = new Shakes();
  s.observe(new Map([["a", false]]), 1000);
  s.observe(new Map([["a", true]]), 2000);
  assert.equal(s.phase("a", 2000), "out");
  assert.equal(s.phase("a", 2000 + BACK_AFTER - 1), "out");
  assert.equal(s.phase("a", 2000 + BACK_AFTER), "back");
  assert.equal(s.phase("a", 2000 + SHAKE_FOR - 1), "back");
  assert.equal(s.phase("a", 2000 + SHAKE_FOR), null);
});

test("looking again while it still needs the person does not shake it again", () => {
  const s = new Shakes();
  s.observe(new Map([["a", false]]), 1000);
  s.observe(new Map([["a", true]]), 2000);
  s.observe(new Map([["a", true]]), 2000 + SHAKE_FOR + 5000);
  assert.equal(s.phase("a", 2000 + SHAKE_FOR + 5000), null);
  s.observe(new Map([["a", true]]), 2000 + SHAKE_FOR + 5001);
  assert.equal(s.phase("a", 2000 + SHAKE_FOR + 5001), null);
});

test("the same moment looked at twice shakes once, from the first look", () => {
  const s = new Shakes();
  s.observe(new Map([["a", false]]), 1000);
  s.observe(new Map([["a", true]]), 2000);
  s.observe(new Map([["a", true]]), 2100);
  assert.equal(s.phase("a", 2000 + BACK_AFTER), "back", "the clock was not restarted by the second look");
});

test("when nothing needs the person any more the bell goes; needing them again shakes again", () => {
  const s = new Shakes();
  s.observe(new Map([["a", false]]), 1000);
  s.observe(new Map([["a", true]]), 2000);
  s.observe(new Map([["a", false]]), 3000);
  assert.equal(s.phase("a", 3000), null, "a shake in progress stops when the row no longer waits");
  s.observe(new Map([["a", true]]), 9000);
  assert.equal(s.phase("a", 9000), "out");
});

test("a row that appears already waiting does not shake; rows are judged by their own key", () => {
  const s = new Shakes();
  s.observe(new Map([["a", false]]), 1000);
  s.observe(new Map([["a", false], ["b", true]]), 2000);
  assert.equal(s.phase("b", 2000), null, "b was not there before: nothing began");
  s.observe(new Map([["a", true], ["b", true]]), 3000);
  assert.equal(s.phase("a", 3000), "out");
  assert.equal(s.phase("b", 3000), null);
});

test("a row that leaves the list and comes back is looked at as new", () => {
  const s = new Shakes();
  s.observe(new Map([["a", false]]), 1000);
  s.observe(new Map(), 2000);
  s.observe(new Map([["a", true]]), 3000);
  assert.equal(s.phase("a", 3000), null);
});

test("a key nobody has observed is not shaking", () => {
  assert.equal(new Shakes().phase("zzz", 5), null);
});

test("the shake lasts longer than its outward swing", () => {
  assert.ok(BACK_AFTER > 0 && SHAKE_FOR > BACK_AFTER);
});

test("each shaking row says how long until it is let go, on its own clock", () => {
  const s = new Shakes();
  s.observe(new Map([["a", false], ["b", false]]), 1000);
  s.observe(new Map([["a", true], ["b", false]]), 2000);
  s.observe(new Map([["a", true], ["b", true]]), 2100);
  assert.equal(s.releaseIn("a", 2100), BACK_AFTER - 100);
  assert.equal(s.releaseIn("b", 2100), BACK_AFTER, "a second row starting within the first's swing has its own release");
  assert.equal(s.releaseIn("a", 2000 + BACK_AFTER), null, "already let go");
  assert.equal(s.releaseIn("zzz", 2100), null);
  assert.equal(s.releaseIn("b", 2100 + BACK_AFTER), null);
});

test("rows of one repo's list and another's never mix when their keys carry the repo", () => {
  const s = new Shakes();
  s.observe(new Map([["ticket-/repo/a-local:1", false]]), 1000);
  s.observe(new Map([["ticket-/repo/b-local:1", true]]), 2000); // the other repo's list, whose task has the same id
  assert.equal(s.phase("ticket-/repo/b-local:1", 2000), null, "a row of another list is new, not one that started waiting");
  s.observe(new Map([["ticket-/repo/a-local:1", true]]), 3000);
  assert.equal(s.phase("ticket-/repo/a-local:1", 3000), null, "coming back to the first list starts over");
});

test("observe answers the rows that just started needing the person, once", () => {
  const s = new Shakes();
  assert.deepEqual(s.observe(new Map([["a", false], ["b", true], ["c", false]]), 1000), [], "the first look starts nothing");
  assert.deepEqual(s.observe(new Map([["a", true], ["b", true], ["c", true]]), 2000), ["a", "c"], "b was already waiting");
  assert.deepEqual(s.observe(new Map([["a", true], ["b", true], ["c", true]]), 2100), [], "looking again starts nothing");
  assert.deepEqual(s.observe(new Map([["a", false], ["b", true], ["c", true]]), 3000), []);
  assert.deepEqual(s.observe(new Map([["a", true], ["b", true], ["c", true]]), 4000), ["a"], "needing the person again is a new start");
});

test("a row that appears already waiting, or comes back, or changes space starts nothing", () => {
  const s = new Shakes();
  s.observe(new Map([["a", false]]), 1000);
  assert.deepEqual(s.observe(new Map([["a", false], ["b", true]]), 2000), []);
  assert.deepEqual(s.observe(new Map(), 3000), []);
  assert.deepEqual(s.observe(new Map([["a", true], ["b", true]]), 4000), [], "both are new again");
});

test("the toast says which row needs the person, which agent and why, and peeks that agent", () => {
  const blocked = { address: "t12", name: "worker-2", status: "blocked" }, error = { address: "t13", name: "reviewer", status: "error" };
  assert.deepEqual(bellToast("#81", [blocked, error]), {
    title: "#81 needs you", body: "worker-2 is blocked", level: "warning",
    action: { name: "terminal.peek", args: { terminal: "t12" } }, sound: "blocked",
  });
  assert.equal(bellToast("Fix the login redirect", [error]).title, "Fix the login redirect needs you");
  assert.equal(bellToast("#81", [error]).body, "reviewer has an error");
  assert.equal(bellToast("#81", []), null, "nobody waits: no toast");
});
