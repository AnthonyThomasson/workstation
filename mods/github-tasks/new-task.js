// The New task dialog, in the overlay the + on the Backlog header opens (props.role "new-task"; new-task-dialog.js has the state and
// says what the buttons do). Not a View of its own: main.js builds one in init and draws it from render. Continue starts the task
// (startTask) as the sidebar did before there was a dialog: GitHub mode or local mode, from the place the sidebar was looking at.
import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { shared, theme, closeOverlay } from "herdr";
import { GROOMER_KEY, STATUSES, normalizeGroomer, spelled } from "./model.js";
import { loadStatusField } from "./loader.js";
import { installedAgents, startNewTask, startLocalNewTask } from "./groom.js";
import { AGENT_KEY, NewTaskDialog, PROMPT, TITLE, chooseAgent, panelWidth } from "./new-task-dialog.js";
import { PRESS_BUTTONS } from "./popup.js";
import { S, stop, action, gh } from "./ui.js";

const stopPresses = (el, except) => PRESS_BUTTONS.filter((b) => b !== except).reduce((e, b) => e.on_mouse_down(b, stop), el);

// Starts the New Task session for `description` from what the sidebar passed (newTaskProps). Throws with a message for the person:
// no agent installed, a space on another machine, no folder, anything startInvestigation refuses.
export async function startTask(props, description, cx) {
  const agent = chooseAgent(await installedAgents(), normalizeGroomer(shared(GROOMER_KEY)).agent ?? shared(AGENT_KEY));
  if (!agent) throw new Error("Pick an agent that is installed on this computer.");
  const where = { cwd: props.where?.cwd, on: props.where?.on };
  const groomer = normalizeGroomer(shared(GROOMER_KEY));
  if (props.local) return startLocalNewTask({ agent, description, mainRoot: props.local.mainRoot, groomer, where }, cx);
  if (!props.project) throw new Error("This repo has no project to put the ticket on.");
  // The prompt names the statuses as the project spells them ("Todo", not the fixed "To Do").
  const options = (await loadStatusField(gh, props.project.id, where).catch(() => null))?.options ?? [];
  return startNewTask({ agent, description, repo: props.repo, project: props.project, settings: { backlog: spelled(options, STATUSES.backlog), groomed: spelled(options, STATUSES.groomed) }, groomer, where }, cx);
}

export class NewTaskPage {
  constructor(props, cx) {
    this.props = props ?? {};
    this.handle = cx.focus_handle(); // the root takes Esc when the text box doesn't
    this.input = TextareaState.new({ value: "", rows: 6 });
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

  render(cx) {
    const t = theme(), width = panelWidth(this.window), d = this.dialog;
    // The backdrop covers the window; a press on it closes, and the panel stops presses so they don't (which also keeps the window from being dragged).
    const backdrop = div().id("new-task-popup").size_full().flex().items_center().justify_center().bg("#000000a6")
      .on_size_change((win, cx) => {
        const first = !this.window;
        this.window = win;
        if (first) cx.timer.after(50, () => this.input.focus?.());
        cx.notify();
      })
      .on_mouse_down("left", (_e, cx) => { this.close(); cx.stop_propagation(); });
    const panel = v_flex().id("new-task").track_focus(this.handle).w(width ?? 0).flex_none().p(16).gap(12).rounded(12).border_1().border_color(t.border)
      .bg(t.background).text_color(t.foreground).text_size(S().body).shadow_lg()
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .child(div().text_size(S().title).font_semibold().child(TITLE))
      .child(div().text_size(S().secondary).text_color(t.muted).child(PROMPT))
      .child(div().id("new-task-text").h(132).flex_none().rounded(8).border_1().border_color(t.border).bg(t.chrome).p(8)
        .child(Textarea.new(this.input).size_full().text_size(S().body).text_color(t.foreground)))
      .when(Boolean(d.error), (el) => el.child(div().id("new-task-error").flex_none().text_size(S().secondary).text_color(t.blocked).child(`! ${d.error}`)))
      .child(h_flex().gap(8).justify_end()
        .child(action("new-task-cancel", "Cancel", t, () => this.close(), true, d.starting))
        .child(action("new-task-continue", d.starting ? "Starting…" : "Continue", t, (_e, cx) => this.continue(cx), false, !d.canContinue())));
    return stopPresses(backdrop, "left").when(Boolean(width), (el) => el.child(stopPresses(panel)));
  }
}
