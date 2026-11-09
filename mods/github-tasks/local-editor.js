// A local task, in the center: the editor (editor.js) over a YAML file instead of a GitHub issue (props.local = { mainRoot }).
// It saves title, description and labels to the file (renaming it when the slug changes) and moves the file when the status
// changes. Labels are typed freely. Saves are last-write-wins, so nothing checks what is in the file first. The ticket is
// localTicket's: number is the task's id. Start works as in the GitHub editor, with the task as the ticket.
import { div } from "gpui-kit";
import { h_flex, InputState, Input } from "gpui-base";
import { run, setShared } from "herdr";
import { snapshot } from "./model.js";
import { TaskEditor, CHANGED } from "./editor.js";
import { localTasks } from "./local-tasks-env.js";
import { LOCAL_STATUS_OPTIONS, typedLabels } from "./local-ui.js";
import { S, icon, stop, note } from "./ui.js";

const tabName = (ticket, title) => `#${ticket.number} ${title}`;

export class LocalTaskEditor extends TaskEditor {
  constructor(props, cx) {
    super(props, cx);
    this.mainRoot = props?.local?.mainRoot ?? "";
    this.labelInput = InputState.new({ placeholder: "Type a label and press Enter" });
    this.labelInput.on("submit", (_e, cx) => this.addLabels(cx));
  }

  // A label typed but not yet confirmed with Enter counts as a change, so Save is there for it.
  dirty() {
    return super.dirty() || typedLabels(this.labelInput?.value()).some((l) => !this.labels.has(l));
  }

  // Revert also drops label text that was typed but not confirmed.
  revert(cx) {
    this.labelInput?.set_value("");
    super.revert(cx);
  }

  tasks() { return localTasks(this.props.local?.mainRoot ?? ""); }

  // Reads the task's file and puts it on screen.
  load(cx) {
    this.loaded = false;
    this.loadError = null;
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const task = await this.tasks().get(this.ticket.number);
        if (!task) throw new Error(`Task #${this.ticket.number} isn't there any more: its file was moved or deleted.`);
        this.statusField = { options: LOCAL_STATUS_OPTIONS };
        this.labelChoices = [];
        this.labels = new Set(task.labels);
        this.status = task.status;
        this.titleInput.set_value(task.title);
        this.bodyInput.set_value(task.description);
        this.base = snapshot({ title: task.title, body: task.description, labels: task.labels, status: task.status });
        this.leaveBody(); // the Description shows as rendered markdown (editor.js)
        this.loaded = true;
        this.checkStartable(cx);
        if (this.autoStart) { this.autoStart = false; this.openStart(cx); }
      } catch (e) {
        this.loadError = { kind: "other", message: String(e?.message ?? e) };
      }
      cx.notify();
    });
  }

  // Writes the changes to the file, and moves it when the status changed. Nobody is asked first.
  save(cx) {
    if (this.saving) return;
    this.addLabels(cx, false); // text typed in the label field but not confirmed with Enter still counts
    if (!this.dirty()) return;
    const typed = this.current(), after = snapshot({ ...typed, title: typed.title.trim() });
    this.saving = true;
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const { ticket, base } = this, id = ticket.number, tasks = this.tasks();
      try {
        const fields = after.title !== base.title || after.body !== base.body || after.labels.join("\n") !== base.labels.join("\n");
        if (fields) {
          await tasks.save(id, { title: after.title, description: after.body, labels: after.labels });
          this.base = { ...after, status: base.status }; // the fields are in the file even if the move below fails
        }
        if (after.title !== typed.title) this.titleInput.set_value(after.title); // "Fix " is saved as "Fix": the field shows it
        if (after.status && after.status !== base.status) await tasks.move(id, after.status);
        const renamed = after.title !== base.title;
        this.base = after;
        this.notice = { kind: "saved", text: "Saved." };
        this.leaveBody();
        this.checkStartable(cx);
        if (renamed) run("tab.rename", { name: tabName(ticket, after.title) });
        setShared(CHANGED, Date.now());
      } catch (e) {
        this.notice = { kind: "error", text: String(e?.message ?? e), error: { kind: "other" } };
        setShared(CHANGED, Date.now()); // part of it may have been written
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  // The label field's text, added to the labels.
  addLabels(cx, notify = true) {
    const names = typedLabels(this.labelInput.value());
    if (!names.length) return;
    if (this.notice?.kind === "saved") this.notice = null;
    for (const name of names) this.labels.add(name);
    this.labelInput.set_value("");
    if (notify) cx.notify();
  }

  removeLabel(name, cx) {
    if (this.notice?.kind === "saved") this.notice = null;
    this.labels.delete(name);
    cx.notify();
  }

  renderHeader(t) {
    const folder = String(this.mainRoot).split("/").filter(Boolean).pop() || this.mainRoot;
    return h_flex().h(44).flex_none().pl(20).pr(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(S().secondary).text_color(t.muted).child(`#${this.ticket.number} · ${folder}`))
      .child(div().flex_none().text_size(S().label).text_color(t.muted).child("Local"));
  }

  // The labels as pills that come off when pressed, and a field to type new ones in. No suggestions.
  renderLabels(t) {
    const names = [...this.labels].sort();
    const pill = (name) => h_flex().id(`label-${name}`).h(26).pl(10).pr(6).gap(6).flex_none().items_center().rounded(13).cursor_pointer()
      .border_1().border_color(t.border).bg(t.selected).text_size(S().label).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop).on_click((_e, cx) => this.removeLabel(name, cx))
      .child(name).child(icon("close", 10, t.muted));
    return this.section(t, "Labels", h_flex().flex_wrap().gap(6).items_center()
      .children(names.length ? names.map(pill) : [note(t, "None")])
      .child(div().id("field-label").h(28).w(220).flex_none().px(10).flex().items_center().rounded(8).border_1().border_color(t.input)
        .on_mouse_down("left", stop).child(Input.new(this.labelInput).h_full().w_full().text_size(S().body).text_color(t.foreground))));
  }
}
