// The Refactor dialog, in the overlay the broom in the Tasks header opens (props.role "refactor"; refactor-dialog.js has the state and
// says what the buttons do). Not a View of its own: main.js builds one in init and draws it from render. Start runs the same path the
// New task dialog does (startTask, new-task.js) with no description and `refactor: { type, focus }`.
import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { shared, setShared, theme, closeOverlay } from "herdr";
import { REFACTOR } from "./kinds.js";
import { store, repoRootOf } from "./workflow-env.js";
import { startTask, stopPresses } from "./new-task.js";
import { S, stop, action, note } from "./ui.js";
import { EMPTY_TEXT, ENTER_HINT, FOCUS_HEIGHT, FOCUS_LABEL, FOCUS_PLACEHOLDER, RefactorDialog, SUBTITLE, TITLE, enterStep, focusRows, panelWidth, pickKey, pickValue, typeRows } from "./refactor-dialog.js";

const baseName = (path) => String(path ?? "").split("/").filter(Boolean).pop() ?? "";

// The repo the pick is remembered for: the main checkout in local mode, the GitHub repo otherwise.
const repoKeyOf = (props) => (props.local ? props.local.mainRoot : props.repo) ?? "";

// The refactor types the place can see, as the Refactors list in Task settings loads them: the repo's own (a repo on this computer) and
// the global ones. Resolves with the rows (refactor-dialog.js typeRows).
export async function loadTypes(where) {
  const repoRoot = await repoRootOf(where);
  const { items } = await store({ repo: repoRoot, kind: REFACTOR }).loadAll();
  return typeRows(items, baseName(repoRoot));
}

export class RefactorPage {
  constructor(props, cx) {
    this.props = props ?? {};
    this.handle = cx.focus_handle(); // the root takes Esc when the text box doesn't
    this.input = TextareaState.new({ value: "", rows: focusRows(S().body), placeholder: FOCUS_PLACEHOLDER });
    this.dialog = new RefactorDialog(() => {});
    this.input.on("change", (_e, cx) => { this.dialog.setFocus(this.input.value()); cx.notify(); });
    this.window = null;
    cx.timer.after(50, () => this.input.focus?.()); // a window doesn't take the keyboard when it opens
    cx.spawn(async (cx) => {
      try {
        this.dialog.ready(await loadTypes({ cwd: this.props.where?.cwd, on: this.props.where?.on }), shared(pickKey(repoKeyOf(this.props))) ?? null);
      } catch (e) {
        this.dialog.failed(String(e?.message ?? e));
      }
      cx.notify();
    });
  }

  close() {
    if (this.dialog.requestClose() && this.props.overlay) closeOverlay(this.props.overlay);
  }

  start(cx) {
    const d = this.dialog, row = d.chosen();
    if (!d.canStart() || !row) return;
    cx.spawn(async (cx) => {
      const result = d.submit((refactor) => startTask(this.props, "", cx, refactor));
      cx.notify(); // submit has set "starting" by now
      setShared(pickKey(repoKeyOf(this.props)), pickValue(row.type)); // the next dialog for this repo opens on it
      const outcome = await result;
      if (outcome === "started" && this.props.overlay) closeOverlay(this.props.overlay);
      cx.notify();
    });
  }

  // Esc anywhere in the panel; Enter in the focus box starts when Start is on (the panel sees the key before the box turns it into a
  // line break, as in the New task dialog), Shift+Enter goes on to the box as a line break. Cmd/Ctrl/Alt+Enter are left to the box.
  onKey(e, cx) {
    if (e.key === "escape") { this.close(); cx.stop_propagation(); return; }
    const m = e.modifiers ?? {};
    if (e.key !== "enter" || m.control || m.alt || m.platform) return;
    const step = enterStep({ starting: this.dialog.starting, canStart: this.dialog.canStart(), shift: Boolean(m.shift) });
    if (step === "newline") return;
    cx.stop_propagation();
    if (step === "submit") this.start(cx);
  }

  // One radio row: the dot, the type's name, and its Global or repo-name badge.
  row(t, r) {
    const on = r.key === this.dialog.selected;
    return h_flex().id(`refactor-type-${r.key}`).flex_none().px(10).py(7).gap(8).items_center().rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(t.chrome)).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop).on_click((_e, cx) => { this.dialog.choose(r.key); this.input.focus?.(); cx.notify(); })
      .child(div().size(14).flex_none().flex().items_center().justify_center().rounded_full().border_1().border_color(on ? t.foreground : t.muted)
        .when(on, (el) => el.child(div().size(8).rounded_full().bg(t.foreground))))
      .child(div().flex_1().min_w(0).truncate().text_size(S().body).child(r.name))
      .child(div().flex_none().max_w(160).truncate().text_size(S().label).text_color(t.muted).child(r.badge));
  }

  render(cx) {
    const t = theme(), width = panelWidth(this.window), d = this.dialog;
    const backdrop = div().id("refactor-popup").size_full().flex().items_center().justify_center().bg("#000000a6")
      .on_size_change((win, cx) => {
        const first = !this.window;
        this.window = win;
        this.input.set_rows(focusRows(S().body)); // the text size may have changed since the dialog opened
        if (first) cx.timer.after(50, () => this.input.focus?.()); // the window is there now, so the keyboard goes to the box
        cx.notify();
      })
      .on_mouse_down("left", (_e, cx) => { this.close(); cx.stop_propagation(); });
    const list = !d.loaded ? note(t, "Loading…")
      : d.empty() ? note(t, EMPTY_TEXT)
      : !d.rows.length ? null // reading the types failed: only the error shows
      : div().id("refactor-types").max_h(220).overflow_y_scrollbar().child(v_flex().gap(2).children(d.rows.map((r) => this.row(t, r))));
    const panel = v_flex().id("refactor").track_focus(this.handle).w(width ?? 0).flex_none().p(16).gap(12).rounded(12).border_1().border_color(t.border)
      .bg(t.background).text_color(t.foreground).text_size(S().body).shadow_lg()
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(div().text_size(S().title).font_semibold().child(TITLE))
      .child(div().text_size(S().secondary).text_color(t.muted).child(SUBTITLE))
      .when(Boolean(list), (el) => el.child(list))
      .child(v_flex().gap(6)
        .child(div().text_size(S().secondary).text_color(t.muted).child(FOCUS_LABEL))
        .child(div().id("refactor-focus").h(FOCUS_HEIGHT).flex_none().min_h(0).overflow_hidden().rounded(8).border_1().border_color(t.border).bg(t.chrome).p(8)
          .child(Textarea.new(this.input).size_full().text_size(S().body).text_color(t.foreground))))
      .when(Boolean(d.error), (el) => el.child(div().id("refactor-error").flex_none().text_size(S().secondary).text_color(t.blocked).child(`! ${d.error}`)))
      .child(h_flex().gap(8).items_center()
        .child(div().id("refactor-hint").flex_1().min_w(0).truncate().text_size(S().label).text_color(t.muted).child(ENTER_HINT))
        .child(action("refactor-cancel", "Cancel", t, () => this.close(), true, d.starting))
        .child(action("refactor-start", d.starting ? "Starting…" : "Start", t, (_e, cx) => this.start(cx), false, !d.canStart())));
    return stopPresses(backdrop, "left").when(Boolean(width), (el) => el.child(stopPresses(panel)));
  }
}
