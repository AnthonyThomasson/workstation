// The Start dialog, drawn (start-dialog.js has its state and texts). renderStartDialog is the 560px panel; the ticket editor puts it on
// a scrim of its own over the editor, and StartPage, the view of the overlay a row's Start opens (props.role "start"), puts it on a
// dimmed backdrop over the whole window. Not a View of its own: main.js builds a StartPage in init and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, theme } from "herdr";
import { loadStatusField } from "./loader.js";
import { startRun } from "./start.js";
import { S, icon, stop, note, iconButton, gh } from "./ui.js";
import { PRESS_BUTTONS } from "./popup.js";
import { StartDialog, STARTING, WIDTH, labelsLine, layout, rowDetail, scopeBadge } from "./start-dialog.js";

const stopPresses = (el, except) => PRESS_BUTTONS.filter((b) => b !== except).reduce((e, b) => e.on_mouse_down(b, stop), el);

// Starts `workflow` on `ticket`: moves the ticket's status when the project has the field, then runs it (start.js). Throws with the
// reason for the person. repo, project ({ id } or null) and where are the editor's, or the overlay's props.
export async function startChosen(workflow, ticket, { repo, project, where }, cx) {
  const statusField = project ? await loadStatusField(gh, project.id, where).catch(() => null) : null; // without it the ticket's status just isn't moved
  return startRun(workflow, ticket, repo, where, cx, { project, statusField });
}

// The dialog: the workflow starting, why it couldn't, or the matching workflows to choose from (or why there are none).
// onChoose(workflow, cx) starts one; onClose(cx) is a request to close (the ✕), which the caller passes on to the dialog.
export function renderStartDialog(t, d, { onChoose, onClose }) {
  const l = layout(d), skipped = d.skippedLine();
  const row = (w) => h_flex().id(`start-${w.scope}-${w.id}`).flex_none().px(10).py(8).gap(8).items_center().rounded(6).cursor_pointer()
    .hover((st) => st.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => onChoose(w, cx))
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(div().truncate().text_size(S().body).font_medium().child(w.name))
      .child(div().truncate().text_size(S().label).text_color(t.muted).child(rowDetail(w))))
    .child(div().flex_none().px(6).h(18).flex().items_center().rounded(9).border_1().border_color(t.border).text_size(S().label).text_color(t.muted).child(scopeBadge(w)))
    .child(icon("chevron-right", 14, t.muted));
  const body = l.body === "loading" ? v_flex().gap(8).children([0, 1].map((i) => div().h(40).flex_none().rounded(8).bg(t.chrome).opacity(1 - i * 0.3)))
    : l.body === "error" ? note(t, l.error, t.ansi1)
    : l.body === "starting" ? h_flex().gap(8).items_center().child(icon("ring", 14, t.muted).spin(900)).child(note(t, STARTING))
    : l.body === "list" ? v_flex().gap(8)
      .when(Boolean(l.error), (el) => el.child(note(t, l.error, t.ansi1)))
      .child(div().id("start-list").max_h(380).overflow_y_scrollbar().child(v_flex().gap(2).children(d.matches.map(row))))
    : v_flex().gap(6).children(l.empty.map((line) => note(t, line)));
  return v_flex().id("task-start").w(WIDTH).max_h(560).flex_none().p(16).gap(12).rounded(12).border_1().border_color(t.border)
    .bg(t.popover).shadow_lg().text_color(t.foreground).text_size(S().body)
    .on_mouse_down("left", stop)
    .child(h_flex().flex_none().items_center().gap(8)
      .child(div().flex_1().min_w(0).truncate().text_size(S().title).font_semibold().child(l.title))
      .child(div().text_size(S().label).text_color(t.muted).child("Esc"))
      .child(iconButton("start-close", "close", t, (_e, cx) => onClose(cx))))
    .child(div().flex_none().truncate().text_size(S().label).text_color(t.muted).child(labelsLine(d)))
    .child(body)
    .when(Boolean(skipped), (el) => el.child(note(t, skipped, t.ansi1)));
}

// The overlay a row's Start opens when several workflows match, or none (props from startProps): the dialog over a dimmed backdrop.
// Choosing a workflow starts it on the ticket; on success the overlay closes and the run's tab shows.
export class StartPage {
  constructor(props, cx) {
    this.props = props ?? {};
    this.handle = cx.focus_handle(); // the dialog takes Esc
    this.dialog = new StartDialog(() => {}, { retry: true });
    this.dialog.ready(this.props.ticket?.labels ?? [], this.props.matches ?? [], this.props.skipped ?? []);
    cx.timer.after(50, () => this.handle.focus()); // a window doesn't take the keyboard when it opens
  }

  close() {
    if (this.dialog.requestClose() && this.props.overlay) closeOverlay(this.props.overlay);
  }

  choose(workflow, cx) {
    const { ticket, repo, project, where } = this.props;
    cx.spawn(async (cx) => {
      const result = this.dialog.choose(workflow, (w) => startChosen(w, ticket, { repo: repo ?? "", project, where }, cx));
      cx.notify(); // choose has set "starting" by now
      const outcome = await result;
      if (outcome === "started" && this.props.overlay) closeOverlay(this.props.overlay);
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    // The backdrop covers the window; a press on it closes, and the dialog stops presses so they don't (which also keeps the window from being dragged).
    const backdrop = div().id("start-popup").size_full().flex().items_center().justify_center().bg("#000000a6")
      .on_mouse_down("left", (_e, cx) => { this.close(); cx.stop_propagation(); });
    const panel = renderStartDialog(t, this.dialog, { onChoose: (w, cx) => this.choose(w, cx), onClose: () => this.close() })
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } });
    return stopPresses(backdrop, "left").child(stopPresses(panel));
  }
}
