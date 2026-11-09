import test from "node:test";
import assert from "node:assert/strict";
import { connectRun, endRun, guarded, mergeOutcome, launchRun, holdShown, findRunTab, runTabParts, waitReady, orchestratorRunArgs, parseStarted, placeholderArgv, reapplyRuns, slotKey, viewTarget, findTicketSpace, peekSpace, undoRunTab } from "./bgrun.js";
import { ticketName } from "./run.js";

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
  assert.match(script, /shows orchestrator t7/);
  assert.match(script, /View reconnects it/);
  assert.doesNotMatch(script, /Connecting/, "it must read true once the orchestrator has ended too");
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

// The ticket's own space: its first terminal is in the ticket's worktree. The repo's space is at the repo root.
const TICKET = [
  { id: "s1", name: "workstation", named: false, folder: "/r", machine: null, tabs: [{ id: "tA" }, { id: "tB" }] },
  { id: "sT", name: "#32 Run each ticket", named: true, folder: "/wt/ticket", machine: null, tabs: [{ id: "tT" }] },
];
const TPANES = [{ pane: "pA", tab: "tA", cwd: "/r" }, { pane: "pT", tab: "tT", cwd: "/wt/ticket" }];
const where = { folder: "/wt/ticket", repoRoot: "/r" };

test("the space is named #<number> <title>, as the sidebar and the run's tab are", () => {
  assert.equal(ticketName({ number: 32, title: "Run each ticket in its own worktree space" }), "#32 Run each ticket in its own worktree space");
  assert.equal(ticketName({ title: "A draft" }), "A draft");
});

test("a ticket's space is found by its worktree, whatever it is called now (a renamed issue or space)", () => {
  assert.equal(findTicketSpace({ spaces: TICKET, panes: TPANES, ...where }), "sT");
  const renamed = TICKET.map((s) => (s.id === "sT" ? { ...s, name: "my notes", named: true } : s));
  assert.equal(findTicketSpace({ spaces: renamed, panes: TPANES, ...where }), "sT");
});

test("a space elsewhere is not the ticket's, and neither is the repo's", () => {
  assert.equal(findTicketSpace({ spaces: TICKET, panes: TPANES, folder: "/wt/other", repoRoot: "/r" }), null);
});

test("a ticket space whose folder moved is still found by its first terminal in the worktree (even in a subfolder)", () => {
  const moved = TICKET.map((s) => (s.id === "sT" ? { ...s, folder: "" } : s));
  assert.equal(findTicketSpace({ spaces: moved, panes: [{ pane: "pT", tab: "tT", cwd: "/wt/ticket/src" }], ...where }), "sT");
  assert.equal(findTicketSpace({ spaces: moved, panes: [{ pane: "pT", tab: "tT", cwd: "/wt/ticket-2" }], ...where }), null, "a sibling folder is not inside it");
});

test("the repo's space is never the ticket's, even one a run before this change left a tab in at the worktree", () => {
  // that run's tab was a second tab of the repo's space: its terminal is in the worktree, the space's first terminal is not
  const old = [{ ...TICKET[0], tabs: [{ id: "tA" }, { id: "tOld" }] }];
  const panes = [{ pane: "pA", tab: "tA", cwd: "/r" }, { pane: "pOld", tab: "tOld", cwd: "/wt/ticket" }];
  assert.equal(findTicketSpace({ spaces: old, panes, ...where }), null);
  // and a space at the main checkout is skipped even when the "worktree" is the repo root
  assert.equal(findTicketSpace({ spaces: TICKET, panes: TPANES, folder: "/r", repoRoot: "/r" }), null);
});

test("a space on another machine is never the ticket's", () => {
  const remote = TICKET.map((s) => (s.id === "sT" ? { ...s, machine: "box" } : s));
  assert.equal(findTicketSpace({ spaces: remote, panes: TPANES, ...where }), null);
});

test("View connects in the ticket's space; when it was closed that is null, meaning a new space at the worktree (never the current one)", () => {
  assert.equal(viewTarget({ spaces: TICKET, panes: TPANES, ...where }), "sT");
  assert.equal(viewTarget({ spaces: [TICKET[0]], panes: [TPANES[0]], ...where }), null);
});

