// The ticket editor as a popup: the pure side of it. It opens as a full-window overlay the mod draws itself (a dimmed
// backdrop, a panel in the middle), because a Herdr "dialog" closes on Esc and on a click beside it before the editor can
// ask about unsaved edits, and a "window" leaves every close to the mod.
import { EDITOR_OVERLAY_KEY } from "./keys.js";

export const SHARE = 0.8;
export const MIN_WIDTH = 720;
export const MIN_HEIGHT = 520;
export const MARGIN = 16; // what the panel leaves clear on each side of the window

// The panel's size in px for a window of `size`: 80% of it, at least 720x520, and never past the window less the
// margin on each side (that wins on a small window, and the editor's content scrolls). Null until the window is measured.
export function panelSize(size) {
  if (!size || !(size.width > 0) || !(size.height > 0)) return null;
  const fit = (room, min, share) => Math.max(0, Math.min(Math.max(min, Math.round(room * share)), Math.round(room) - 2 * MARGIN));
  return { width: fit(size.width, MIN_WIDTH, SHARE), height: fit(size.height, MIN_HEIGHT, SHARE) };
}

// What a request to close (Esc, the ✕, a press on the backdrop) does. "wait": a save is running, and is never cut off, so
// the close follows it. "ignore": a run is being started or Won't Do is running, which can't be called back halfway (a
// success of either closes the popup itself, and a failure must stay on screen).
export function closeStep({ dirty, saving, starting, wontDoing = false }) {
  if (starting || wontDoing) return "ignore";
  if (saving) return "wait";
  return dirty ? "prompt" : "close";
}

// What Esc does, innermost first: the unsaved-changes card, the Start dialog, a picker, the Won't Do question in the
// footer (confirm: it is up and its call is not running), and only then a close request. In an editor tab (not a popup)
// it never closes the editor.
export function escStep({ prompt, start, picker, confirm = false, popup }) {
  if (prompt) return "keep-editing";
  if (start) return "close-start";
  if (picker) return "close-picker";
  if (confirm) return "cancel-confirm";
  return popup ? "request-close" : "none";
}

// What follows a save that has just ended. pending says what was waiting for it: "card" (Save on the unsaved-changes
// card) or "close" (a close request made while it ran). dirty is whether anything is still unsaved, which a failed save,
// a conflict or an edit made meanwhile leaves behind.
export function afterSave({ pending, dirty }) {
  if (!pending) return "none";
  if (!dirty) return "close";
  return pending === "card" ? "stay" : "prompt";
}

// The overlay that shows an editor. props are the editor's, as the tab got them.
export const editorOverlay = (props) => ({
  mod: "github-tasks", kind: "window", key: EDITOR_OVERLAY_KEY, width: 1, height: 1, frame: "none",
  props: { ...props, popup: true },
});

// Whether the panel has just come on screen: it renders once the window has a size, and only then is the editor's root there
// to take the keyboard.
export const panelAppeared = (before, after) => !panelSize(before) && Boolean(panelSize(after));

// The buttons whose presses the popup stops: a window drags on any press its mod doesn't stop, and remembers where it was dropped.
export const PRESS_BUTTONS = ["left", "right", "middle"];
