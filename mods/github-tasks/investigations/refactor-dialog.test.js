import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_TEXT, FOCUS_HEIGHT, FOCUS_LABEL, FOCUS_PLACEHOLDER, PICK_PREFIX, RefactorDialog, SUBTITLE, TITLE, TOOLTIP, enterStep, focusRows, initialPick, pickKey, pickValue, refactorOverlay, typeKey, typeRows } from "./refactor-dialog.js";
import { blankRefactor as blank } from "../workflow/index.js";

const make = (id, name, scope = "global", over = {}) => {
  const b = blank();
  return { ...b, id, name, scope, orchestrator: { ...b.orchestrator, agent: "claude", prompt: "Look." }, investigator: { ...b.investigator, agent: "claude" }, ...over };
};

test("the dialog says what the mock-up says", () => {
  assert.equal(TITLE, "Refactor");
  assert.equal(SUBTITLE, "Pick a refactor type to investigate");
  assert.equal(FOCUS_LABEL, "Focus (optional)");
  assert.equal(FOCUS_PLACEHOLDER, "e.g. only mods/github-tasks");
  assert.equal(EMPTY_TEXT, "No refactor types yet. Add one under Refactors in Task settings.");
  assert.equal(TOOLTIP, "Start a refactor investigation");
});

test("the overlay is a window over the workspace with the refactor role", () => {
  const o = refactorOverlay({ repo: "a/b" });
  assert.equal(o.mod, "github-tasks");
  assert.equal(o.kind, "window");
  assert.equal(o.key, "github-tasks.refactor");
  assert.deepEqual(o.props, { repo: "a/b", role: "refactor" });
});

test("rows are sorted by name ignoring case, each with a Global or repo-name badge, and invalid types are left out", () => {
  const rows = typeRows([make("z", "zeta"), make("b", "Beta", "repo"), make("a", "alpha"), make("bad", "No prompt", "global", { orchestrator: { ...blank().orchestrator, prompt: "" } })], "workstation");
  assert.deepEqual(rows.map((r) => [r.key, r.name, r.badge]), [["global:a", "alpha", "Global"], ["repo:b", "Beta", "workstation"], ["global:z", "zeta", "Global"]]);
  assert.equal(rows[1].type.scope, "repo");
  assert.equal(rows[1].type.id, "b");
});

test("a type without a name shows its id, and the same id in two scopes keeps both rows", () => {
  const rows = typeRows([make("dead", "", "global"), make("dead", "Dead", "repo")], "r");
  assert.deepEqual(rows.map((r) => [r.key, r.name]), [["global:dead", "dead"], ["repo:dead", "Dead"]]);
});

test("the first type is preselected, or the remembered one when it is still there", () => {
  const rows = typeRows([make("a", "A"), make("b", "B", "repo")], "r");
  assert.equal(initialPick(rows, null), "global:a");
  assert.equal(initialPick(rows, "repo:b"), "repo:b");
  assert.equal(initialPick(rows, "global:gone"), "global:a");
  assert.equal(initialPick([], "repo:b"), null);
});

test("the pick is remembered per repo, by scope and id", () => {
  assert.equal(PICK_PREFIX, "github-tasks.refactorPick.");
  assert.equal(pickKey("/Users/me/repo"), "github-tasks.refactorPick./Users/me/repo");
  assert.equal(pickKey(null), "github-tasks.refactorPick.");
  assert.equal(pickValue({ scope: "repo", id: "x" }), "repo:x");
  assert.equal(typeKey({ scope: "global", id: "a" }), "global:a");
});

test("Enter starts when Start is on; Shift+Enter is a line break; Enter with Start off is swallowed", () => {
  assert.equal(enterStep({ starting: false, canStart: true, shift: false }), "submit");
  assert.equal(enterStep({ starting: false, canStart: true, shift: true }), "newline");
  assert.equal(enterStep({ starting: false, canStart: false, shift: false }), "ignore");
  assert.equal(enterStep({ starting: true, canStart: true, shift: false }), "ignore");
});

const ready = (d, items = [make("a", "A"), make("b", "B", "repo")], remembered = null) => { d.ready(typeRows(items, "r"), remembered); return d; };

test("loading: Start is off and the list is not yet known", () => {
  const d = new RefactorDialog();
  assert.equal(d.loaded, false);
  assert.equal(d.canStart(), false);
  assert.equal(d.empty(), false);
});

test("no refactor types: the list is empty and Start is off", () => {
  const d = ready(new RefactorDialog(), []);
  assert.equal(d.empty(), true);
  assert.equal(d.canStart(), false);
  assert.equal(d.selected, null);
});

test("choosing a type selects it; Start is on once a type is selected, whatever the focus box holds", () => {
  const d = ready(new RefactorDialog());
  assert.equal(d.selected, "global:a");
  assert.equal(d.canStart(), true);
  d.choose("repo:b");
  assert.equal(d.selected, "repo:b");
  d.choose("nope");
  assert.equal(d.selected, "repo:b");
});

test("Start hands the chosen type (with its scope) and the trimmed focus to start, and the dialog closes", async () => {
  const d = ready(new RefactorDialog());
  d.choose("repo:b");
  d.setFocus("  only mods/x \n");
  let got = null;
  assert.equal(await d.submit(async (r) => { got = r; }), "started");
  assert.equal(got.type.id, "b");
  assert.equal(got.type.scope, "repo");
  assert.equal(got.focus, "only mods/x");
  assert.equal(d.closed, true);
});

test("a blank focus is the empty string", async () => {
  const d = ready(new RefactorDialog());
  d.setFocus("   ");
  let got = null;
  await d.submit(async (r) => { got = r; });
  assert.equal(got.focus, "");
});

test("a failed start stays open with the error and keeps the input; the next start can go", async () => {
  const d = ready(new RefactorDialog());
  d.choose("repo:b");
  d.setFocus("x");
  assert.equal(await d.submit(async () => { throw new Error("no folder"); }), "failed");
  assert.equal(d.error, "no folder");
  assert.equal(d.closed, false);
  assert.equal(d.starting, false);
  assert.equal(d.selected, "repo:b");
  assert.equal(d.focus, "x");
  assert.equal(await d.submit(async () => {}), "started");
  assert.equal(d.error, null);
});

test("several Enters start once", async () => {
  const d = ready(new RefactorDialog());
  let calls = 0, release;
  const hold = new Promise((r) => { release = r; });
  const first = d.submit(async () => { calls++; await hold; });
  assert.equal(await d.submit(async () => { calls++; }), "ignored");
  release();
  await first;
  assert.equal(calls, 1);
});

test("Esc, Cancel and the backdrop close the dialog unless a start is going", async () => {
  const d = ready(new RefactorDialog());
  assert.equal(d.requestClose(), true);
  assert.equal(d.closed, true);
  const e = ready(new RefactorDialog());
  let release;
  const p = e.submit(() => new Promise((r) => { release = r; }));
  assert.equal(e.requestClose(), false);
  assert.equal(e.closed, false);
  release();
  await p;
});

test("a failure to read the types is shown and Start stays off", () => {
  const d = new RefactorDialog();
  d.failed("Permission denied");
  assert.equal(d.loaded, true);
  assert.equal(d.error, "Permission denied");
  assert.equal(d.canStart(), false);
  assert.equal(d.empty(), false); // only the error shows, not the "No refactor types yet" text
});

test("the focus box shows as many rows as fit inside its 54px, at least one", () => {
  assert.equal(FOCUS_HEIGHT, 72);
  assert.equal(focusRows(13), 2);
  assert.equal(focusRows(30), 1);
});
