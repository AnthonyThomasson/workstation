import test from "node:test";
import assert from "node:assert/strict";
import { connectRun, endRun, holdShown, findRunTab, orchestratorRunArgs, parseStarted, placeholderArgv, reapplyRuns, slotKey, viewTarget } from "./bgrun.js";

const SPACES = [{ id: "s1", tabs: [{ id: "tA" }, { id: "tB" }] }, { id: "s2", tabs: [{ id: "tC" }] }];
const PANES = [{ pane: "pA", tab: "tA", terminal: "t9" }, { pane: "pB", tab: "tB", terminal: "t8" }, { pane: "pM", tab: "tB", mod: "github-tasks", terminal: null }];

test("the orchestrator starts in the background with no parent, no pane labels, and the run's labels", () => {
  const args = orchestratorRunArgs({ id: "22-x", key: "o/r#22", workDir: "/w", space: "s1", argv: ["claude", "--effort", "high"] });
  assert.deepEqual(args.slice(0, 5), ["run", "--bg", "--json", "--no-parent", "--cwd"]);
  assert.equal(args[5], "/w");
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["claude", "--effort", "high"]);
  const labels = args.flatMap((a, i) => (args[i - 1] === "--label" ? [a] : []));
  assert.deepEqual(labels.sort(), [
    "herdr.role=orchestrator", "herdr.workflow.folder=/w", "herdr.workflow.run=22-x", "herdr.workflow.space=s1", "herdr.workflow.ticket=o/r#22",
  ]);
  assert.ok(!labels.some((l) => l.startsWith("herdr.space") || l.startsWith("herdr.tab")), "those would adopt it into a pane");
});

test("no space label when the run started outside any space", () => {
  const args = orchestratorRunArgs({ id: "a", key: "k", workDir: "/w", space: null, argv: ["x"] });
  assert.ok(!args.some((a) => a.startsWith("herdr.workflow.space")));
});

test("parseStarted reads the address from hc run --json, or null", () => {
  assert.equal(parseStarted('{"address":"t7","state":"live"}\n'), "t7");
  assert.equal(parseStarted("not json"), null);
  assert.equal(parseStarted('{"error":{"message":"x"}}'), null);
});

test("the placeholder prints a note naming the orchestrator and then waits, so its pane stays", () => {
  const [sh, c, script] = placeholderArgv("t7");
  assert.equal(sh, "sh");
  assert.equal(c, "-c");
  assert.match(script, /Connecting to the orchestrator t7/);
  assert.match(script, /View reconnects it/);
  assert.match(script, /exec tail -f \/dev\/null$/);
});

test("the run's tab is found from the saved slot while its tab and left pane exist", () => {
  assert.deepEqual(findRunTab({ slot: { tab: "tB", left: "pB" }, spaces: SPACES, panes: PANES }), { tab: "tB", left: "pB", space: "s1" });
  assert.deepEqual(findRunTab({ slot: { tab: "tC", left: "pC" }, spaces: SPACES, panes: [...PANES, { pane: "pC", tab: "tC" }] }), { tab: "tC", left: "pC", space: "s2" });
});

test("no run tab: nothing saved, the tab was closed, or the left pane is gone", () => {
  assert.equal(findRunTab({ slot: null, spaces: SPACES, panes: PANES }), null);
  assert.equal(findRunTab({ slot: { tab: "gone", left: "pB" }, spaces: SPACES, panes: PANES }), null);
  assert.equal(findRunTab({ slot: { tab: "tB", left: "pGone" }, spaces: SPACES, panes: PANES }), null);
  assert.equal(findRunTab({ slot: { tab: "tA", left: "pB" }, spaces: SPACES, panes: PANES }), null); // that pane is in another tab
});

test("View connects in the space the run started in, or the current one when it is closed", () => {
  assert.equal(viewTarget({ started: "s2", spaces: SPACES, current: "s1" }), "s2");
  assert.equal(viewTarget({ started: "closed", spaces: SPACES, current: "s1" }), "s1");
  assert.equal(viewTarget({ started: null, spaces: SPACES, current: "s1" }), "s1");
  assert.equal(viewTarget({ started: null, spaces: SPACES, current: undefined }), undefined);
});

