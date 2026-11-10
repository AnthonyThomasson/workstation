import test from "node:test";
import assert from "node:assert/strict";
import { StartDialog, WIDTH, cantStartHere, escStep, labelsLine, layout, rowDetail, scopeBadge, startOverlay, startProps } from "./start-dialog.js";

const wf = (id, labels = [], match = "any", scope = "global") => ({ id, name: id.toUpperCase(), scope, trigger: { labels, match } });
const bug = wf("bug", ["bug"]), story = wf("story", ["story", "feature"], "all", "repo");

test("the dialog is 560px wide", () => {
  assert.equal(WIDTH, 560);
});

test("the overlay is a frameless window of the mod with the start role, its own key and what the sidebar knew", () => {
  const ticket = { key: "t1", number: 5, labels: ["bug"] };
  const props = startProps({ ticket, repo: "o/app", project: { id: "P1", title: "Board", url: "u", extra: 1 }, local: false, mainRoot: "/r", where: { cwd: "/r/x", on: undefined }, matches: [bug, story], skipped: ["a.yaml: bad"] });
  assert.deepEqual(props, { ticket, repo: "o/app", project: { id: "P1", title: "Board" }, local: null, where: { cwd: "/r/x", on: undefined }, matches: [bug, story], skipped: ["a.yaml: bad"] });
  const o = startOverlay(props);
  assert.equal(o.mod, "github-tasks");
  assert.equal(o.kind, "window");
  assert.equal(o.frame, "none");
  assert.equal(o.key, "github-tasks.start");
  assert.equal(o.props.role, "start");
  assert.equal(o.props.repo, "o/app");
  assert.deepEqual(startProps({ ticket, repo: "o/app", project: null, local: true, mainRoot: "/r", where: { cwd: "/r" } }).local, { mainRoot: "/r" });
  assert.deepEqual(startProps({ ticket, local: true, mainRoot: "/r", where: {} }).matches, []);
});

test("the overlay's props survive being serialised", () => {
  const props = startProps({ ticket: { key: "k", labels: ["bug"] }, repo: "o/a", project: { id: "P", title: "B" }, local: false, where: { cwd: "/x" }, matches: [bug, story], skipped: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(startOverlay(props).props)), JSON.parse(JSON.stringify({ ...props, role: "start" })));
});

test("Esc closes the dialog, unless a start is running, which can't be called back halfway", () => {
  assert.equal(escStep({ starting: false }), "close");
  assert.equal(escStep({ starting: true }), "ignore");
});

test("Esc, ✕ and the backdrop close without starting anything, and are ignored while a start runs", async () => {
  const d = new StartDialog();
  d.ready(["bug"], [bug, story], []);
  assert.equal(d.requestClose(), true);
  assert.equal(d.closed, true);

  const e = new StartDialog();
  e.ready(["bug"], [bug, story], []);
  let release;
  const started = e.choose(bug, () => new Promise((r) => { release = r; }));
  assert.equal(e.starting, true);
  assert.equal(e.requestClose(), false);
  assert.equal(e.closed, false);
  release();
  assert.equal(await started, "started");
});

test("a dialog that has begun loading shows the loading body until it is ready", () => {
  const d = new StartDialog();
  d.begin(["bug"]);
  assert.equal(d.phase, "loading");
  assert.equal(layout(d).body, "loading");
  d.ready(["bug"], [bug, story], ["x.yaml: bad"]);
  assert.equal(d.phase, "ready");
  assert.deepEqual(d.skipped, ["x.yaml: bad"]);
  assert.equal(layout(d).body, "list");
});

test("several matches are listed under Choose a workflow", () => {
  const d = new StartDialog();
  d.ready(["bug", "story"], [bug, story], []);
  assert.deepEqual(layout(d), { title: "Choose a workflow", body: "list", error: null, empty: null });
  assert.equal(labelsLine(d), "Matched on labels: bug, story");
});

test("no match explains itself, by whether the ticket has labels", () => {
  const some = new StartDialog();
  some.ready(["bug"], [], []);
  assert.deepEqual(layout(some), { title: "Start", body: "empty", error: null, empty: ["No workflow matches this ticket's labels.", "Make one in the Task settings."] });
  const none = new StartDialog();
  none.ready([], [], []);
  assert.deepEqual(layout(none).empty, ["This ticket has no labels, and no workflow is the fallback.", "Make one in the Task settings."]);
  assert.equal(labelsLine(none), "Matched on labels: none");
});

