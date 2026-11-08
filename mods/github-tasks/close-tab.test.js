import test from "node:test";
import assert from "node:assert/strict";
import { closeFocusedTab, closeConfirmed, closeMessage } from "./close-tab.js";

// A fake Herdr: tab "t-run" holds a run's orchestrator (terminal t1) beside its run page; tab "t-plain" holds a shell.
const orchestrator = (state = "live", extra = {}) => ({ address: "t1", state, labels: { "herdr.role": "orchestrator", "herdr.workflow.run": "19-abc", "herdr.workflow.ticket": "o/r#19", ...extra } });
function setup({ tab = "t-run", terminals = [orchestrator()], failRun = false } = {}) {
  const calls = [], asked = [], notes = [];
  const deps = {
    focused: () => (tab ? { tab } : null),
    panes: () => [{ pane: "p1", tab: "t-run", terminal: "t1" }, { pane: "p2", tab: "t-run", terminal: null, mod: "github-tasks" }, { pane: "p3", tab: "t-plain", terminal: "t2" }],
    terminals: () => [...terminals, { address: "t2", state: "live", labels: {} }],
    tabName: (id) => (id === "t-run" ? "#19 View reopens" : "1"),
    run: (cmd, args) => { calls.push([cmd, args]); if (failRun) throw new Error("no such tab"); },
    ask: (q) => asked.push(q),
    notify: (n) => notes.push(n),
  };
  return { deps, calls, asked, notes };
}

test("closing a tab that holds a live run asks first and closes nothing", async () => {
  const { deps, calls, asked } = setup();
  await closeFocusedTab(deps);
  assert.deepEqual(calls, []);
  assert.deepEqual(asked, [{ tab: "t-run", name: "#19 View reopens" }]);
});

test("the confirmed close closes the tab for good", async () => {
  const { deps, calls, notes } = setup();
  await closeConfirmed({ tab: "t-run" }, deps);
  assert.deepEqual(calls, [["tab.close", { id: "t-run", confirmed: true }]]);
  assert.deepEqual(notes, []);
});

test("cancelling leaves the tab: nothing is run until the person confirms", async () => {
  const { deps, calls } = setup();
  await closeFocusedTab(deps); // the dialog is shown; its Cancel runs nothing of ours
  assert.equal(calls.length, 0);
});

test("a tab without a run closes straight away, as the plain key does", async () => {
  const { deps, calls, asked } = setup({ tab: "t-plain" });
  await closeFocusedTab(deps);
  assert.deepEqual(calls, [["tab.close", { id: "t-plain" }]]);
  assert.deepEqual(asked, []);
});

test("a tab whose orchestrator has finished closes straight away", async () => {
  const { deps, calls, asked } = setup({ terminals: [orchestrator("finished")] });
  await closeFocusedTab(deps);
  assert.deepEqual(calls, [["tab.close", { id: "t-run" }]]);
  assert.deepEqual(asked, []);
});

test("a worker or reviewer in the tab is not a run to guard", async () => {
  const { deps, asked } = setup({ terminals: [orchestrator("live", { "herdr.role": "worker" })] });
  await closeFocusedTab(deps);
  assert.deepEqual(asked, []);
});

test("a failed close says why in an error notification", async () => {
  const { deps, notes } = setup({ tab: "t-plain", failRun: true });
  await closeFocusedTab(deps);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, "error");
  assert.match(notes[0].body, /no such tab/);
  const confirmed = setup({ failRun: true });
  await closeConfirmed({ tab: "t-run" }, confirmed.deps);
  assert.equal(confirmed.notes[0].level, "error");
});

test("with no tab focused it says so instead of doing nothing", async () => {
  const { deps, calls, notes } = setup({ tab: null });
  await closeFocusedTab(deps);
  assert.deepEqual(calls, []);
  assert.equal(notes[0].level, "error");
});

test("the warning names the task and what closing stops", async () => {
  assert.match(closeMessage("#19 View reopens"), /^#19 View reopens is still running\. Closing its tab stops the orchestrator and all its workers and reviewers\.$/);
});