// A fake of the app: records its commands, and answers tab.new.
function fakeApp({ fail = {}, noPane = false, shownAfter = 2 } = {}) {
  const calls = [], runs = [], slots = {};
  const deps = {
    app: async (name, args) => {
      calls.push([name, args]);
      if (fail[name]) throw new Error(fail[name]);
      if (name === "tab.new") return { space: args.space ?? "s1", tab: "tNew", terminal: "tp", ...(noPane ? {} : { pane: "pNew" }) };
      return {};
    },
    paneOf: async (made) => made.pane ?? null,
    run: (name, args) => runs.push([name, args]),
    setSlot: (id, v) => { slots[id] = v; },
    sleep: async () => {},
    isShown: shownAfter === null ? undefined : () => calls.filter((c) => c[0] === "terminal.show").length >= shownAfter,
  };
  return { deps, calls, runs, slots };
}
const base = { id: "r1", orchestrator: "t7", name: "#22 x", space: "s2", folder: "/w", props: { role: "run", id: "r1" } };

test("connecting makes a tab with the placeholder, shows the orchestrator over it, splits the run page on the right and focuses the left", async () => {
  const f = fakeApp();
  const got = await connectRun(f.deps, base);
  assert.deepEqual(got, { tab: "tNew", left: "pNew", space: "s2" });
  assert.deepEqual(f.calls.map((c) => c[0]), ["tab.new", "terminal.show", "pane.split", "terminal.show"]);
  assert.deepEqual(f.runs.slice(0, 2), [["space.select", { id: "s2" }], ["tab.select", { id: "tNew" }]]); // a show on a tab that isn't on screen is lost
  assert.equal(f.calls[0][1].space, "s2");
  assert.equal(f.calls[0][1].name, "#22 x");
  assert.deepEqual(f.calls[0][1].argv, placeholderArgv("t7"));
  assert.deepEqual(f.calls[1][1], { terminal: "t7", pane: "pNew" });
  assert.deepEqual(f.calls[2][1], { pane: "pNew", direction: "right", mod: "github-tasks", props: base.props });
  assert.deepEqual(f.calls[3][1], f.calls[1][1]); // shown again after the split, as the first show alone doesn't hold
  assert.deepEqual(f.runs.slice(2), [["pane.focus", { pane: "pNew" }]]);
  assert.deepEqual(f.slots.r1, { tab: "tNew", left: "pNew", space: "s2" });
});

