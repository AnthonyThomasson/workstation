// The ticket window's Won't Do button, as pure decisions: which footer buttons are on, the confirm question, what
// Escape closes, and which tab is the window's own. editor.js and local-editor.js draw from these.
import { wontDoDisabledReason } from "./model.js";

// What the footer shows. confirm: the inline strip replaces the button row. Each button is { disabled }, and wontDo
// also has the tooltip (the reason it is off). busy: the Won't Do call is running, so every button is inert and the
// strip stays up whatever else changes; otherwise the strip goes away if the button stops being available (an edit).
export function wontDoFooter({ draft = false, saving = false, dirty = false, local = false, statusOptions, startable = false, confirming = false, busy = false } = {}) {
  const reason = wontDoDisabledReason({ draft, saving, dirty, local, statusOptions });
  const off = (disabled) => ({ disabled: Boolean(disabled) });
  return {
    confirm: confirming && (busy || !reason),
    dropConfirm: confirming && !busy && Boolean(reason), // an edit made the button unavailable: the question is withdrawn, not just hidden
    wontDo: { disabled: busy || Boolean(reason), tip: busy ? null : reason },
    start: off(busy || saving || dirty || !startable),
    revert: off(busy || saving || !dirty),
    save: off(busy || saving || !dirty),
    cancel: off(busy),
    ok: off(busy),
  };
}

// The question the confirm strip asks.
export const wontDoPrompt = ({ number, local = false }) =>
  (local ? `Move #${number} to Won't Do?` : `Close #${number} as not planned and set it to Won't Do?`);

// What Escape closes: a dialog over the window first, then the confirm strip. Not a call that is running.
export function escapeAction({ start = false, picker = false, confirming = false, busy = false } = {}) {
  if (start) return "start";
  if (picker) return "picker";
  return confirming && !busy ? "confirm" : null;
}

// The tab the opener recorded for this window ({ pane, tab }), when that pane is still open; else null. Closing by this id
// never closes whichever tab the person has moved to meanwhile.
export const recordedTab = (at, modPanes) => (at && (modPanes ?? []).some((p) => p.pane === at.pane && p.tab === at.tab) ? at.tab : null);

// The subject a window's tab was recorded under: its own slot when it was opened without one for the ticket (Start's
// dialog windows), else the ticket's.
export const windowSubject = (props, ticketSubject) => props?.windowSlot ?? ticketSubject;

// What the sign-in's "done" re-runs: the Won't Do that failed, else a save. Won't Do is not re-run when the button has
// become unavailable meanwhile (edits typed during sign-in): a success closes the window and would drop them. Then "none".
export const retryAfterSignIn = (retry, { wontDoDisabled = false } = {}) => (retry !== "wontdo" ? "save" : wontDoDisabled ? "none" : "wontdo");
