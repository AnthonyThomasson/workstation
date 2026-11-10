// The New task dialog, in the overlay the + in the Tasks header opens (props.role "new-task"; new-task-dialog.js has the state and
// says what the buttons do). Not a View of its own: main.js builds one in init and draws it from render. Continue starts the task
// (startTask) as the sidebar did before there was a dialog: GitHub mode or local mode, from the place the sidebar was looking at.
import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { shared, theme, closeOverlay } from "herdr";
import { GROOMER_KEY, INVESTIGATOR_KEY, WORKER_KEY, STATUSES, normalizeGroomer, normalizeSubAgent, spelled } from "./model.js";
import { loadStatusField } from "./loader.js";
import { installedAgents, startNewTask, startLocalNewTask } from "./groom.js";
import { AGENT_KEY, ENTER_HINT, NewTaskDialog, PROMPT, TITLE, chooseAgent, boxRows, enterStep, panelWidth } from "./new-task-dialog.js";
import { PRESS_BUTTONS } from "./popup.js";
import { S, stop, action, gh } from "./ui.js";

const stopPresses = (el, except) => PRESS_BUTTONS.filter((b) => b !== except).reduce((e, b) => e.on_mouse_down(b, stop), el);

// Starts the New Task session for `description` from what the sidebar passed (newTaskProps). Throws with a message for the person:
// no agent installed, a space on another machine, no folder, anything startInvestigation refuses. refactor: { type, focus } from the
// Refactor dialog (refactor.js), which starts the same session with an empty description; null for the New task dialog.
export async function startTask(props, description, cx, refactor = null) {
  const agent = chooseAgent(await installedAgents(), normalizeGroomer(shared(GROOMER_KEY)).agent ?? shared(AGENT_KEY));
  if (!agent) throw new Error("Pick an agent that is installed on this computer.");
  const where = { cwd: props.where?.cwd, on: props.where?.on };
  const groomer = normalizeGroomer(shared(GROOMER_KEY));
  const subAgents = { investigator: normalizeSubAgent(shared(INVESTIGATOR_KEY)), worker: normalizeSubAgent(shared(WORKER_KEY)) }; // saved apart from the New Task Orchestrator's
  if (props.local) return startLocalNewTask({ agent, description, mainRoot: props.local.mainRoot, groomer, subAgents, where, refactor }, cx);
  if (!props.project) throw new Error("This repo has no project to put the ticket on.");
  // The prompt names the statuses as the project spells them ("Todo", not the fixed "To Do").
  const options = (await loadStatusField(gh, props.project.id, where).catch(() => null))?.options ?? [];
  return startNewTask({ agent, description, repo: props.repo, project: props.project, settings: { backlog: spelled(options, STATUSES.backlog), groomed: spelled(options, STATUSES.groomed) }, groomer, subAgents, where, refactor }, cx);
}

export class NewTaskPage {
  constructor(props, cx) {
    this.props = props ?? {};
    this.handle = cx.focus_handle(); // the root takes Esc when the text box doesn't
    this.input = TextareaState.new({ value: "", rows: boxRows(S().body) });
    this.dialog = new NewTaskDialog(() => {});
    this.input.on("change", (_e, cx) => { this.dialog.setText(this.input.value()); cx.notify(); });
    this.window = null;
    cx.timer.after(50, () => this.input.focus?.()); // a window doesn't take the keyboard when it opens
  }

  close() {
    if (this.dialog.requestClose() && this.props.overlay) closeOverlay(this.props.overlay);
  }

  continue(cx) {
    if (!this.dialog.canContinue()) return;
    cx.spawn(async (cx) => {
      const result = this.dialog.submit((description) => startTask(this.props, description, cx));
      cx.notify(); // submit has set "starting" by now
      const outcome = await result;
      if (outcome === "started" && this.props.overlay) closeOverlay(this.props.overlay);
      cx.notify();
    });
  }

  // Enter in the text box. The panel sees the key before the text box turns it into a line break (the chat mod's composer does the
  // same), so a plain Enter is swallowed here: it starts the task when Continue is on and does nothing otherwise. Shift+Enter goes on
  // to the text box, which makes the line break. Cmd/Ctrl/Alt+Enter are left to the text box as they were.
  onKey(e, cx) {
    if (e.key === "escape") { this.close(); cx.stop_propagation(); return; }
    const m = e.modifiers ?? {};
    if (e.key !== "enter" || m.control || m.alt || m.platform) return;
    const step = enterStep({ starting: this.dialog.starting, text: this.dialog.text, shift: Boolean(m.shift) });
    if (step === "newline") return;
    cx.stop_propagation();
    if (step === "submit") this.continue(cx);
  }

  render(cx) {
    const t = theme(), width = panelWidth(this.window), d = this.dialog;
    // The backdrop covers the window; a press on it closes, and the panel stops presses so they don't (which also keeps the window from being dragged).
    const backdrop = div().id("new-task-popup").size_full().flex().items_center().justify_center().bg("#000000a6")
      .on_size_change((win, cx) => {
        const first = !this.window;
        this.window = win;
        this.input.set_rows(boxRows(S().body)); // the text size may have changed since the dialog opened
        if (first) cx.timer.after(50, () => this.input.focus?.());
        cx.notify();
      })
      .on_mouse_down("left", (_e, cx) => { this.close(); cx.stop_propagation(); });
    const panel = v_flex().id("new-task").track_focus(this.handle).w(width ?? 0).flex_none().p(16).gap(12).rounded(12).border_1().border_color(t.border)
      .bg(t.background).text_color(t.foreground).text_size(S().body).shadow_lg()
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(div().text_size(S().title).font_semibold().child(TITLE))
      .child(div().text_size(S().secondary).text_color(t.muted).child(PROMPT))
      .child(div().id("new-task-text").h(132).flex_none().min_h(0).overflow_hidden().rounded(8).border_1().border_color(t.border).bg(t.chrome).p(8)
        .child(Textarea.new(this.input).size_full().text_size(S().body).text_color(t.foreground)))
      .when(Boolean(d.error), (el) => el.child(div().id("new-task-error").flex_none().text_size(S().secondary).text_color(t.blocked).child(`! ${d.error}`)))
      .child(h_flex().gap(8).items_center()
        .child(div().id("new-task-hint").flex_1().min_w(0).truncate().text_size(S().label).text_color(t.muted).child(ENTER_HINT))
        .child(action("new-task-cancel", "Cancel", t, () => this.close(), true, d.starting))
        .child(action("new-task-continue", d.starting ? "Starting…" : "Continue", t, (_e, cx) => this.continue(cx), false, !d.canContinue())));
    return stopPresses(backdrop, "left").when(Boolean(width), (el) => el.child(stopPresses(panel)));
  }
}
