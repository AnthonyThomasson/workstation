import test from "node:test";
import assert from "node:assert/strict";
import { NewTaskDialog, PROMPT, TITLE, WIDTH, chooseAgent, enterStep, escStep, newTaskOverlay, newTaskProps, panelWidth, boxRows } from "./new-task-dialog.js";
import { MARGIN } from "./popup.js";

test("the dialog says what the mock-up says", () => {
  assert.equal(TITLE, "New task");
  assert.equal(PROMPT, "Describe the ticket you want");
});

test("the panel is 520px wide, or the window less a margin each side; nothing until the window is measured", () => {
  assert.equal(panelWidth(null), null);
  assert.equal(panelWidth({ width: 0, height: 0 }), null);
  assert.equal(panelWidth({ width: 1400, height: 900 }), WIDTH);
  assert.equal(WIDTH, 520);
  assert.equal(panelWidth({ width: 400, height: 900 }), 400 - 2 * MARGIN);
});

test("the overlay is a frameless window of the mod with the new-task role and what the sidebar knew", () => {
  const props = newTaskProps({ repo: "o/app", project: { id: "P1", title: "Board", url: "u", extra: 1 }, local: false, mainRoot: "/r", where: { cwd: "/r/x", on: undefined } });
  assert.deepEqual(props, { repo: "o/app", project: { id: "P1", title: "Board", url: "u" }, local: null, where: { cwd: "/r/x", on: undefined } });
  const o = newTaskOverlay(props);
  assert.equal(o.mod, "github-tasks");
  assert.equal(o.kind, "window");
  assert.equal(o.frame, "none");
  assert.equal(o.key, "github-tasks.new-task");
  assert.equal(o.props.role, "new-task");
  assert.equal(o.props.repo, "o/app");
  assert.deepEqual(newTaskProps({ repo: null, project: null, local: true, mainRoot: "/r", where: { cwd: "/r" } }).local, { mainRoot: "/r" });
});

test("the agent is the saved one if installed, else Claude, else the first, else none", () => {
  const installed = [{ key: "codex" }, { key: "claude" }, { key: "pi" }];
  assert.equal(chooseAgent(installed, "pi").key, "pi");
  assert.equal(chooseAgent(installed, "gone").key, "claude");
  assert.equal(chooseAgent([{ key: "codex" }], undefined).key, "codex");
  assert.equal(chooseAgent([], "claude"), null);
  assert.equal(chooseAgent(undefined, "claude"), null);
});

test("Continue is off while the text is empty or only whitespace, on once there is any, and off while starting", () => {
  const d = new NewTaskDialog();
  assert.equal(d.canContinue(), false);
  d.setText("   \n\t ");
  assert.equal(d.canContinue(), false);
  d.setText("  fix the login redirect ");
  assert.equal(d.canContinue(), true);
  d.starting = true;
  assert.equal(d.canContinue(), false);
});

test("Cancel, Esc and the backdrop close without starting anything", async () => {
  const d = new NewTaskDialog();
  d.setText("something");
  assert.equal(d.requestClose(), true);
  assert.equal(d.closed, true);
  assert.equal(escStep({ starting: false }), "close");
});

test("Esc and a click beside it don't close the dialog while the task is being started", () => {
  const d = new NewTaskDialog();
  d.starting = true;
  assert.equal(escStep(d), "ignore");
  assert.equal(d.requestClose(), false);
  assert.equal(d.closed, false);
});

test("Continue starts the task with the typed text, trimmed, and closes the dialog on success", async () => {
  const d = new NewTaskDialog();
  d.setText("  Fix the login redirect\nIt lands on /404 \n");
  const seen = [];
  const outcome = await d.submit(async (description) => { seen.push([description, d.starting]); });
  assert.equal(outcome, "started");
  assert.deepEqual(seen, [["Fix the login redirect\nIt lands on /404", true]], "disabled while starting");
  assert.equal(d.closed, true);
  assert.equal(d.error, null);
});

test("Continue does nothing with an empty box or while one start is going", async () => {
  const d = new NewTaskDialog();
  let calls = 0;
  assert.equal(await d.submit(async () => { calls++; }), "ignored");
  d.setText("x");
  let release;
  const first = d.submit(() => new Promise((r) => { release = r; }));
  assert.equal(d.starting, true);
  assert.equal(await d.submit(async () => { calls++; }), "ignored", "a second press while starting");
  release();
  assert.equal(await first, "started");
  assert.equal(calls, 0);
});

