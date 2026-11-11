// The "New task" dialog: the pure side of it. The + in the Tasks header opens it as a small overlay the mod draws itself (a dimmed
// backdrop and a compact panel in the middle, like the ticket editor's popup, popup.js): "Describe the ticket you want", a multi-line
// box, Cancel and Continue. new-task.js draws it and starts the task; this file says what it does.
import { MARGIN } from "./lib/index.js";

export const WIDTH = 520;
export const TITLE = "New task";
export const AGENT_KEY = "github-tasks.groomAgent"; // the agent saved before the settings page held it
export const PROMPT = "Describe the ticket you want";
export const ENTER_HINT = "Enter to continue · Shift+Enter for a new line"; // the muted line on the button row

// The panel's width for a window of `size`: 520px, or what the window has left after the margin on each side. Null until measured.
export function panelWidth(size) {
  if (!size || !(size.width > 0)) return null;
  return Math.max(0, Math.min(WIDTH, Math.round(size.width) - 2 * MARGIN));
}

// The overlay that shows the dialog. props: what the sidebar knew when + was pressed (see newTaskProps).
export const newTaskOverlay = (props) => ({
  mod: "github-tasks", kind: "window", key: "github-tasks.new-task", width: 1, height: 1, frame: "none",
  props: { ...props, role: "new-task" },
});

// What the dialog starts the task from: the place the sidebar is looking at, as the overlay can't ask the sidebar. GitHub mode has a
// repo and a project, local mode the repo's main checkout.
export const newTaskProps = ({ repo, project, local, mainRoot, where }) => ({
  repo: repo ?? null, project: project ? { id: project.id, title: project.title, url: project.url } : null,
  local: local ? { mainRoot } : null, where: { cwd: where?.cwd, on: where?.on },
});

// The agent New Task uses: the saved one if it is installed, else Claude, else the first installed. Null when none is.
export function chooseAgent(installed, saved) {
  const list = installed ?? [];
  return list.find((a) => a.key === saved) ?? list.find((a) => a.key === "claude") ?? list[0] ?? null;
}

// What Esc does: the dialog closes, unless a task is being started, which can't be called back halfway (an overlay's tasks end
// with it): then nothing.
export const escStep = ({ starting }) => (starting ? "ignore" : "close");

// What a plain or Shift Enter in the text box does. "submit": start the task, as Continue does (it is on). "newline": Shift+Enter,
// which the text box turns into a line break itself. "ignore": Enter while Continue is off (nothing typed, or a start going); the
// box must not turn that into a line break either, so the page swallows the key. (gpui gives key events no composing state, so there
// is no such input: the IME is expected to take the Enter that confirms a composition before it reaches the page.)
export function enterStep({ starting, text, shift }) {
  if (shift) return "newline";
  return !starting && String(text ?? "").trim() !== "" ? "submit" : "ignore";
}

// The text box is 132px tall with a 1px border and 8px padding each side: 114px inside. Rows of text (a line is about 1.5 times the
// text size, as the ticket editor reckons) that fit in that, so the last line and the caret are never cut off; more text scrolls.
export const BOX_HEIGHT = 132, BOX_INSET = 2 + 16;
export const boxRows = (bodySize) => Math.max(1, Math.floor((BOX_HEIGHT - BOX_INSET) / (bodySize * 1.5)));

// The dialog's state and what its buttons do. onChange: called after every change, for the view to redraw.
export class NewTaskDialog {
  constructor(onChange = () => {}) {
    this.text = "";
    this.starting = false;
    this.error = null;
    this.closed = false;
    this.onChange = onChange;
  }

  setText(text) {
    this.text = String(text ?? "");
    this.onChange();
  }

  // Continue is on only with something typed (not just blanks) and while nothing is being started.
  canContinue() { return !this.starting && this.text.trim() !== ""; }

  // Cancel, Esc and a press on the backdrop: closes without starting anything. True when it closed.
  requestClose() {
    if (escStep(this) === "ignore") return false;
    this.closed = true;
    this.onChange();
    return true;
  }

  // Continue: `start(description)` (the text, trimmed) starts the task (it throws with the message for the person). On success the dialog closes; on a
  // failure it stays open with the error showing and the typed text kept. Resolves with "started", "failed" or "ignored".
  async submit(start) {
    if (!this.canContinue()) return "ignored";
    this.starting = true;
    this.error = null;
    this.onChange();
    try {
      await start(this.text.trim());
    } catch (e) {
      this.starting = false;
      this.error = String(e?.message ?? e) || "The task didn't start.";
      this.onChange();
      return "failed";
    }
    this.starting = false;
    this.closed = true;
    this.onChange();
    return "started";
  }
}
