import test from "node:test";
import assert from "node:assert/strict";
import { panelAppeared, PRESS_BUTTONS, panelSize, closeStep, escStep, afterSave, editorOverlay, MIN_WIDTH, MIN_HEIGHT, MARGIN } from "./popup.js";

test("the panel is 80% of the window", () => {
  assert.deepEqual(panelSize({ width: 2000, height: 1200 }), { width: 1600, height: 960 });
});

test("a smaller window still gets the minimum size, as long as it fits with the margin", () => {
  assert.deepEqual(panelSize({ width: 1000, height: 700 }), { width: 800, height: 560 }); // 80%, above the minimum
  assert.deepEqual(panelSize({ width: 800, height: 600 }), { width: MIN_WIDTH, height: MIN_HEIGHT }); // 80% is 640x480; 800-32 and 600-32 leave room for the minimum
  assert.equal(MIN_WIDTH, 720);
  assert.equal(MIN_HEIGHT, 520);
});

test("the panel is never bigger than the window less the margin on each side", () => {
  assert.deepEqual(panelSize({ width: 700, height: 500 }), { width: 700 - 2 * MARGIN, height: 500 - 2 * MARGIN });
  assert.deepEqual(panelSize({ width: 2000, height: 540 }), { width: 1600, height: 540 - 2 * MARGIN });
  assert.equal(MARGIN, 16);
});

test("a window too small for any margin gets a panel of no size, not a negative one", () => {
  assert.deepEqual(panelSize({ width: 10, height: 20 }), { width: 0, height: 0 });
});

test("before the window is measured the panel has no size to give", () => {
  assert.equal(panelSize(null), null);
  assert.equal(panelSize({ width: 0, height: 0 }), null);
});

test("sizes are whole pixels", () => {
  const s = panelSize({ width: 1333, height: 777 });
  assert.ok(Number.isInteger(s.width) && Number.isInteger(s.height));
});

test("a close request with nothing unsaved closes", () => {
  assert.equal(closeStep({ dirty: false, saving: false, starting: false }), "close");
});

test("a close request with unsaved edits asks first", () => {
  assert.equal(closeStep({ dirty: true, saving: false, starting: false }), "prompt");
});

test("a close request during a save waits for it, whether or not there is more unsaved", () => {
  assert.equal(closeStep({ dirty: true, saving: true, starting: false }), "wait");
  assert.equal(closeStep({ dirty: false, saving: true, starting: false }), "wait");
});

test("a close request while a run is starting is ignored: it can't be called back halfway", () => {
  assert.equal(closeStep({ dirty: false, saving: false, starting: true }), "ignore");
  assert.equal(closeStep({ dirty: true, saving: false, starting: true }), "ignore");
});

test("a close request while Won't Do runs is ignored: like a run being started, it can't be called back halfway, and a success closes the popup itself", () => {
  assert.equal(closeStep({ dirty: false, saving: false, starting: false, wontDoing: true }), "ignore");
  assert.equal(closeStep({ dirty: true, saving: false, starting: false, wontDoing: true }), "ignore");
  assert.equal(closeStep({ dirty: false, saving: false, starting: false, wontDoing: false }), "close");
});

test("Esc goes to the card first, then the Start dialog, then a picker, then the Won't Do question, and only then asks to close", () => {
  const all = { prompt: true, start: true, picker: true, confirm: true, popup: true };
  assert.equal(escStep(all), "keep-editing");
  assert.equal(escStep({ ...all, prompt: false }), "close-start");
  assert.equal(escStep({ ...all, prompt: false, start: false }), "close-picker");
  assert.equal(escStep({ ...all, prompt: false, start: false, picker: false }), "cancel-confirm");
  assert.equal(escStep({ prompt: false, start: false, picker: false, confirm: false, popup: true }), "request-close");
  assert.equal(escStep({ prompt: false, start: false, picker: false, popup: true }), "request-close"); // confirm left out
});

test("in an old editor tab Esc only ever closes a picker or the Start dialog", () => {
  assert.equal(escStep({ prompt: false, start: false, picker: false, popup: false }), "none");
  assert.equal(escStep({ prompt: false, start: true, picker: false, popup: false }), "close-start");
  assert.equal(escStep({ prompt: false, start: false, picker: true, popup: false }), "close-picker");
});

test("in an old editor tab Esc also closes the Won't Do question", () => {
  assert.equal(escStep({ prompt: false, start: false, picker: false, confirm: true, popup: false }), "cancel-confirm");
});

test("after a save nothing happens unless a close was waiting for it", () => {
  assert.equal(afterSave({ pending: null, dirty: false }), "none");
  assert.equal(afterSave({ pending: null, dirty: true }), "none");
});

test("Save on the card closes once the save worked", () => {
  assert.equal(afterSave({ pending: "card", dirty: false }), "close");
});

test("Save on the card that failed leaves the popup open with the card gone, so the error shows", () => {
  assert.equal(afterSave({ pending: "card", dirty: true }), "stay");
});

test("a close request made during a save closes if the save left nothing unsaved, else asks", () => {
  assert.equal(afterSave({ pending: "close", dirty: false }), "close");
  assert.equal(afterSave({ pending: "close", dirty: true }), "prompt");
});

test("the editor opens as a full-window overlay the mod draws itself, with the ticket's props", () => {
  const props = { role: "editor", ticket: { number: 3 }, repo: "a/b", project: null, where: { cwd: "/x" } };
  assert.deepEqual(editorOverlay(props), {
    mod: "github-tasks", kind: "window", key: "github-tasks.editor", width: 1, height: 1, frame: "none",
    props: { ...props, popup: true },
  });
});

test("the panel first shows when the window is first measured, and not again on a resize", () => {
  assert.equal(panelAppeared(null, { width: 1200, height: 800 }), true);
  assert.equal(panelAppeared({ width: 1200, height: 800 }, { width: 1000, height: 700 }), false);
  assert.equal(panelAppeared(null, { width: 0, height: 0 }), false);
});

test("a press of any button on the popup is stopped, so the window can't be dragged", () => {
  assert.deepEqual(PRESS_BUTTONS, ["left", "right", "middle"]);
});
