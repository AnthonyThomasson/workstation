import test from "node:test";
import assert from "node:assert/strict";
import { viewRunWith } from "./view-run.js";
import { RUN_LABEL, FOLDER_LABEL } from "./run.js";

// A fake Herdr: a list of panes and the calls made to it. The orchestrator's terminal t1 is running whatever happens to its tabs.
const ID = "19-abc";
const SAVED = { role: "run", id: ID, title: "#19 View", workflow: "Bug", branch: "workflow/19", folder: "/w", repoRoot: "/r", ticket: { number: 19, key: "x#19" }, projectId: "P", statusField: "S", stage: "review" };
const ticket = { number: 19, key: "x#19", title: "View" };

function setup({ labels, panes }) {
  const calls = [], notes = [];
  const state = { panes: [...panes], tabs: 0 };
  const deps = {
    home: () => "/home",
    run: (cmd, args) => { calls.push([cmd, args]); },
    panes: () => state.panes,
    notify: (n) => notes.push(n),
    readTextFile: async () => JSON.stringify(SAVED),
    // Only the commands View may use: a mod pane split beside a pane, or a running terminal given a pane in a new tab.
    app: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "pane.split") state.panes.push({ pane: "new", tab: state.panes.find((p) => p.pane === args.pane).tab, mod: args.mod, props: args.props });
      else if (cmd === "terminal.keep") state.panes.push({ pane: "kept", tab: `tab-${++state.tabs}`, terminal: args.terminal });
      else throw new Error(`unexpected ${cmd}`);
      return {};
    },
  };
  const running = { address: "t1", labels: { "herdr.space": "s1", "herdr.tab": "tOld", [RUN_LABEL]: ID, [FOLDER_LABEL]: "/w", ...labels } };
  const view = () => viewRunWith(running, { sleep: async () => {} }, { ticket, repo: "x", project: { id: "P" } }, deps);
  return { calls, notes, state, view };
}
const names = (calls) => calls.map(([c]) => c);

test("View on a run whose tab is open only selects the tab", async () => {
  const { calls, view } = setup({ panes: [{ pane: "p1", tab: "tOld", terminal: "t1" }, { pane: "p2", tab: "tOld", mod: "github-tasks" }] });
  await view();
  assert.deepEqual(calls, [["space.select", { id: "s1" }], ["tab.select", { id: "tOld" }]]);
});

test("View after only the run page was closed opens the page again beside the orchestrator", async () => {
  const { calls, state, view } = setup({ panes: [{ pane: "p1", tab: "tOld", terminal: "t1" }] });
  await view();
  const split = calls.find(([c]) => c === "pane.split")[1];
  assert.equal(split.pane, "p1");
  assert.equal(split.direction, "right");
  assert.equal(split.mod, "github-tasks");
  assert.equal(split.props.orchestrator, "t1");
  assert.equal(split.props.statusField, "S"); // the saved props, not just the labels
  assert.ok(state.panes.some((p) => p.mod === "github-tasks" && p.tab === "tOld"));
});

test("View after the run's whole tab was closed brings the running orchestrator back in a tab with the run page", async () => {
  // Closing the tab took its panes; the orchestrator terminal keeps running, still labelled with the dead tab id.
  const { calls, notes, state, view } = setup({ panes: [{ pane: "other", tab: "tElse", terminal: "t9" }] });
  await view();
  const back = state.panes.find((p) => p.terminal === "t1");
  const message = `View did nothing: no tab for the orchestrator (calls: ${names(calls).join(", ")}; notifications: ${notes.length})`;
  assert.ok(back, message);
  assert.ok(state.panes.some((p) => p.tab === back.tab && p.mod === "github-tasks" && p.props.id === ID), "the run page is beside it");
});
