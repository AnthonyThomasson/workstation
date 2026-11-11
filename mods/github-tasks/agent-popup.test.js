import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_POPUP_KEY, BAR_HEIGHT, WORDS, agentPopupOverlay, popupSize, isEscape, barTitle, parentLabel } from "./agent-popup.js";
import { MIN_WIDTH, MIN_HEIGHT, MARGIN } from "./popup.js";

test("the popup is one window with a fixed key, so a second click replaces the open one", () => {
  const a = agentPopupOverlay("t7"), b = agentPopupOverlay("t9");
  assert.equal(a.kind, "window");
  assert.equal(a.key, AGENT_POPUP_KEY);
  assert.equal(b.key, a.key);
});

test("it never asks Herdr to bring the window back on the next start", () => {
  assert.equal("keep" in agentPopupOverlay("t7"), false);
});

test("its layout is our bar (28px, role agent-bar, the terminal as prop) over the live terminal", () => {
  const { layout } = agentPopupOverlay("t7");
  assert.deepEqual(layout, {
    type: "column",
    children: [
      { type: "block", size: { px: BAR_HEIGHT }, content: { mod: "github-tasks", props: { role: "agent-bar", terminal: "t7" } } },
      { type: "block", content: { terminal: "t7" } },
    ],
  });
  assert.equal(BAR_HEIGHT, 28);
});

test("it is centered: no `at`", () => {
  assert.equal("at" in agentPopupOverlay("t7"), false);
});

test("with no window size known it takes 80% of the window", () => {
  assert.deepEqual(popupSize(null), { width: 0.8, height: 0.8 });
  assert.deepEqual(popupSize({ width: 0, height: 0 }), { width: 0.8, height: 0.8 });
});

test("with the window measured it is 80% in px, never under 720x520, and never past the margin", () => {
  assert.deepEqual(popupSize({ width: 2000, height: 1200 }), { width: 1600, height: 960 });
  assert.deepEqual(popupSize({ width: 800, height: 600 }), { width: MIN_WIDTH, height: MIN_HEIGHT });
  assert.deepEqual(popupSize({ width: 700, height: 500 }), { width: 700 - 2 * MARGIN, height: 500 - 2 * MARGIN });
});

test("the overlay carries the size", () => {
  assert.deepEqual([agentPopupOverlay("t7").width, agentPopupOverlay("t7").height], [0.8, 0.8]);
  const o = agentPopupOverlay("t7", { width: 2000, height: 1200 });
  assert.deepEqual([o.width, o.height], [1600, 960]);
});

test("Esc is recognised by either of the key event's spellings", () => {
  assert.equal(isEscape({ keystroke: "escape" }), true);
  assert.equal(isEscape({ key: "escape" }), true);
  assert.equal(isEscape({ keystroke: "enter", key: "enter" }), false);
  assert.equal(isEscape({ keystroke: "cmd-escape" }), false);
  assert.equal(isEscape(null), false);
});

test("the bar names the agent by name, template, program, then address", () => {
  assert.equal(barTitle({ name: "Worker 1", template: "w", program: { name: "claude" } }, "t7"), "Worker 1");
  assert.equal(barTitle({ name: "", template: "w", program: { name: "claude" } }, "t7"), "w");
  assert.equal(barTitle({ program: { name: "claude" } }, "t7"), "claude");
  assert.equal(barTitle(undefined, "t7"), "t7");
  assert.equal(barTitle(undefined, undefined), "");
});

test("the bar says who the agent is from, by name else address, and nothing without a parent", () => {
  assert.equal(parentLabel({ name: "Orch", address: "t1" }), "from Orch");
  assert.equal(parentLabel({ address: "t1" }), "from t1");
  assert.equal(parentLabel(null), null);
});

test("status words match Herdr's peek bar", () => {
  assert.deepEqual(WORDS, { working: "working", blocked: "needs you", done: "finished", idle: "idle" });
});
