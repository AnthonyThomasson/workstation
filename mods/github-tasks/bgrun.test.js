import test from "node:test";
import assert from "node:assert/strict";
import { viewQuick, viewConnect, connectRun, endRun, guarded, mergeOutcome, launchRun, holdShown, findRunTab, runTabParts, waitReady, orchestratorRunArgs, parseStarted, placeholderArgv, reapplyRuns, slotKey, viewTarget, findTicketSpace, peekSpace, undoRunTab, restartOrchestrator, slotFromPage, hostArgv, hostTabName, hostKey, findRepoSpace, findHost, openHost, endHost } from "./bgrun.js";
import { spawnSync } from "node:child_process";
import { ticketName } from "./run.js";

const SPACES = [{ id: "s1", tabs: [{ id: "tA" }, { id: "tB" }] }, { id: "s2", tabs: [{ id: "tC" }] }];
const PANES = [{ pane: "pA", tab: "tA", terminal: "t9" }, { pane: "pB", tab: "tB", terminal: "t8" }, { pane: "pM", tab: "tB", mod: "github-tasks", terminal: null }];

test("the orchestrator starts in the background with no parent, no pane labels, and the run's labels", () => {
  const args = orchestratorRunArgs({ id: "22-x", key: "o/r#22", workDir: "/w", argv: ["claude", "--effort", "high"] });
  assert.deepEqual(args.slice(0, 5), ["run", "--bg", "--json", "--no-parent", "--cwd"]);
  assert.equal(args[5], "/w");
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["claude", "--effort", "high"]);
  const labels = args.flatMap((a, i) => (args[i - 1] === "--label" ? [a] : []));
  assert.deepEqual(labels.sort(), [
    "herdr.role=orchestrator", "herdr.workflow.folder=/w", "herdr.workflow.run=22-x", "herdr.workflow.ticket=o/r#22",
  ]);
  assert.ok(!labels.some((l) => l.startsWith("herdr.space") || l.startsWith("herdr.tab")), "those would adopt it into a pane");
});

