// The popup a click on a live agent row opens (the run page's and the investigation page's), in place of Herdr's own
// terminal.peek: a window overlay of a bar of ours over the agent's live terminal. Herdr's peek bar has "keep" and
// "go to" and never handles Esc, so Esc reached the agent; ours has neither button and closes on Esc (agent-bar.js).
// The pure side: the overlay spec, its size and the bar's texts.
import { panelSize } from "./popup.js";
import { AGENT_POPUP_KEY } from "./keys.js";

export const BAR_HEIGHT = 28;
export const SHARE = 0.8;
export const WORDS = { working: "working", blocked: "needs you", done: "finished", idle: "idle" };

// The window's size: px from panelSize (80%, at least 720x520, never past the margin) when the window's size is known, else
// 80% as a share, as Herdr's overlay takes it. Mods aren't told the window's size outside an overlay, so the pages pass none.
export function popupSize(window) {
  const px = panelSize(window);
  return px ?? { width: SHARE, height: SHARE };
}

// The overlay for `terminal` (an address). No `keep` (it must not come back on the next start) and no `at` (centered).
export function agentPopupOverlay(terminal, window = null) {
  const { width, height } = popupSize(window);
  return {
    kind: "window", key: AGENT_POPUP_KEY, width, height,
    layout: {
      type: "column",
      children: [
        { type: "block", size: { px: BAR_HEIGHT }, content: { mod: "github-tasks", props: { role: "agent-bar", terminal } } },
        { type: "block", content: { terminal } },
      ],
    },
  };
}

// Whether a key event is a bare Esc (the bar closes on it and stops it, so it never reaches the agent).
export const isEscape = (e) => e?.keystroke === "escape" || e?.key === "escape";

// The bar's texts, as Herdr's own peek bar words them.
export const barTitle = (term, address) => term?.name || term?.template || term?.program?.name || address || "";
export const parentLabel = (parent) => (parent ? `from ${parent.name || parent.address}` : null);
