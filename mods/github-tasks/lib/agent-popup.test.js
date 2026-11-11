import test from "node:test";
import assert from "node:assert/strict";
import { BAR_HEIGHT, PANEL_RADIUS, WORDS, agentPopupOverlay, isEscape, barTitle, parentLabel } from "./agent-popup.js";
import { AGENT_POPUP_KEY } from "./keys.js";

test("the popup is one window with a fixed key, so a second click replaces the open one", () => {
  const a = agentPopupOverlay("t7"), b = agentPopupOverlay("t9");
  assert.equal(a.kind, "window");
  assert.equal(a.key, AGENT_POPUP_KEY);
  assert.equal(b.key, a.key);
});

test("it never asks Herdr to bring the window back on the next start", () => {
  assert.equal("keep" in agentPopupOverlay("t7"), false);
});

const panelOf = (o) => o.layout.children[1].children[1];

test("it is the whole window, with no frame of Herdr's (the backdrop and panel are ours)", () => {
  const o = agentPopupOverlay("t7");
  assert.deepEqual([o.width, o.height, o.frame], [1, 1, "none"]);
});

test("the panel is our bar (28px, role agent-bar, the terminal as prop) over the live terminal", () => {
  assert.deepEqual(panelOf(agentPopupOverlay("t7")).children, [
    { type: "block", size: { px: BAR_HEIGHT }, content: { mod: "github-tasks", props: { role: "agent-bar", terminal: "t7" } } },
    { type: "block", content: { terminal: "t7" } },
  ]);
  assert.equal(BAR_HEIGHT, 28);
});

test("backdrop blocks (role agent-backdrop) surround the panel on all four sides", () => {
  const { layout } = agentPopupOverlay("t7");
  const isBackdrop = (n) => n.type === "block" && n.content.mod === "github-tasks" && n.content.props.role === "agent-backdrop";
  assert.equal(layout.type, "column");
  assert.equal(isBackdrop(layout.children[0]), true);
  assert.equal(isBackdrop(layout.children[2]), true);
  const row = layout.children[1];
  assert.equal(row.type, "row");
  assert.equal(isBackdrop(row.children[0]), true);
  assert.equal(isBackdrop(row.children[2]), true);
  assert.equal(row.children[1].type, "column");
});

test("the weights give the panel 80% of the window each way", () => {
  const { layout } = agentPopupOverlay("t7");
  const share = (nodes, i) => nodes[i].size.weight / nodes.reduce((n, c) => n + c.size.weight, 0);
  assert.equal(share(layout.children, 1), 0.8);
  assert.equal(share(layout.children[1].children, 1), 0.8);
  assert.equal(share(layout.children, 0), 0.1);
  assert.equal(share(layout.children[1].children, 2), 0.1);
});

test("the panel draws its own border, rounding and shadow, as it has no frame of Herdr's", () => {
  const p = panelOf(agentPopupOverlay("t7"));
  assert.deepEqual(p.border, { width: 1, color: "border" });
  assert.equal(p.radius, PANEL_RADIUS);
  assert.equal(p.shadow, "lg");
});

test("it is centered: no `at`", () => {
  assert.equal("at" in agentPopupOverlay("t7"), false);
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