test("no space label is written: the ticket's space is found by its worktree", () => {
  const args = orchestratorRunArgs({ id: "a", key: "k", workDir: "/w", argv: ["x"] });
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

test("the repo's space whose folder drifted into the worktree is not the ticket's: its first terminal, still at the repo, decides", async () => {
  const drifted = [{ ...TICKET[0], folder: "/wt/ticket" }]; // folder follows the focused pane, which is in the worktree
  const panes = [{ pane: "pA", tab: "tA", cwd: "/r" }, { pane: "pB", tab: "tB", cwd: "/wt/ticket" }];
  const ticketSpace = findTicketSpace({ spaces: drifted, panes, ...where });
  assert.equal(ticketSpace, null);
  // so Merge closes only the run's tab in it, never the repo's space
  const core = fakeCore({ live: [] });
  const calls = [];
  await endRun(endDeps(core, { spaces: drifted, panes, ticketSpace, run: (n, a) => calls.push([n, a]) }));
  assert.deepEqual(calls, [["tab.close", { id: "tB" }]]);
});

test("with no first terminal known (no panes, or none with a cwd) the space's own folder decides", () => {
  assert.equal(findTicketSpace({ spaces: TICKET, panes: [], ...where }), "sT");
  assert.equal(findTicketSpace({ spaces: TICKET, panes: [{ pane: "pT", tab: "tT" }], ...where }), "sT");
  const elsewhere = TICKET.map((s) => (s.id === "sT" ? { ...s, folder: "/wt/other" } : s));
  assert.equal(findTicketSpace({ spaces: elsewhere, panes: [], ...where }), null);
  assert.equal(findTicketSpace({ spaces: [TICKET[0]], panes: [], ...where }), null, "the repo's space still never matches");
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

test("a show that doesn't hold in an investigation's tab says agent, not orchestrator, and points at the sidebar row", async () => {
  const f = fakeApp({ shownAfter: 99 });
  const warned = [];
  f.deps.warn = (m) => warned.push(m);
  await connectRun(f.deps, { ...base, kind: "investigation" });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /agent t7/);
  assert.doesNotMatch(warned[0], /orchestrator/);
  assert.doesNotMatch(warned[0], /View on the ticket/);
});

test("an investigation's agent that couldn't be shown says agent too", async () => {
  const f = fakeApp({ fail: { "terminal.show": "no such terminal t7" } });
  await assert.rejects(connectRun(f.deps, { ...base, kind: "investigation" }), /the agent t7 couldn't be shown/);
});

test("an investigation whose agent ended opens a tab with the page and a note that says so: no failure when it can't be shown, nothing to hold or warn about", async () => {
  const f = fakeApp({ fail: { "terminal.show": "no such terminal t7" }, shownAfter: 99 });
  const warned = [];
  f.deps.warn = (m) => warned.push(m);
  const got = await connectRun(f.deps, { ...base, kind: "investigation-ended" });
  assert.deepEqual(got, { tab: "tNew", left: "pNew", space: "s2" });
  assert.deepEqual(f.calls.map((c) => c[0]), ["tab.new", "terminal.show", "pane.split"], "tried to show it once, then opened the page");
  assert.deepEqual(f.calls[0][1].argv, placeholderArgv("t7", "investigation-ended"));
  assert.match(f.calls[0][1].argv[2], /ended/);
  assert.match(f.calls[0][1].argv[2], /Done/);
  assert.deepEqual(warned, []);
  assert.deepEqual(f.slots.r1, { tab: "tNew", left: "pNew", space: "s2" });
  assert.equal(f.runs.some((r) => r[0] === "tab.close"), false);
});

test("the ended note's placeholder still counts as the agent's own for finding its tab", () => {
  const terminals = [{ address: "tp", argv: placeholderArgv("t7", "investigation-ended") }];
  const spaces = [{ id: "s1", tabs: [{ id: "tA" }] }];
  const panes = [{ pane: "pA", tab: "tA", terminal: "tp" }, { pane: "pP", tab: "tA", mod: "github-tasks" }];
  assert.deepEqual(slotFromPage({ orchestrators: ["t7"], terminals, spaces, panes, slot: null }), { tab: "tA", left: "pA", space: "s1" });
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
const launch = { id: "r1", key: "o/r#1", workDir: "/w", argv: ["claude"], task: "Read x and follow it.", props: { role: "run", id: "r1", orchestrator: null } };

test("launch: pane.json is written and the tab opened before the wait for the agent to boot, then the task is sent", async () => {
  const f = fakeLaunch();
  const got = await launchRun(f.deps, launch);
  assert.deepEqual(f.log, ["hc run --bg", "pane.json t9", "connect", "hc wait t9", "hc send t9"]);
  assert.deepEqual(got, { orchestrator: "t9", problems: [], host: null });
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

// restartOrchestrator: a new orchestrator for a run whose own has ended, with a task of its own.
function fakeRestart({ ready = answer({ reason: "status", status: "idle", ended: true }), send = { code: 0, stdout: "", stderr: "" }, run = { code: 0, stdout: '{"address":"t9"}', stderr: "" }, show = async () => {} } = {}) {
  const log = [], runs = [];
  const deps = {
    hc: async (a) => {
      log.push(`hc ${a.slice(0, 2).join(" ")}`);
      if (a[0] === "run") { runs.push(a); return run; }
      if (a[0] === "wait") return ready;
      if (a[0] === "send") return send;
      return { code: 0, stdout: "", stderr: "" };
    },
    writePaneJson: async (props) => { log.push(`pane.json ${props.orchestrator}`); },
    saveOrchestrator: (address) => log.push(`save ${address}`),
    show: async (address) => { log.push(`show ${address}`); return show(address); },
  };
  return { deps, log, runs };
}
const restart = { id: "r1", key: "o/r#1", workDir: "/w", argv: ["claude", "--effort", "high"], task: "Read x. Fix only this.", props: { role: "run", id: "r1", orchestrator: "t5", folder: "/w" } };

test("restart: starts it like the first one, saves its address, shows it, waits for it, then sends the task", async () => {
  const f = fakeRestart();
  const got = await restartOrchestrator(f.deps, restart);
  assert.deepEqual(f.log, ["hc run --bg", "pane.json t9", "save t9", "show t9", "hc wait t9", "hc send t9"]);
  assert.deepEqual(f.runs[0], orchestratorRunArgs({ id: "r1", key: "o/r#1", workDir: "/w", argv: ["claude", "--effort", "high"] }));
  assert.deepEqual(got, { orchestrator: "t9", problems: [] });
});

test("restart: pane.json gets the run's props with the new address", async () => {
  let written;
  const f = fakeRestart();
  f.deps.writePaneJson = async (p) => { written = p; };
  await restartOrchestrator(f.deps, restart);
  assert.deepEqual(written, { role: "run", id: "r1", orchestrator: "t9", folder: "/w" });
});

test("restart: a pane.json that can't be written is a problem to say, and the run goes on", async () => {
  const f = fakeRestart();
  f.deps.writePaneJson = async () => { throw new Error("file changed"); };
  const got = await restartOrchestrator(f.deps, restart);
  assert.match(got.problems[0], /pane\.json.*file changed.*View/);
  assert.ok(f.log.includes("hc send t9") && f.log.includes("save t9"));
});

test("restart: a tab that can't show it is a problem to say, and the task is still sent", async () => {
  const f = fakeRestart({ show: async () => { throw new Error("no pane"); } });
  const got = await restartOrchestrator(f.deps, restart);
  assert.match(got.problems[0], /no pane/);
  assert.match(got.problems[0], /View/);
  assert.ok(f.log.includes("hc send t9"));
});

test("restart: without the command that starts it, it says so and starts nothing", async () => {
  const f = fakeRestart();
  for (const argv of [undefined, [], "claude"]) await assert.rejects(restartOrchestrator(f.deps, { ...restart, argv }), /can't be started again/);
  await assert.rejects(restartOrchestrator(f.deps, { ...restart, key: undefined }), /can't be started again/);
  assert.deepEqual(f.log, []);
});

test("restart: an orchestrator that doesn't start throws and saves nothing", async () => {
  const f = fakeRestart({ run: { code: 1, stdout: "", stderr: "no such program" } });
  await assert.rejects(restartOrchestrator(f.deps, restart), /didn't start.*no such program/);
  assert.deepEqual(f.log, ["hc run --bg"]);
});

test("restart: an agent that ended while starting is killed and removed, and no task is sent", async () => {
  const f = fakeRestart({ ready: answer({ reason: "exit", status: null, ended: true, exit_code: 1 }) });
  await assert.rejects(restartOrchestrator(f.deps, restart), /ended while starting/);
  assert.ok(!f.log.includes("hc send t9"));
  assert.deepEqual(f.log.slice(-2), ["hc kill t9", "hc rm t9"]);
});

test("restart: a task that can't be sent kills and removes the new orchestrator and says why", async () => {
  const f = fakeRestart({ send: { code: 1, stdout: "", stderr: "terminal is busy" } });
  await assert.rejects(restartOrchestrator(f.deps, restart), /terminal is busy/);
  assert.deepEqual(f.log.slice(-2), ["hc kill t9", "hc rm t9"]);
});

// #35: the saved slot can go stale (Herdr gives the tab and its panes new ids after a restart) while the run's tab is open
// and whole. panes() carries only pane, terminal (null for a mod pane), mod, tab, title, cwd... (no props), so the run page
// is told apart by being the tab's github-tasks pane, and the tab by its name (spaces()[].tabs[].name, the ticket's name).
// The run's identity as start.js passes it: its orchestrator and the live terminals (every terminal here is its placeholder).
const ID = { orchestrators: ["o1"], terminals: ["t1", "t2", "t5", "t8", "t9"].map((address) => ({ address, argv: placeholderArgv("o1") })) };
const NAMED = [{ id: "s1", tabs: [{ id: "tA", name: "1" }, { id: "tX", name: "#22 x" }] }];
const NPANES = [{ pane: "pA", tab: "tA", terminal: "t9" }, { pane: "pX", tab: "tX", terminal: "t8" }, { pane: "pP", tab: "tX", mod: "github-tasks", terminal: null }];

test("#35 a stale left pane id: the tab's terminal pane is its left pane", () => {
  const got = runTabParts({ slot: { tab: "tX", left: "pOld" }, spaces: NAMED, panes: NPANES, name: "#22 x", ...ID, ticketSpace: "s1" });
  assert.deepEqual(got, { tab: "tX", space: "s1", left: "pX", page: "pP" });
  assert.equal(runTabParts({ slot: { tab: "tX", left: "pOld" }, spaces: NAMED, panes: NPANES }).left, null, "without the name the slot is all there is");
});

test("#35 a stale tab id too: the complete tab is found again by the run's name", () => {
  const got = runTabParts({ slot: { tab: "tOld", left: "pOld" }, spaces: NAMED, panes: NPANES, name: "#22 x", ...ID, ticketSpace: "s1" });
  assert.deepEqual(got, { tab: "tX", space: "s1", left: "pX", page: "pP" });
  assert.deepEqual(findRunTab({ slot: { tab: "tOld", left: "pOld" }, spaces: NAMED, panes: NPANES, name: "#22 x", ...ID, ticketSpace: "s1" }), { tab: "tX", left: "pX", space: "s1" });
});

test("#35 a complete tab behind a stale slot is not given a second placeholder", async () => {
  const existing = runTabParts({ slot: { tab: "tX", left: "pOld" }, spaces: NAMED, panes: NPANES, name: "#22 x", ...ID, ticketSpace: "s1" });
  const f = fakeApp();
  f.deps.app = ((app) => async (name, args) => { const r = await app(name, args); return name === "pane.split" && args.argv ? { pane: "pLeft", terminal: "tp2" } : r; })(f.deps.app);
  await connectRun(f.deps, { ...base, existing });
  assert.deepEqual(f.calls.filter((c) => c[0] === "pane.split"), [], "neither a left placeholder nor the run page is split in");
  assert.deepEqual(f.slots.r1, { tab: "tX", left: "pX", space: "s1" }, "the slot is made good");
});

test("#35 a ticket editor tab of the same name (a mod pane, no terminal) is never taken for the run's tab", () => {
  const spaces = [{ id: "s1", tabs: [{ id: "tE", name: "#22 x" }] }];
  const panes = [{ pane: "pE", tab: "tE", mod: "github-tasks", terminal: null }];
  assert.equal(runTabParts({ slot: { tab: "tOld", left: "pOld" }, spaces, panes, name: "#22 x", ...ID }), null);
  assert.equal(findRunTab({ slot: null, spaces, panes, name: "#22 x", ...ID }), null);
});

test("#35 of two same-named tabs the whole one is taken, and the slot's space first", () => {
  const spaces = [{ id: "s1", tabs: [{ id: "tE", name: "#22 x" }] }, { id: "s2", tabs: [{ id: "tR", name: "#22 x" }] }, { id: "s3", tabs: [{ id: "tQ", name: "#22 x" }] }];
  const panes = [
    { pane: "pE", tab: "tE", mod: "github-tasks", terminal: null },
    { pane: "pR", tab: "tR", terminal: "t1" }, { pane: "pRp", tab: "tR", mod: "github-tasks", terminal: null },
    { pane: "pQ", tab: "tQ", terminal: "t2" }, { pane: "pQp", tab: "tQ", mod: "github-tasks", terminal: null },
  ];
  assert.equal(runTabParts({ slot: { tab: "gone", space: "s3" }, spaces, panes, name: "#22 x", ...ID }).tab, "tQ");
  assert.equal(runTabParts({ slot: { tab: "gone" }, spaces, panes, name: "#22 x", ...ID, ticketSpace: "s2" }).tab, "tR");
});

// #35 review: the name match stays inside the slot's space and the ticket's own space.
test("#35 a same-named whole tab of another run in another space is not taken", () => {
  const spaces = [{ id: "s1", tabs: [{ id: "tY", name: "#22 x" }] }, { id: "sT", tabs: [{ id: "tZ", name: "1" }] }];
  const panes = [{ pane: "pY", tab: "tY", terminal: "t1" }, { pane: "pYp", tab: "tY", mod: "github-tasks", terminal: null }];
  assert.equal(runTabParts({ slot: { tab: "gone", space: "sGone" }, spaces, panes, name: "#22 x", ...ID, ticketSpace: "sT" }), null);
  assert.equal(runTabParts({ slot: { tab: "gone", space: "s1" }, spaces, panes, name: "#22 x", ...ID, ticketSpace: "sT" }).tab, "tY", "the slot's own space is searched");
  const inTicket = [{ id: "sT", tabs: [{ id: "tT", name: "#22 x" }] }];
  const tp = [{ pane: "pT", tab: "tT", terminal: "t1" }, { pane: "pTp", tab: "tT", mod: "github-tasks", terminal: null }];
  assert.equal(runTabParts({ slot: null, spaces: inTicket, panes: tp, name: "#22 x", ...ID, ticketSpace: "sT" }).tab, "tT", "so is the ticket's");
  assert.equal(runTabParts({ slot: null, spaces: inTicket, panes: tp, name: "#22 x", ...ID }), null, "no ticket space given, none searched");
});

test("#35 a named tab with more than one terminal pane is not adopted", () => {
  const panes = [...NPANES, { pane: "pSh", tab: "tX", terminal: "t5" }];
  assert.equal(runTabParts({ slot: { tab: "tOld" }, spaces: NAMED, panes, name: "#22 x", ...ID, ticketSpace: "s1" }), null);
});

// spaces for viewQuick/viewConnect: s1 holds the run's tab tX; its first terminal (pA) is in the worktree (the ticket's space) or
// at the repo root (the repo's space).
const viewFixture = ({ inTicket = true, ...over } = {}) => {
  const log = [], slots = [];
  const panes = NPANES.map((p) => (p.pane === "pA" ? { ...p, cwd: inTicket ? "/wt" : "/r" } : p));
  return { log, slots, args: {
    slot: { tab: "tX", left: "pX", space: "s1" }, spaces: NAMED, panes, name: "#22 x", folder: "/wt", repoRoot: "/r", ...ID,
    setSlot: (s) => slots.push(s), run: (n, a) => log.push([n, a]), show: (left) => log.push(["show", left]),
    connect: async (existing) => { log.push(["connect", existing]); }, closeTab: (tab) => log.push(["close", tab]), ...over,
  } };
};

test("#35 the quick path selects the whole tab, shows the orchestrator and rewrites a stale slot", () => {
  const f = viewFixture({ slot: { tab: "tOld", left: "pOld", space: "s1" } });
  assert.equal(viewQuick(f.args), true);
  assert.deepEqual(f.slots, [{ tab: "tX", left: "pX", space: "s1" }]);
  assert.deepEqual(f.log, [["space.select", { id: "s1" }], ["tab.select", { id: "tX" }], ["show", "pX"]]);
});

test("#35 no quick path for a tab outside the ticket's space (it is rebuilt), nor for a missing tab", () => {
  assert.equal(viewQuick(viewFixture({ inTicket: false }).args), false);
  assert.equal(viewQuick(viewFixture({ panes: [], slot: null }).args), false);
  assert.equal(viewQuick(viewFixture({ inTicket: false, folder: "" }).args), true, "no worktree known: it stays where it is");
});

test("#35 a repo space whose first terminal is inside the worktree is never the ticket's space, given the repo root", async () => {
  const repoSpace = [{ id: "s1", folder: "/r", tabs: [{ id: "tA", name: "1" }, { id: "tX", name: "#22 x" }] }];
  const f = viewFixture({ spaces: repoSpace });
  assert.equal(viewQuick(f.args), false, "with the repo root the repo space is skipped, so the tab is outside a ticket space");
  await viewConnect(f.args);
  assert.deepEqual(f.log, [["connect", null], ["close", "tX"]]);
  assert.equal(viewQuick(viewFixture({ spaces: repoSpace, repoRoot: undefined }).args), true, "without it the repo space would pass for the ticket's");
});

test("#35 a whole tab the slot points at, outside a ticket space, is rebuilt and the old tab closed only after that worked", async () => {
  const f = viewFixture({ inTicket: false });
  await viewConnect(f.args);
  assert.deepEqual(f.log, [["connect", null], ["close", "tX"]]);
  const g = viewFixture({ inTicket: false, connect: async () => { throw new Error("no"); } });
  await assert.rejects(viewConnect(g.args), /no/);
  assert.deepEqual(g.log, [], "the old tab is kept when connecting fails");
});

test("#35 a tab found only by name is never closed by a rebuild, and a partial tab is repaired in place", async () => {
  const byName = viewFixture({ inTicket: false, slot: { tab: "gone", space: "s1" } });
  await viewConnect(byName.args);
  assert.equal(byName.log.find((c) => c[0] === "connect")[1].tab, "tX");
  assert.ok(!byName.log.some((c) => c[0] === "close"));
  const partial = viewFixture({ panes: viewFixture().args.panes.filter((p) => p.pane !== "pP") });
  await viewConnect(partial.args);
  assert.deepEqual(partial.log, [["connect", { tab: "tX", space: "s1", left: "pX", page: null }]]);

});

// slotFromPage: the run tab's slot, healed from the run's placeholder terminal (exact), never guessed.
const HEAL_SPACES = [{ id: "s1", tabs: [{ id: "tA" }, { id: "tB" }] }, { id: "s2", tabs: [{ id: "tC" }] }];
const HEAL_PANES = [{ pane: "pA", tab: "tA", terminal: "t9" }, { pane: "pB", tab: "tB", terminal: "t8" }, { pane: "pM", tab: "tB", mod: "github-tasks", terminal: null }];
const HEAL_TERMS = [{ address: "t8", argv: placeholderArgv("o1") }, { address: "t9", argv: ["claude"] }];
const heal = (over = {}) => slotFromPage({ orchestrators: ["o1"], terminals: HEAL_TERMS, spaces: HEAL_SPACES, panes: HEAL_PANES, slot: null, ...over });

test("slotFromPage: a stale tab id is replaced by the tab of the run's placeholder, with its space", () => {
  assert.deepEqual(heal({ slot: { tab: "gone", left: "pB", space: "s9" } }), { tab: "tB", left: "pB", space: "s1" });
});

test("slotFromPage: a stale left id becomes the placeholder's pane", () => {
  assert.deepEqual(heal({ slot: { tab: "tB", left: "gone", space: "s1" } }), { tab: "tB", left: "pB", space: "s1" });
});

test("slotFromPage: with no saved slot one is made, as the tab is unambiguous", () => {
  assert.deepEqual(heal(), { tab: "tB", left: "pB", space: "s1" });
});

test("slotFromPage: any of the run's orchestrators names the placeholder", () => {
  assert.deepEqual(heal({ orchestrators: ["o2", "o1"] }), { tab: "tB", left: "pB", space: "s1" });
});

test("slotFromPage: an already-correct slot comes back as the same object", () => {
  const slot = { tab: "tB", left: "pB", space: "s1" };
  assert.equal(heal({ slot }), slot);
});

test("slotFromPage: no placeholder terminal for the run gives null", () => {
  assert.equal(heal({ orchestrators: ["other"] }), null);
  assert.equal(heal({ orchestrators: [] }), null);
});

test("slotFromPage: placeholders in two tabs are ambiguous, so null", () => {
  const terminals = [...HEAL_TERMS, { address: "t7", argv: placeholderArgv("o1") }];
  const panes = [...HEAL_PANES, { pane: "pC", tab: "tC", terminal: "t7" }];
  assert.equal(heal({ terminals, panes }), null);
});

test("slotFromPage: a tab without exactly one run page gives null", () => {
  assert.equal(heal({ panes: HEAL_PANES.filter((p) => p.mod !== "github-tasks") }), null);
  assert.equal(heal({ panes: [...HEAL_PANES, { pane: "pN", tab: "tB", mod: "github-tasks", terminal: null }] }), null);
});

test("slotFromPage: the live argv, wrapped by a login shell, still names the orchestrator", () => {
  const wrapped = ["/bin/zsh", "-lic", '"$@"; exec "$0" -li', "/bin/zsh", ...placeholderArgv("o1")];
  assert.deepEqual(heal({ terminals: [{ address: "t8", argv: wrapped }] }), { tab: "tB", left: "pB", space: "s1" });
  assert.deepEqual(heal({ terminals: [{ address: "t8", argv: placeholderArgv("o1") }] }), { tab: "tB", left: "pB", space: "s1" });
});

test("slotFromPage: after a restart the placeholder names the old orchestrator; the new one and the opened-with one are both offered", () => {
  const terminals = [{ address: "t8", argv: placeholderArgv("old") }];
  assert.deepEqual(heal({ terminals, orchestrators: ["new", "old"] }), { tab: "tB", left: "pB", space: "s1" });
  assert.equal(heal({ terminals, orchestrators: ["new"] }), null);
});

// #35 final review: a same-named tab is the run's only when its terminal is the run's own placeholder.
const OLD = { orchestrators: ["t13q"], terminals: [{ address: "t8", argv: placeholderArgv("told") }] };
const WRAP = (o) => ["/bin/zsh", "-lic", '"$@"; exec "$0" -li', "/bin/zsh", ...placeholderArgv(o)];

test("#35 an older leftover tab of the same name, whose placeholder names another orchestrator, is not taken", () => {
  assert.equal(runTabParts({ slot: { tab: "tOld", left: "pOld" }, spaces: NAMED, panes: NPANES, name: "#22 x", ticketSpace: "s1", ...OLD }), null);
  assert.equal(findRunTab({ slot: null, spaces: NAMED, panes: NPANES, name: "#22 x", ticketSpace: "s1", ...OLD }), null);
  assert.equal(runTabParts({ slot: null, spaces: NAMED, panes: NPANES, name: "#22 x", ticketSpace: "s1" }), null, "no identity given, nothing is taken");
});

test("#35 this run's placeholder, wrapped by a login shell, is taken", () => {
  const terminals = [{ address: "t8", argv: WRAP("t13q") }];
  const got = runTabParts({ slot: { tab: "tOld", left: "pOld" }, spaces: NAMED, panes: NPANES, name: "#22 x", ticketSpace: "s1", orchestrators: ["told", "t13q"], terminals });
  assert.deepEqual(got, { tab: "tX", space: "s1", left: "pX", page: "pP" });
});

// viewQuick also takes a whole tab in another space while the ticket's own space exists: the person may have put it there.
test("#35 viewQuick keeps a whole tab the person moved to another space while the ticket's space exists", () => {
  const spaces = [{ id: "sT", tabs: [{ id: "tA", name: "1" }] }, { id: "s2", tabs: [{ id: "tX", name: "#22 x" }] }];
  const panes = [{ pane: "pA", tab: "tA", terminal: "t9", cwd: "/wt" }, ...NPANES.filter((p) => p.tab === "tX")];
  const f = viewFixture({ spaces, panes, slot: { tab: "tX", left: "pX", space: "s2" } });
  assert.equal(viewQuick(f.args), true);
  assert.deepEqual(f.log, [["space.select", { id: "s2" }], ["tab.select", { id: "tX" }], ["show", "pX"]]);
});

// ---- #41: the run's host terminal, the parent that makes the Agents panel list the orchestrator and its workers ----

const HOST_ARGS = { id: "41-mw8u4rxz", key: "o/r#41", workDir: "/w", argv: ["claude"] };

test("#41 with a parent the orchestrator keeps its labels and outlives it, with no notes typed into it and a name of its own", () => {
  const args = orchestratorRunArgs({ ...HOST_ARGS, parent: "t5" });
  assert.ok(!args.includes("--no-parent"));
  assert.equal(args[args.indexOf("--parent") + 1], "t5");
  assert.ok(args.includes("--outlive-parent"));
  assert.ok(args.includes("--no-notify"));
  assert.equal(args[args.indexOf("--name") + 1], "41-mw8u4rxz-orch");
  const labels = args.flatMap((a, i) => (args[i - 1] === "--label" ? [a] : []));
  assert.deepEqual(labels.sort(), ["herdr.role=orchestrator", "herdr.workflow.folder=/w", "herdr.workflow.run=41-mw8u4rxz", "herdr.workflow.ticket=o/r#41"]);
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["claude"]);
});

test("#41 the orchestrator's name is a valid hc name even for a long run id; with no parent it is as before", () => {
  const name = (id) => { const a = orchestratorRunArgs({ ...HOST_ARGS, id, parent: "t5" }); return a[a.indexOf("--name") + 1]; };
  for (const id of ["41-mw8u4rxz", "x".repeat(60), "draft-Ab.c d"]) assert.match(name(id), /^[a-z0-9_-]{1,32}$/);
  assert.ok(name("x".repeat(60)).endsWith("-orch"));
  const bare = orchestratorRunArgs(HOST_ARGS);
  assert.ok(bare.includes("--no-parent") && !bare.includes("--parent") && !bare.includes("--outlive-parent") && !bare.includes("--no-notify"));
});

test("#41 the host reports a status by OSC 7501, says what it is, and waits for ever without reading input", () => {
  const argv = hostArgv();
  assert.deepEqual(argv.slice(0, 2), ["sh", "-c"]);
  const sh = spawnSync("sh", ["-c", argv[2].replace(/exec tail -f \/dev\/null/, "true")], { encoding: "utf8" });
  assert.equal(sh.status, 0);
  assert.ok(sh.stdout.startsWith("\x1b]7501;state=idle\x07"), "the report comes first, in the format the core reads");
  assert.match(sh.stdout.slice(sh.stdout.indexOf("\x07") + 1), /^[^\n]+\n$/, "one line of note");
  assert.match(argv[2], /exec tail -f \/dev\/null$/);
  assert.ok(!/\bread\b|\bcat\b/.test(argv[2]));
});

test("#41 the host tab is named for the ticket", () => {
  assert.equal(hostTabName({ number: 41, title: "Agents" }), "#41 agents");
  assert.equal(hostTabName({ title: "A draft" }), "A draft agents");
});

const REPO = "/home/me/repo";
const RSPACES = [
  { id: "sR", folder: REPO, tabs: [{ id: "tR" }] },
  { id: "sT", folder: "/wt/repo/b", tabs: [{ id: "tT" }] },
  { id: "sM", folder: REPO, machine: "vps", tabs: [{ id: "tM" }] },
];
const RPANES = [{ pane: "pR", tab: "tR", terminal: "t1", cwd: REPO }, { pane: "pT", tab: "tT", terminal: "t2", cwd: "/wt/repo/b" }];

test("#41 the repo's space is the one whose first terminal is in the main checkout, never the ticket's or another machine's", () => {
  assert.equal(findRepoSpace({ spaces: RSPACES, panes: RPANES, repoRoot: REPO }), "sR");
  assert.equal(findRepoSpace({ spaces: RSPACES, panes: [{ pane: "pR", tab: "tR", terminal: "t1", cwd: `${REPO}/sub` }], repoRoot: REPO }), "sR");
  assert.equal(findRepoSpace({ spaces: RSPACES.slice(1), panes: RPANES, repoRoot: REPO }), null);
  assert.equal(findRepoSpace({ spaces: RSPACES, panes: RPANES, repoRoot: "" }), null);
});

function fakeHostApp({ terminal = "t20", label = { code: 0, stdout: "", stderr: "" }, tabFails = false } = {}) {
  const log = [];
  return {
    log,
    deps: {
      app: async (n, a) => { log.push([n, a]); if (tabFails) throw new Error("no"); return n === "space.new" ? { space: "sN", tab: "tN", terminal } : { tab: "tN", terminal }; },
      hc: async (a) => { log.push(["hc", a]); return a[0] === "label" ? label : { code: 0, stdout: "", stderr: "" }; },
      run: (n, a) => log.push([n, a]),
    },
  };
}
const OPEN = { id: "41-x", name: "#41 agents", repoRoot: REPO, spaces: RSPACES, panes: RPANES };

test("#41 the host opens as a tab in the repo's space, rooted at the main checkout, and is labelled so it can be found again", async () => {
  const f = fakeHostApp();
  const host = await openHost(f.deps, OPEN);
  assert.deepEqual(host, { address: "t20", tab: "tN", space: "sR", created: false });
  const [n, a] = f.log[0];
  assert.equal(n, "tab.new");
  assert.deepEqual({ ...a, argv: undefined }, { name: "#41 agents", folder: REPO, space: "sR", argv: undefined });
  assert.deepEqual(a.argv, hostArgv());
  assert.deepEqual(f.log[1], ["hc", ["label", "t20", "herdr.workflow.host=41-x", "herdr.role=host"]]);
});

test("#41 the host never carries the run label (the run page would list it as an agent) nor the space and tab labels", async () => {
  const f = fakeHostApp();
  await openHost(f.deps, OPEN);
  const labels = f.log.find(([n]) => n === "hc")[1].slice(2);
  assert.ok(!labels.some((l) => l.startsWith("herdr.workflow.run") || l.startsWith("herdr.space") || l.startsWith("herdr.tab") || l.startsWith("herdr.workflow.folder")));
});

test("#41 with the repo's space not open the host gets a space of its own named for the repo, and says it made it", async () => {
  const f = fakeHostApp();
  const host = await openHost(f.deps, { ...OPEN, spaces: [], panes: [] });
  assert.deepEqual(host, { address: "t20", tab: "tN", space: "sN", created: true });
  assert.equal(f.log[0][0], "space.new");
  assert.deepEqual(f.log[0][1], { name: "repo", tab: "#41 agents", folder: REPO, argv: hostArgv() });
});

test("#41 a host that can't be made or labelled throws, and a tab made is closed again", async () => {
  await assert.rejects(openHost(fakeHostApp({ tabFails: true }).deps, OPEN), /host tab couldn't be made/);
  const f = fakeHostApp({ label: { code: 1, stdout: "", stderr: "nope" } });
  await assert.rejects(openHost(f.deps, OPEN), /couldn't be labelled.*nope/);
  assert.ok(f.log.some(([n, a]) => n === "hc" && a[0] === "kill"), "the unlabelled host can't be found later: it is ended");
  assert.ok(f.log.some(([n, a]) => n === "tab.close" && a.id === "tN"));
  const g = fakeHostApp({ terminal: null });
  await assert.rejects(openHost(g.deps, OPEN), /no terminal/);
});

test("#41 the host is found by its label among the live terminals, not by saved ids", () => {
  const ts = [
    { address: "t1", state: "live", labels: { "herdr.workflow.host": "other" } },
    { address: "t2", state: "finished", labels: { "herdr.workflow.host": "41-x" } },
    { address: "t3", state: "live", labels: { "herdr.workflow.host": "41-x" } },
    { address: "t4", state: "live", labels: { "herdr.workflow.run": "41-x", "herdr.role": "orchestrator" } },
  ];
  assert.equal(findHost(ts, "41-x").address, "t3");
  assert.equal(findHost(ts, "nope"), null);
  assert.equal(findHost(undefined, "41-x"), null);
});

function fakeEnd({ stuck = false, live = true } = {}) {
  const log = [];
  let alive = live;
  return {
    log,
    deps: {
      id: "41-x",
      hc: async (a) => { log.push(["hc", ...a]); if (a[0] === "kill") { if (stuck) return { code: 1, stderr: "denied", stdout: "" }; alive = false; } return { code: 0, stdout: "", stderr: "" }; },
      terminals: () => (alive ? [{ address: "t20", state: "live", labels: { "herdr.workflow.host": "41-x" } }] : []),
      run: (n, a) => log.push([n, a]),
      spaces: [{ id: "sR", tabs: [{ id: "tR" }, { id: "tH" }] }], panes: [{ pane: "pH", tab: "tH", terminal: "t20" }],
      record: { tab: "tH", space: "sR", created: false },
    },
  };
}

test("#41 ending the host kills and removes it, then closes its tab (the repo's space stays)", async () => {
  const f = fakeEnd();
  assert.deepEqual(await endHost(f.deps), { error: null });
  assert.deepEqual(f.log, [["hc", "kill", "t20"], ["hc", "rm", "t20"], ["tab.close", { id: "tH", confirmed: true }]]);
});

test("#41 a space made for the host is closed with it, but only when it holds nothing else", async () => {
  const only = fakeEnd();
  only.deps.spaces = [{ id: "sH", tabs: [{ id: "tH" }] }];
  only.deps.record = { tab: "tH", space: "sH", created: true };
  await endHost(only.deps);
  assert.deepEqual(only.log.at(-1), ["space.close", { id: "sH", confirmed: true }]);
  const shared = fakeEnd();
  shared.deps.spaces = [{ id: "sH", tabs: [{ id: "tH" }, { id: "tO" }] }];
  shared.deps.record = { tab: "tH", space: "sH", created: true };
  await endHost(shared.deps);
  assert.ok(!shared.log.some(([n]) => n === "space.close"));
});

test("#41 a host already gone is no failure, a host that can't be killed is an error naming it, and a tab already closed doesn't throw", async () => {
  const gone = fakeEnd({ live: false });
  assert.deepEqual(await endHost(gone.deps), { error: null });
  assert.ok(!gone.log.some(([n]) => n === "hc"));
  const stuck = fakeEnd({ stuck: true });
  const got = await endHost(stuck.deps);
  assert.match(got.error, /t20: denied/);
  assert.ok(!stuck.log.some(([n]) => n === "tab.close"), "a live host keeps its tab");
  const closed = fakeEnd();
  closed.deps.run = () => { throw new Error("no such tab"); };
  assert.deepEqual(await endHost(closed.deps), { error: null });
});

test("#41 a host just made, whose label the app doesn't list yet, is still ended when named", async () => {
  const f = fakeEnd({ live: false });
  assert.deepEqual(await endHost({ ...f.deps, also: ["t20"] }), { error: null });
  assert.deepEqual(f.log, [["hc", "kill", "t20"], ["hc", "rm", "t20"], ["tab.close", { id: "tH", confirmed: true }]]);
});

test("#41 the host tab is never mistaken for the run's tab, even in the same space and under the same name", () => {
  const spaces = [{ id: "s1", tabs: [{ id: "tH", name: "#22 x" }] }];
  const panes = [{ pane: "pH", tab: "tH", terminal: "t20" }];
  const terminals = [{ address: "t20", state: "live", argv: hostArgv(), labels: { "herdr.workflow.host": "r1" } }];
  for (const slot of [null, { tab: "tOld", left: "pOld", space: "s1" }]) assert.equal(runTabParts({ slot, spaces, panes, name: "#22 x", ticketSpace: "s1", orchestrators: ["t7"], terminals }), null);
  assert.equal(slotFromPage({ orchestrators: ["t7"], terminals, spaces, panes, slot: null }), null);
});

test("#41 Merge ends the host too, after the run's terminals and before the ticket's space goes", async () => {
  const core = fakeCore();
  const base = core.terminals;
  let hostAlive = true;
  core.terminals = () => [...base(), ...(hostAlive ? [{ address: "tH1", state: "live", labels: { "herdr.workflow.host": "r1" } }] : [])];
  const hc = core.hc;
  core.hc = async (a) => { if (a[0] === "kill" && a[1] === "tH1") hostAlive = false; return hc(a); };
  const got = await endRun(endDeps(core, { terminals: core.terminals, hc: core.hc, host: { tab: "tHT", space: "sRepo", created: false }, panes: [...PANES, { pane: "pH", tab: "tHT", terminal: "tH1" }], clearHost: () => core.log.push("clear host") }));
  assert.deepEqual(got, { closed: true, error: null });
  assert.deepEqual(core.log, ["kill t7", "rm t7", "kill t3", "rm t3", "kill tH1", "rm tH1", "tab.close tHT", "clear host", "clear", "space.close s1"]);
});

test("#41 a host that can't be ended keeps the space and says so, like any terminal that won't die", async () => {
  const core = fakeCore({ live: ["t7"] });
  const base = core.terminals;
  core.terminals = () => [...base(), { address: "tH1", state: "live", labels: { "herdr.workflow.host": "r1" } }];
  const hc = core.hc;
  core.hc = async (a) => (a[0] === "kill" && a[1] === "tH1" ? { code: 1, stderr: "denied", stdout: "" } : hc(a));
  const got = await endRun(endDeps(core, { terminals: core.terminals, hc: core.hc, panes: PANES }));
  assert.equal(got.closed, false);
  assert.match(got.error, /tH1: denied/);
  assert.ok(!core.log.includes("space.close s1"));
});

// launchRun with a host
function hostLaunch(over = {}) {
  const f = fakeLaunch(over.launch);
  f.deps.openHost = async () => { f.log.push("open host"); if (over.hostFails) throw new Error("no room"); return { address: "tH", tab: "tHT", space: "sR", created: false }; };
  f.deps.closeHost = async (h) => { f.log.push(`close host ${h?.address}`); };
  const runs = [];
  const hc = f.deps.hc;
  f.deps.hc = async (a) => { if (a[0] === "run") runs.push(a); return hc(a); };
  return { ...f, runs };
}

test("#41 launch: the host opens first and the orchestrator is started under it", async () => {
  const f = hostLaunch();
  const got = await launchRun(f.deps, launch);
  assert.deepEqual(f.log.slice(0, 2), ["open host", "hc run --bg"]);
  assert.equal(f.runs[0][f.runs[0].indexOf("--parent") + 1], "tH");
  assert.deepEqual(f.runs[0], orchestratorRunArgs({ ...launch, parent: "tH" }));
  assert.deepEqual(got, { orchestrator: "t9", problems: [], host: { address: "tH", tab: "tHT", space: "sR", created: false } });
});

test("#41 launch: a host that won't open is a problem to say and the run starts as before, with no parent", async () => {
  const f = hostLaunch({ hostFails: true });
  const got = await launchRun(f.deps, launch);
  assert.deepEqual(f.runs[0], orchestratorRunArgs(launch));
  assert.equal(got.orchestrator, "t9");
  assert.equal(got.host, null);
  assert.match(got.problems[0], /Agents panel.*no room/);
});

test("#41 launch: when the start fails the host is ended again, whichever step failed", async () => {
  const noStart = hostLaunch({ launch: { run: { code: 1, stdout: "", stderr: "boom" } } });
  await assert.rejects(launchRun(noStart.deps, launch), /boom/);
  assert.ok(noStart.log.includes("close host tH"));
  const ended = hostLaunch({ launch: { ready: answer({ reason: "exit", exit_code: 1 }) } });
  await assert.rejects(launchRun(ended.deps, launch), /ended while starting/);
  assert.ok(ended.log.includes("close host tH"));
  const noTask = hostLaunch({ launch: { send: { code: 1, stdout: "", stderr: "no" } } });
  await assert.rejects(launchRun(noTask.deps, launch), /take its task/);
  assert.ok(noTask.log.includes("close host tH"));
  const fine = hostLaunch();
  await launchRun(fine.deps, launch);
  assert.ok(!fine.log.some((l) => String(l).startsWith("close host")), "a good start keeps its host");
});

test("#41 restart: the new orchestrator goes under the run's live host when there is one, else as before", async () => {
  const f = fakeRestart();
  f.deps.findHost = () => ({ address: "tH" });
  await restartOrchestrator(f.deps, restart);
  assert.deepEqual(f.runs[0], orchestratorRunArgs({ id: "r1", key: "o/r#1", workDir: "/w", argv: ["claude", "--effort", "high"], parent: "tH" }));
  const g = fakeRestart();
  g.deps.findHost = () => null;
  await restartOrchestrator(g.deps, restart);
  assert.deepEqual(g.runs[0], orchestratorRunArgs({ id: "r1", key: "o/r#1", workDir: "/w", argv: ["claude", "--effort", "high"] }));
});

test("#41 the host's saved record is per run", () => assert.notEqual(hostKey("a"), hostKey("b")));
