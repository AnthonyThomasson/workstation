// The popup a click on a live agent row opens (the run page's and the investigation page's), in place of Herdr's own
// terminal.peek: a full-window overlay with a dimmed backdrop of ours, and in the middle a panel of a bar of ours over the
// agent's live terminal. Herdr's peek bar has "keep" and "go to" and never handles Esc, so Esc reached the agent; ours has
// neither button and closes on Esc (agent-bar.js). A window never closes on a click beside it and drags on any press the mod
// doesn't stop, so the backdrop is ours too: a press on it closes the popup and reaches nothing (agent-backdrop.js).
// The pure side: the overlay spec and the bar's texts.
import { AGENT_POPUP_KEY } from "./keys.js";

export const BAR_HEIGHT = 28;
// The panel is 80% of the window each way: the layout splits it into weights 1 : 8 : 1 (a backdrop either side of the panel).
export const EDGE_WEIGHT = 1;
export const PANEL_WEIGHT = 8;
export const PANEL_RADIUS = 8;
export const WORDS = { working: "working", blocked: "needs you", done: "finished", idle: "idle" };

const backdropBlock = (weight) => ({ type: "block", size: { weight }, content: { mod: "github-tasks", props: { role: "agent-backdrop" } } });

// The overlay for `terminal` (an address): the whole window (width and height 1, no frame of Herdr's), one fixed key (a second
// click replaces the open one), no `keep` (it must not come back on the next start) and no `at`. Backdrop blocks around the
// panel: column [backdrop, row [backdrop, panel, backdrop], backdrop]. The panel draws its own border and corners. `resizable: false` on every row and column: the seams can't be dragged.
export function agentPopupOverlay(terminal) {
  const panel = {
    type: "column", size: { weight: PANEL_WEIGHT }, resizable: false,
    border: { width: 1, color: "border" }, radius: PANEL_RADIUS,
    children: [
      { type: "block", size: { px: BAR_HEIGHT }, content: { mod: "github-tasks", props: { role: "agent-bar", terminal } } },
      { type: "block", content: { terminal } },
    ],
  };
  return {
    kind: "window", key: AGENT_POPUP_KEY, width: 1, height: 1, frame: "none",
    layout: {
      type: "column", resizable: false,
      children: [
        backdropBlock(EDGE_WEIGHT),
        { type: "row", size: { weight: PANEL_WEIGHT }, resizable: false, children: [backdropBlock(EDGE_WEIGHT), panel, backdropBlock(EDGE_WEIGHT)] },
        backdropBlock(EDGE_WEIGHT),
      ],
    },
  };
}

// Whether a key event is a bare Esc (the bar closes on it and stops it, so it never reaches the agent).
export const isEscape = (e) => e?.keystroke === "escape" || e?.key === "escape";

// The bar's texts, as Herdr's own peek bar words them.
export const barTitle = (term, address) => term?.name || term?.template || term?.program?.name || address || "";
export const parentLabel = (parent) => (parent ? `from ${parent.name || parent.address}` : null);
