// The Refactor dialog: the pure side of it. The broom in the Tasks header opens it as a small overlay the mod draws itself, drawn like
// the New task dialog (new-task-dialog.js): "Pick a refactor type to investigate", a radio list of the place's refactor types, an
// optional focus, Cancel and Start. refactor.js draws it and starts the session; this file says what it does.
import { normalize, validate } from "./refactor-model.js";
import { panelWidth, newTaskProps } from "./new-task-dialog.js";

export { panelWidth };
export const TITLE = "Refactor";
export const SUBTITLE = "Pick a refactor type to investigate";
export const FOCUS_LABEL = "Focus (optional)";
export const FOCUS_PLACEHOLDER = "e.g. only mods/github-tasks";
export const ENTER_HINT = "Enter to start"; // the muted line on the button row
export const EMPTY_TEXT = "No refactor types yet. Add one under Refactors in Task settings.";
export const TOOLTIP = "Start a refactor investigation";
export const PICK_PREFIX = "github-tasks.refactorPick."; // + the repo's key: the type last started there, as scope:id

// The overlay that shows the dialog. props: what the sidebar knew when the broom was pressed (the New task dialog's, newTaskProps).
export const refactorOverlay = (props) => ({
  mod: "github-tasks", kind: "window", key: "github-tasks.refactor", width: 1, height: 1, frame: "none",
  props: { ...props, role: "refactor" },
});
export const refactorProps = newTaskProps;

// Where the last pick for a repo is saved in shared state, and what is saved there.
export const pickKey = (repoKey) => `${PICK_PREFIX}${repoKey ?? ""}`;
export const typeKey = (type) => `${type.scope}:${type.id}`;
export const pickValue = typeKey;

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key);

// The rows of the radio list, from the refactor types the place can see (store.loadAll: each with its scope). Types that can't run (a
// file the model finds invalid: no prompt, no agent) are left out. Sorted by name ignoring case. badge: Global, or the repo's name.
// type: the normalized refactor type with its scope, what the session is started with.
export function typeRows(items, repoName) {
  return (items ?? [])
    .map((item) => ({ ...item, name: item.name || item.id })) // a file with no name is listed by its id, as the Refactors list does
    .filter((item) => validate(item).length === 0)
    .map((item) => {
      const type = { ...normalize(item), id: item.id, scope: item.scope };
      return { key: typeKey(type), name: type.name, badge: item.scope === "global" ? "Global" : (repoName || "Repo"), type };
    })
    .sort(byName);
}

// The row chosen when the list first shows: the one remembered for this repo while it is still there, else the first.
export function initialPick(rows, remembered) {
  if (!rows.length) return null;
  return rows.some((r) => r.key === remembered) ? remembered : rows[0].key;
}

// What a plain or Shift Enter in the focus box does (as enterStep in new-task-dialog.js): "submit" when Start is on, "newline" for
// Shift+Enter (the box makes the break itself), "ignore" when Start is off or a start is going (the page swallows the key).
export function enterStep({ starting, canStart, shift }) {
  if (shift) return "newline";
  return !starting && canStart ? "submit" : "ignore";
}

// The dialog's state and what its buttons do. onChange: called after every change, for the view to redraw.
export class RefactorDialog {
  constructor(onChange = () => {}) {
    this.rows = [];
    this.loaded = false; // the types are known (or reading them failed)
    this.selected = null; // a row's key
    this.focus = "";
    this.starting = false;
    this.error = null;
    this.closed = false;
    this.onChange = onChange;
  }

  // The types are read: `rows` (typeRows), `remembered` the saved pick for the repo.
  ready(rows, remembered) {
    this.rows = rows;
    this.selected = initialPick(rows, remembered);
    this.loaded = true;
    this.error = null;
    this.onChange();
  }

  // Reading the types failed: the reason shows, and there is nothing to start.
  failed(message) {
    this.rows = [];
    this.selected = null;
    this.loaded = true;
    this.error = String(message || "The refactor types couldn't be read.");
    this.onChange();
  }

  empty() { return this.loaded && !this.rows.length; }

  choose(key) {
    if (this.starting || !this.rows.some((r) => r.key === key)) return;
    this.selected = key;
    this.onChange();
  }

  setFocus(text) {
    this.focus = String(text ?? "");
    this.onChange();
  }

  // Start is on with a type chosen, while nothing is being started.
  canStart() { return !this.starting && this.selected != null; }

  chosen() { return this.rows.find((r) => r.key === this.selected) ?? null; }

  // Cancel, Esc and a press on the backdrop: closes without starting anything, unless a start is going (it can't be called back
  // halfway; an overlay's tasks end with it). True when it closed.
  requestClose() {
    if (this.starting) return false;
    this.closed = true;
    this.onChange();
    return true;
  }

  // Start: `start({ type, focus })` starts the session (it throws with the message for the person). On success the dialog closes; on a
  // failure it stays open with the error showing, the pick and the focus kept. Resolves with "started", "failed" or "ignored".
  async submit(start) {
    const row = this.chosen();
    if (!this.canStart() || !row) return "ignored";
    this.starting = true;
    this.error = null;
    this.onChange();
    try {
      await start({ type: row.type, focus: this.focus.trim() });
    } catch (e) {
      this.starting = false;
      this.error = String(e?.message ?? e) || "The refactor didn't start.";
      this.onChange();
      return "failed";
    }
    this.starting = false;
    this.closed = true;
    this.onChange();
    return "started";
  }
}

// The focus box is 72px tall with a 1px border and 8px padding each side (54px inside): the rows of text that fit, a line being about
// 1.5 times the text size as in new-task-dialog.js, so no last line or caret is cut off; more text scrolls.
export const FOCUS_HEIGHT = 72, FOCUS_INSET = 2 + 16;
export const focusRows = (bodySize) => Math.max(1, Math.floor((FOCUS_HEIGHT - FOCUS_INSET) / (bodySize * 1.5)));