test("a worker's terminal is peeked from the ticket's space: the run tab's space first, else the one found by worktree", () => {
  const slot = { tab: "tT", left: "pL", space: "sT" };
  assert.equal(peekSpace({ slot, spaces: TICKET, panes: [...TPANES, { pane: "pL", tab: "tT" }], ...where }), "sT");
  assert.equal(peekSpace({ slot: null, spaces: TICKET, panes: TPANES, ...where }), "sT");
  assert.equal(peekSpace({ slot: null, spaces: [TICKET[0]], panes: [TPANES[0]], ...where }), null);
});

test("undoing a Start closes the space it made, or only the tab it added to an existing space", () => {
  const log = [];
  undoRunTab({ created: "sT", part: { tab: "tT" }, run: (n, a) => log.push([n, a]) });
  assert.deepEqual(log, [["space.close", { id: "sT", confirmed: true }]]);
  log.length = 0;
  undoRunTab({ created: null, part: { tab: "tT" }, run: (n, a) => log.push([n, a]) });
  assert.deepEqual(log, [["tab.close", { id: "tT", confirmed: true }]], "confirmed: if it is the space's last tab Herdr would ask");
  log.length = 0;
  undoRunTab({ created: null, part: null, run: (n, a) => log.push([n, a]) });
  assert.deepEqual(log, [], "nothing to close");
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

test("with no space (none given, none returned by tab.new) connecting skips space.select and still selects the tab", async () => {
  const f = fakeApp();
  const app = f.deps.app;
  f.deps.app = async (name, args) => { const r = await app(name, args); return name === "tab.new" ? { ...r, space: undefined } : r; };
  const got = await connectRun(f.deps, { ...base, space: undefined });
  assert.deepEqual(got, { tab: "tNew", left: "pNew", space: null });
  assert.equal(f.runs.some((r) => r[0] === "space.select"), false);
  assert.deepEqual(f.runs.slice(0, 1), [["tab.select", { id: "tNew" }]]);
  assert.deepEqual(f.slots.r1, { tab: "tNew", left: "pNew", space: null });
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

// A fake of the app that also answers space.new, as a space with its first tab.
function fakeSpaceApp(over = {}) {
  const f = fakeApp(over);
  const app = f.deps.app;
  f.deps.app = async (name, args) => {
    if (name === "space.new") {
      f.calls.push([name, args]);
      if (over.fail?.["space.new"]) throw new Error(over.fail["space.new"]);
      return { space: "sNew", tab: "tNew", terminal: "tp", ...(over.noPane ? {} : { pane: "pNew" }) };
    }
    return app(name, args);
  };
  return f;
}
const fresh = { ...base, space: null, spaceName: "#22 x", folder: "/wt/ticket" };

test("with no space to use, connecting makes a new space at the worktree, named for the ticket, with the run tab as its first tab", async () => {
  const f = fakeSpaceApp();
  const got = await connectRun(f.deps, fresh);
  assert.deepEqual(got, { tab: "tNew", left: "pNew", space: "sNew", created: true });
  assert.deepEqual(f.calls.map((c) => c[0]), ["space.new", "terminal.show", "pane.split", "terminal.show"]);
  assert.deepEqual(f.calls[0][1], { name: "#22 x", tab: "#22 x", folder: "/wt/ticket", argv: placeholderArgv("t7") });
  assert.deepEqual(f.runs.slice(0, 2), [["space.select", { id: "sNew" }], ["tab.select", { id: "tNew" }]]);
  assert.deepEqual(f.slots.r1, { tab: "tNew", left: "pNew", space: "sNew" }, "the saved slot doesn't say how the space came to be");
});

test("with a space to use, even a named new one is not made: the tab goes in it", async () => {
  const f = fakeSpaceApp();
  const got = await connectRun(f.deps, { ...fresh, space: "sT" });
  assert.equal(f.calls[0][0], "tab.new");
  assert.equal(f.calls[0][1].space, "sT");
  assert.equal(got.created, undefined);
});

test("a new space whose pane doesn't appear, or whose orchestrator can't be shown, is closed whole, confirmed", async () => {
  for (const over of [{ noPane: true }, { fail: { "terminal.show": "gone" } }, { fail: { "pane.split": "boom" } }]) {
    const f = fakeSpaceApp(over);
    await assert.rejects(connectRun(f.deps, fresh));
    assert.deepEqual(f.runs.at(-1), ["space.close", { id: "sNew", confirmed: true }]);
    assert.equal(f.slots.r1, undefined);
  }
});

test("a space that can't be made says why and closes nothing", async () => {
  const f = fakeSpaceApp({ fail: { "space.new": "layout unavailable" } });
  await assert.rejects(connectRun(f.deps, fresh), /space couldn't be made.*layout unavailable/);
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

// A fake core for endRun: kill works unless it is in `stuck`; a killed terminal is no longer live.
function fakeCore({ stuck = [], live = ["t7", "t3"] } = {}) {
  const alive = new Set(live), log = [];
  return {
    log,
    hc: async (a) => {
      log.push(a.join(" "));
      if (a[0] === "kill") { if (stuck.includes(a[1])) return { code: 1, stderr: "could not kill", stdout: "" }; alive.delete(a[1]); }
      return { code: 0, stdout: "", stderr: "" };
    },
    terminals: () => [...alive].map((address) => ({ address, state: "live", labels: { "herdr.workflow.run": "r1" } })),
  };
}
const endDeps = (core, over = {}) => ({
  id: "r1", orchestrator: "t7", hc: core.hc, terminals: core.terminals, run: (n, a) => core.log.push(`${n} ${a.id}`),
  slot: { tab: "tB", left: "pB" }, spaces: SPACES, panes: PANES, ticketSpace: "s1", clearSlot: () => core.log.push("clear"), ...over,
});

test("Merge kills the orchestrator first, then the workers and reviewers it left, and closes the ticket's whole space as its very last step", async () => {
  const core = fakeCore();
  const got = await endRun(endDeps(core));
  assert.deepEqual(got, { closed: true, error: null });
  assert.deepEqual(core.log, ["kill t7", "rm t7", "kill t3", "rm t3", "clear", "space.close s1"]);
});

test("a worker started while the orchestrator was being killed is still ended (terminals are read again)", async () => {
  const alive = new Set(["t7"]), seen = [];
  const hc = async (a) => {
    seen.push(a.join(" "));
    if (a[0] === "kill") { alive.delete(a[1]); if (a[1] === "t7") alive.add("tNew"); } // the orchestrator got one more worker out first
    return { code: 0, stdout: "", stderr: "" };
  };
  const terminals = () => [...alive].map((address) => ({ address, state: "live", labels: { "herdr.workflow.run": "r1" } }));
  await endRun({ id: "r1", orchestrator: "t7", hc, terminals, run() {}, slot: null, spaces: SPACES, panes: PANES, clearSlot() {} });
  assert.deepEqual(seen.filter((l) => l.startsWith("kill")), ["kill t7", "kill tNew"]);
});

test("when the orchestrator can't be killed the tab and slot stay and the error is returned", async () => {
  const core = fakeCore({ stuck: ["t7"] });
  const got = await endRun(endDeps(core));
  assert.equal(got.closed, false);
  assert.match(got.error, /t7/);
  assert.match(got.error, /could not kill/);
  assert.ok(!core.log.includes("clear") && !core.log.some((l) => l.startsWith("space.close") || l.startsWith("tab.close")), "the space stays open");
});

test("a kill that fails because the terminal already ended is not an error", async () => {
  const core = fakeCore({ live: [] });
  core.hc = async () => ({ code: 1, stderr: "not live", stdout: "" });
  const got = await endRun(endDeps(core));
  assert.deepEqual(got, { closed: true, error: null });
});

test("Merge doesn't fail when the run's tab is already closed or was never saved", async () => {
  const core = fakeCore({ live: [] });
  const got = await endRun(endDeps(core, { slot: { tab: "tGone", left: "pB" }, ticketSpace: null }));
  assert.deepEqual(got, { closed: false, error: null, tabFound: false });
  assert.deepEqual(core.log.slice(-1), ["clear"]);
  assert.ok(!core.log.some((l) => l.startsWith("space.close")));
});

test("a run tab that lost its left pane still has its space closed by Merge", async () => {
  const core = fakeCore({ live: [] });
  const panes = PANES.filter((p) => p.pane !== "pB"); // only the run page is left in tB
  const got = await endRun(endDeps(core, { panes }));
  assert.equal(got.closed, true);
  assert.ok(core.log.includes("space.close s1"));
});

test("a run from before the ticket got its own space has its tab in the repo's space: Merge closes only that tab, never the space", async () => {
  const core = fakeCore({ live: [] });
  const calls = [];
  // slot's space s1 has another tab (tA) and is not the ticket's space: there is none
  const got = await endRun(endDeps(core, { ticketSpace: null, run: (n, a) => calls.push([n, a]) }));
  assert.deepEqual(got, { closed: true, error: null });
  assert.deepEqual(calls, [["tab.close", { id: "tB" }]]);
});

test("when the run's tab is gone the ticket's space is still closed, if it is found by its worktree", async () => {
  const core = fakeCore({ live: [] });
  const got = await endRun(endDeps(core, { slot: { tab: "tGone", left: "pB" }, ticketSpace: "s2" }));
  assert.deepEqual(got, { closed: true, error: null });
  assert.deepEqual(core.log.slice(-2), ["clear", "space.close s2"]);
});

test("closing the space is confirmed, so it closes even with other tabs the person opened in it", async () => {
  const core = fakeCore({ live: [] });
  const calls = [];
  await endRun(endDeps(core, { run: (n, a) => calls.push([n, a]) }));
  assert.deepEqual(calls, [["space.close", { id: "s1", confirmed: true }]]);
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
  assert.equal(held, null, "the app can't say");
  assert.equal(shows, 4);
});

test("the parts of a run tab: both, only the page, only the left, or nothing", () => {
  assert.deepEqual(runTabParts({ slot: { tab: "tB", left: "pB" }, spaces: SPACES, panes: PANES }), { tab: "tB", space: "s1", left: "pB", page: "pM" });
  assert.deepEqual(runTabParts({ slot: { tab: "tB", left: "pB" }, spaces: SPACES, panes: PANES.filter((p) => p.pane !== "pB") }), { tab: "tB", space: "s1", left: null, page: "pM" });
  assert.deepEqual(runTabParts({ slot: { tab: "tB", left: "pB" }, spaces: SPACES, panes: PANES.filter((p) => p.pane !== "pM") }), { tab: "tB", space: "s1", left: "pB", page: null });
  assert.equal(runTabParts({ slot: { tab: "tB", left: "pB" }, spaces: SPACES, panes: [] }), null);
  assert.equal(runTabParts({ slot: null, spaces: SPACES, panes: PANES }), null);
});

test("a tab that lost its left pane gets a new placeholder beside the run page, swapped to the left, with the orchestrator shown", async () => {
  const f = fakeApp();
  f.deps.app = ((app) => async (name, args) => { const r = await app(name, args); return name === "pane.split" && args.argv ? { pane: "pLeft", terminal: "tp2" } : r; })(f.deps.app);
  const got = await connectRun(f.deps, { ...base, existing: { tab: "tB", space: "s1", left: null, page: "pM" } });
  const names = f.calls.map((c) => c[0]);
  assert.ok(!names.includes("tab.new"), "the tab is there already");
  assert.deepEqual(f.calls[0], ["pane.split", { pane: "pM", direction: "right", argv: placeholderArgv("t7") }]);
  assert.deepEqual(f.calls[1], ["pane.swap", { pane: "pLeft", target: "pM" }]);
  assert.deepEqual(f.calls.find((c) => c[0] === "terminal.show")[1], { terminal: "t7", pane: "pLeft" });
  assert.ok(!names.includes("pane.split") || f.calls.filter((c) => c[0] === "pane.split").length === 1, "the run page is not split again");
  assert.deepEqual(got, { tab: "tB", left: "pLeft", space: "s1" });
  assert.deepEqual(f.slots.r1, got);
  assert.ok(!f.runs.some((r) => r[0] === "tab.close"));
});

test("a tab that lost its run page gets it split again to the right of the left pane", async () => {
  const f = fakeApp();
  const got = await connectRun(f.deps, { ...base, existing: { tab: "tB", space: "s1", left: "pB", page: null } });
  assert.deepEqual(f.calls.filter((c) => c[0] === "pane.split"), [["pane.split", { pane: "pB", direction: "right", mod: "github-tasks", props: base.props }]]);
  assert.ok(!f.calls.some((c) => c[0] === "tab.new"));
  assert.deepEqual(got, { tab: "tB", left: "pB", space: "s1" });
});

test("a repair that fails leaves the tab that was already there alone", async () => {
  const f = fakeApp({ fail: { "pane.split": "boom" } });
  await assert.rejects(connectRun(f.deps, { ...base, existing: { tab: "tB", space: "s1", left: "pB", page: null } }), /boom/);
  assert.ok(!f.runs.some((r) => r[0] === "tab.close"));
});

test("a show that doesn't hold is reported through deps.warn", async () => {
  const f = fakeApp({ shownAfter: 99 });
  const warned = [];
  f.deps.warn = (m) => warned.push(m);
  await connectRun(f.deps, base);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /t7/);
  assert.match(warned[0], /View/);
});

test("no warning when the show holds", async () => {
  const f = fakeApp();
  const warned = [];
  f.deps.warn = (m) => warned.push(m);
  await connectRun(f.deps, base);
  assert.deepEqual(warned, []);
});

test("no warning when the app can't say (nothing to go on)", async () => {
  const f = fakeApp({ shownAfter: null });
  const warned = [];
  f.deps.warn = (m) => warned.push(m);
  await connectRun(f.deps, base);
  assert.deepEqual(warned, []);
});

test("a second connect for a run waits out the first: guarded runs one at a time per id", async () => {
  const busy = new Set(), order = [];
  let release;
  const first = guarded(busy, "r1", () => new Promise((r) => { release = r; order.push("first started"); }));
  const second = await guarded(busy, "r1", async () => order.push("second ran"));
  assert.equal(second, false, "refused while the first is running");
  assert.equal(busy.has("r1"), true);
  assert.equal(await guarded(busy, "other", async () => 1), 1);
  release("x");
  assert.equal(await first, "x");
  assert.equal(busy.has("r1"), false);
  assert.equal(await guarded(busy, "r1", async () => "again"), "again");
  assert.deepEqual(order, ["first started"]);
});

test("guarded frees the id when the work throws", async () => {
  const busy = new Set();
  await assert.rejects(guarded(busy, "r1", async () => { throw new Error("x"); }), /x/);
  assert.equal(busy.has("r1"), false);
});

const waited = (...answers) => {
  const seen = [];
  return { seen, hc: async (a) => { seen.push(a); const r = answers.shift(); return typeof r === "function" ? r() : r; } };
};
const answer = (obj, code = 0) => ({ code, stdout: JSON.stringify(obj), stderr: "" });

test("waitReady: ready when the agent reports idle", async () => {
  const w = waited(answer({ reason: "status", status: "idle", ended: true }));
  assert.deepEqual(await waitReady({ hc: w.hc, orchestrator: "t7" }), { ok: true });
  assert.deepEqual(w.seen[0].slice(0, 2), ["wait", "t7"]);
});

test("waitReady: keeps waiting through a timeout and a stray message, then is ready", async () => {
  const w = waited(answer({ reason: "timeout", status: "working", ended: false }), answer({ reason: "message", status: null, ended: false }), answer({ reason: "status", status: "done", ended: true }));
  assert.deepEqual(await waitReady({ hc: w.hc, orchestrator: "t7" }), { ok: true });
  assert.equal(w.seen.length, 3);
});

test("waitReady: a terminal that ended is a failure that says so", async () => {
  const w = waited(answer({ reason: "exit", status: null, ended: true, exit_code: 1 }));
  const got = await waitReady({ hc: w.hc, orchestrator: "t7" });
  assert.equal(got.ok, false);
  assert.match(got.why, /ended|exit/i);
});

test("waitReady: hc failing is a failure with its message", async () => {
  const w = waited({ code: 1, stdout: "", stderr: "no terminal t7" });
  const got = await waitReady({ hc: w.hc, orchestrator: "t7" });
  assert.equal(got.ok, false);
  assert.match(got.why, /no terminal t7/);
});

test("waitReady: an agent that never reports (a custom command) is waited on for the budget and then let through", async () => {
  const w = waited(...Array(3).fill(answer({ reason: "timeout", status: null, ended: false })));
  assert.deepEqual(await waitReady({ hc: w.hc, orchestrator: "t7", tries: 3 }), { ok: true, unconfirmed: true });
  assert.equal(w.seen.length, 3);
});

// launchRun: a fake core that records what is done, in order.
function fakeLaunch({ ready = answer({ reason: "status", status: "idle", ended: true }), send = { code: 0, stdout: "", stderr: "" }, run = { code: 0, stdout: '{"address":"t9"}', stderr: "" }, connect = async () => ({ tab: "tX", left: "pX", space: "s1" }) } = {}) {
  const log = [];
  const deps = {
    hc: async (a) => {
      log.push(`hc ${a.slice(0, 2).join(" ")}`);
      if (a[0] === "run") return run;
      if (a[0] === "wait") return ready;
      if (a[0] === "send") return send;
      return { code: 0, stdout: "", stderr: "" };
    },
    writePaneJson: async (props) => { log.push(`pane.json ${props.orchestrator}`); },
    connect: async (props) => { log.push("connect"); return connect(props); },
    closeTab: () => log.push("close tab"),
  };
  return { deps, log };
}
const launch = { id: "r1", key: "o/r#1", workDir: "/w", space: "s1", argv: ["claude"], task: "Read x and follow it.", props: { role: "run", id: "r1", orchestrator: null } };

test("launch: pane.json is written and the tab opened before the wait for the agent to boot, then the task is sent", async () => {
  const f = fakeLaunch();
  const got = await launchRun(f.deps, launch);
  assert.deepEqual(f.log, ["hc run --bg", "pane.json t9", "connect", "hc wait t9", "hc send t9"]);
  assert.deepEqual(got, { orchestrator: "t9", problems: [] });
});

test("launch: the props saved and shown carry the orchestrator's address", async () => {
  let seen;
  const f = fakeLaunch({ connect: async (props) => { seen = props; return {}; } });
  await launchRun(f.deps, launch);
  assert.equal(seen.orchestrator, "t9");
  assert.equal(seen.id, "r1");
});

test("launch: a tab that can't open is a problem to say, and the run still gets its task", async () => {
  const f = fakeLaunch({ connect: async () => { throw new Error("no layout"); } });
  const got = await launchRun(f.deps, launch);
  assert.match(got.problems[0], /no layout/);
  assert.match(got.problems[0], /View/);
  assert.ok(f.log.includes("hc send t9"));
});

test("launch: an orchestrator that doesn't start throws and opens nothing", async () => {
  const f = fakeLaunch({ run: { code: 1, stdout: "", stderr: "no such program" } });
  await assert.rejects(launchRun(f.deps, launch), /didn't start.*no such program/);
  assert.deepEqual(f.log, ["hc run --bg"]);
});

test("launch: an agent that ended while starting is killed and removed, its tab closed, and the reason thrown; no task is sent", async () => {
  const f = fakeLaunch({ ready: answer({ reason: "exit", status: null, ended: true, exit_code: 1 }) });
  await assert.rejects(launchRun(f.deps, launch), /ended while starting/);
  assert.ok(!f.log.includes("hc send t9"));
  assert.deepEqual(f.log.slice(-3), ["hc kill t9", "hc rm t9", "close tab"]);
});

test("launch: a task that can't be sent kills and removes the orchestrator, closes the tab, and says why", async () => {
  const f = fakeLaunch({ send: { code: 1, stdout: "", stderr: "terminal is busy" } });
  await assert.rejects(launchRun(f.deps, launch), /terminal is busy/);
  assert.deepEqual(f.log.slice(-3), ["hc kill t9", "hc rm t9", "close tab"]);
});

test("launch: View or Start pressed while the run boots is refused for the whole launch, then free again", async () => {
  const busy = new Set();
  let release;
  const f = fakeLaunch();
  const slow = f.deps.hc;
  f.deps.hc = async (a) => (a[0] === "wait" ? new Promise((r) => { release = () => r(answer({ reason: "status", status: "idle", ended: true })); }) : slow(a));
  const going = guarded(busy, "r1", () => launchRun(f.deps, launch));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await guarded(busy, "r1", async () => "second tab"), false);
  release();
  await going;
  assert.equal(await guarded(busy, "r1", async () => "next"), "next");
  assert.equal(f.log.filter((l) => l === "connect").length, 1, "one tab");
});

test("what the page says after Merge: nothing when its tab was closed, an error when something couldn't be ended, a note when no tab was found; never left busy", () => {
  assert.deepEqual(mergeOutcome({ closed: true, error: null }), { done: true, error: null, note: null });
  const bad = mergeOutcome({ closed: false, error: "couldn't end t7: x. Its space was kept; end it with hc kill." });
  assert.equal(bad.done, false);
  assert.match(bad.error, /^Merged, but couldn't end t7/);
  const gone = mergeOutcome({ closed: false, error: null, tabFound: false });
  assert.equal(gone.done, false);
  assert.equal(gone.error, null);
  assert.match(gone.note.text, /close it yourself/);
});