test("unreadable workflow files stay named under the list", () => {
  const d = new StartDialog();
  d.ready(["bug"], [], ["a.yaml: bad", "b.yaml: worse"]);
  assert.equal(d.skippedLine(), "Skipped unreadable workflows: a.yaml: bad; b.yaml: worse");
  d.ready(["bug"], [], []);
  assert.equal(d.skippedLine(), null);
});

test("a row shows its trigger labels or the fallback, and a Global or Repo badge", () => {
  assert.equal(rowDetail(bug), "Any of: bug");
  assert.equal(rowDetail(story), "All of: story, feature");
  assert.equal(rowDetail(wf("fallback")), "Fallback: no labels");
  assert.equal(scopeBadge(bug), "Global");
  assert.equal(scopeBadge(story), "Repo");
});

test("choosing a workflow shows the starting message with its name, and closes the dialog on success", async () => {
  const d = new StartDialog();
  d.ready(["bug"], [bug, story], []);
  const seen = [];
  const outcome = await d.choose(story, async (w) => { seen.push([w.id, d.phase, d.chosen.id, layout(d)]); });
  assert.equal(outcome, "started");
  assert.deepEqual(seen, [["story", "starting", "story", { title: "STORY", body: "starting", error: null, empty: null }]]);
  assert.equal(d.closed, true);
  assert.equal(d.starting, false);
});

test("a failed start keeps the dialog open with the reason, and the list so another workflow can be picked", async () => {
  const d = new StartDialog();
  d.ready(["bug"], [bug, story], []);
  assert.equal(await d.choose(bug, async () => { throw new Error("This space has no folder to work in."); }), "failed");
  assert.equal(d.closed, false);
  assert.equal(d.starting, false);
  assert.equal(d.error, "This space has no folder to work in.");
  assert.deepEqual(layout(d), { title: "BUG", body: "list", error: "This space has no folder to work in.", empty: null });
  assert.equal(await d.choose(story, async () => { assert.equal(d.error, null, "cleared as the second try begins"); }), "started");
  assert.equal(d.closed, true);
});

test("a failure with a plain string, or none, still says something", async () => {
  const a = new StartDialog(); a.ready([], [bug, story], []);
  await a.choose(bug, async () => { throw "plain"; });
  assert.equal(a.error, "plain");
  const b = new StartDialog(); b.ready([], [bug, story], []);
  await b.choose(bug, async () => { throw new Error(""); });
  assert.equal(b.error, "The workflow didn't start.");
});

test("a start can't be chosen while one is running or before the list is ready", async () => {
  const d = new StartDialog();
  assert.equal(await d.choose(bug, async () => {}), "ignored", "still loading");
  d.ready([], [bug, story], []);
  let release;
  const first = d.choose(bug, () => new Promise((r) => { release = r; }));
  assert.equal(await d.choose(story, async () => assert.fail("a second start")), "ignored");
  release();
  assert.equal(await first, "started");
});

test("failing to load the workflows shows the reason and no list", () => {
  const d = new StartDialog();
  d.begin(["bug"]);
  d.loadFailed("gh broke");
  assert.deepEqual(layout(d), { title: "Start", body: "error", error: "gh broke", empty: null });
});

test("every change tells the view to redraw", async () => {
  let n = 0;
  const d = new StartDialog(() => n++);
  d.begin([]);
  d.ready([], [bug, story], []);
  const before = n;
  await d.choose(bug, async () => {});
  assert.ok(n - before >= 2, "starting and done");
  d.requestClose();
  assert.ok(n - before >= 3);
});

test("a space on another machine, or with no folder, can't start a workflow, and says why", () => {
  assert.equal(cantStartHere({ cwd: "/r", on: undefined }), null);
  assert.equal(cantStartHere({ cwd: "/r", on: "dev" }), "This space is on dev. Workflows only run on this computer for now.");
  assert.equal(cantStartHere({ cwd: undefined }), "This space has no folder to work in.");
  assert.equal(cantStartHere(undefined), "This space has no folder to work in.");
});