test("a failed start keeps the dialog open with the error showing and the typed text kept, and Continue works again", async () => {
  for (const thrown of [new Error("This space is on dev. Tasks' agents only start on this computer for now."), new Error("This space has no folder to work in."), new Error("Pick an agent that is installed on this computer."), "plain string"]) {
    const d = new NewTaskDialog();
    d.setText("describe it");
    assert.equal(await d.submit(async () => { throw thrown; }), "failed");
    assert.equal(d.closed, false);
    assert.equal(d.starting, false);
    assert.equal(d.error, String(thrown?.message ?? thrown));
    assert.equal(d.text, "describe it", "the typed text is kept");
    assert.equal(d.canContinue(), true);
  }
});

test("pressing Continue again clears the old error, and a second try can succeed", async () => {
  const d = new NewTaskDialog();
  d.setText("describe it");
  await d.submit(async () => { throw new Error("no folder"); });
  assert.equal(d.error, "no folder");
  let during = "unset";
  assert.equal(await d.submit(async () => { during = d.error; }), "started");
  assert.equal(during, null, "cleared as the second start begins");
  assert.equal(d.closed, true);
});

test("every change tells the view to redraw", async () => {
  let n = 0;
  const d = new NewTaskDialog(() => n++);
  d.setText("a");
  assert.equal(n, 1);
  await d.submit(async () => {});
  assert.ok(n >= 3, "starting and done");
});

test("Enter starts the task when Continue would be on, and does nothing (without a new line) when it would be off", () => {
  assert.equal(enterStep({ starting: false, text: "fix the redirect", shift: false }), "submit");
  assert.equal(enterStep({ starting: false, text: "  fix it \n", shift: false }), "submit");
  assert.equal(enterStep({ starting: true, text: "fix the redirect", shift: false }), "ignore", "a start is going");
  assert.equal(enterStep({ starting: false, text: "", shift: false }), "ignore", "an empty box");
  assert.equal(enterStep({ starting: false, text: " \n\t ", shift: false }), "ignore", "only whitespace");
  assert.equal(enterStep({ starting: false, text: undefined, shift: false }), "ignore");
});

test("Shift+Enter is a new line in every state, and never starts anything", () => {
  for (const starting of [false, true]) for (const text of ["", "  ", "some text"]) assert.equal(enterStep({ starting, text, shift: true }), "newline");
});

test("Enter agrees with Continue: it submits exactly when canContinue is on", () => {
  const d = new NewTaskDialog();
  for (const [text, starting] of [["", false], ["x", false], ["  ", false], ["x", true], ["a\nb", false]]) {
    d.text = text; d.starting = starting;
    assert.equal(enterStep({ starting: d.starting, text: d.text, shift: false }) === "submit", d.canContinue());
  }
});

test("pressing Enter several times quickly starts only one task", async () => {
  const d = new NewTaskDialog();
  d.setText("one task please");
  let starts = 0, release;
  const press = () => (enterStep(d) === "submit"
    ? d.submit(() => { starts++; return new Promise((r) => { release = r; }); }) : Promise.resolve("ignored"));
  const results = [press(), press(), press()];
  assert.equal(starts, 1);
  release();
  assert.deepEqual(await Promise.all(results), ["started", "ignored", "ignored"]);
  assert.equal(starts, 1);
});

test("a multi-line description reaches the start with its line breaks", async () => {
  const d = new NewTaskDialog();
  d.setText("Fix the login redirect\n\n- lands on /404\n- only on Safari\n");
  let got;
  await d.submit(async (description) => { got = description; });
  assert.equal(got, "Fix the login redirect\n\n- lands on /404\n- only on Safari");
});

test("the text box shows only as many rows as fit in its 114px, at any text size", () => {
  assert.equal(boxRows(13.5), 5, "5 x 20.25px = 101px; a 6th row would be cut off");
  assert.equal(boxRows(12.5), 6);
  assert.equal(boxRows(16.5), 4);
  for (const size of [10, 12, 13.5, 15, 18, 24, 60]) assert.ok(boxRows(size) === 1 || boxRows(size) * size * 1.5 <= 114, `size ${size}`);
});