test("a pane that does not appear says so, and closes the tab it made", async () => {
  const f = fakeApp({ noPane: true });
  await assert.rejects(connectRun(f.deps, base), /pane didn't appear/);
  assert.deepEqual(f.runs.at(-1), ["tab.close", { id: "tNew" }]);
  assert.equal(f.slots.r1, undefined);
});

test("when the orchestrator can't be shown the error says why, the half-made tab is closed and nothing is saved", async () => {
  const f = fakeApp({ fail: { "terminal.show": "no such terminal t7" } });
  await assert.rejects(connectRun(f.deps, base), /couldn't be shown.*no such terminal t7/);
  assert.deepEqual(f.runs.at(-1), ["tab.close", { id: "tNew" }]);
  assert.equal(f.slots.r1, undefined);
});

test("when the run page can't be split the tab is closed and the error says why", async () => {
  const f = fakeApp({ fail: { "pane.split": "boom" } });
  await assert.rejects(connectRun(f.deps, base), /run page.*boom/);
  assert.deepEqual(f.runs.at(-1), ["tab.close", { id: "tNew" }]);
});

test("when the tab can't be made the error says why", async () => {
  const f = fakeApp({ fail: { "tab.new": "layout unavailable" } });
  await assert.rejects(connectRun(f.deps, base), /tab couldn't be made.*layout unavailable/);
  assert.deepEqual(f.runs, []);
});

test("after a restart each live run's orchestrator is shown again in the one tab it has", async () => {
  const shown = [];
  const slots = { r1: { tab: "tB", left: "pB" }, r2: { tab: "tC", left: "pC" }, r3: null };
  const terminals = [
    { address: "t7", state: "live", labels: { "herdr.role": "orchestrator", "herdr.workflow.run": "r1" } },
    { address: "t6", state: "live", labels: { "herdr.role": "orchestrator", "herdr.workflow.run": "r2" } }, // its tab is gone
    { address: "t5", state: "live", labels: { "herdr.role": "orchestrator", "herdr.workflow.run": "r3" } }, // never had one
    { address: "t4", state: "finished", labels: { "herdr.role": "orchestrator", "herdr.workflow.run": "r1" } },
    { address: "t3", state: "live", labels: { "herdr.role": "worker", "herdr.workflow.run": "r1" } },
  ];
  const n = await reapplyRuns({ terminals, slot: (id) => slots[id], spaces: SPACES, panes: PANES, show: async (a) => { shown.push(a); } });
  assert.equal(n, 1);
  assert.deepEqual(shown, [{ terminal: "t7", pane: "pB" }]);
});

test("a show that fails after a restart doesn't stop the others", async () => {
  const terminals = ["t7", "t6"].map((address, i) => ({ address, state: "live", labels: { "herdr.role": "orchestrator", "herdr.workflow.run": `r${i + 1}` } }));
  const slots = { r1: { tab: "tA", left: "pA" }, r2: { tab: "tB", left: "pB" } };
  const shown = [];
  const n = await reapplyRuns({ terminals, slot: (id) => slots[id], spaces: SPACES, panes: PANES, show: async (a) => { if (a.terminal === "t7") throw new Error("x"); shown.push(a); } });
  assert.equal(n, 1);
  assert.deepEqual(shown, [{ terminal: "t6", pane: "pB" }]);
});

test("slot keys are per run", () => assert.notEqual(slotKey("a"), slotKey("b")));

test("Merge kills the workers and reviewers, then the orchestrator, then closes the open run tab", async () => {
  const log = [];
  const terminals = [
    { address: "t7", labels: { "herdr.workflow.run": "r1", "herdr.role": "orchestrator" } },
    { address: "t3", labels: { "herdr.workflow.run": "r1", "herdr.role": "worker" } },
    { address: "t2", labels: { "herdr.workflow.run": "other" } },
  ];
  const got = await endRun({
    id: "r1", orchestrator: "t7", terminals, hc: async (a) => { log.push(a.join(" ")); return { code: 0 }; }, run: (n, a) => log.push(`${n} ${a.id}`),
    slot: { tab: "tB", left: "pB" }, spaces: SPACES, panes: PANES, clearSlot: () => log.push("clear"),
  });
  assert.deepEqual(got, { tabClosed: true });
  assert.deepEqual(log, ["kill t3", "rm t3", "kill t7", "rm t7", "clear", "tab.close tB"]);
});

test("Merge doesn't fail when the run's tab is already closed, or a kill fails", async () => {
  const log = [];
  const got = await endRun({
    id: "r1", orchestrator: "t7", terminals: [], hc: async () => { throw new Error("gone"); }, run: (n) => log.push(n),
    slot: { tab: "tGone", left: "pB" }, spaces: SPACES, panes: PANES, clearSlot: () => log.push("clear"),
  });
  assert.deepEqual(got, { tabClosed: false });
  assert.deepEqual(log, ["clear"]);
});

test("the show is repeated until the app says it holds, then stops", async () => {
  let shows = 0;
  const held = await holdShown({ sleep: async () => {}, isShown: () => shows >= 3 }, { orchestrator: "t7", left: "p", show: async () => { shows++; } });
  assert.equal(held, true);
  assert.equal(shows, 3);
});

test("the show is repeated a fixed number of times when the app can't say, and a failing show doesn't throw", async () => {
  let shows = 0;
  const held = await holdShown({ sleep: async () => {} }, { orchestrator: "t7", left: "p", show: async () => { shows++; throw new Error("x"); }, tries: 4 });
  assert.equal(held, false);
  assert.equal(shows, 4);
});
