// One ticket, in the center: a tab the Tasks panel opens when a row is clicked (props.role "editor").
// The title, body, status and labels are editable; Save sends only what changed to GitHub.
// Not a View of its own: main.js builds one in init and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { run, setShared, theme } from "herdr";
import { snapshot, isDirty, changes } from "./model.js";
import { GitHubError, loadTask, loadStatusField, loadRepoLabels, saveTask } from "./loader.js";
import { S, icon, stop, iconButton, action, gh } from "./ui.js";
import { Auth, REFRESH, LOGIN } from "./auth.js";

// Set to the time of each save, so the panel's list refreshes.
export const CHANGED = "github-tasks.changed";

// The dim layer behind the picker: the theme's background, half see-through where it is a hex color.
const scrim = (t) => (/^#[0-9a-f]{6}$/i.test(t.background ?? "") ? `${t.background}b3` : t.background);
const tabName = (ticket, title) => (ticket.draft ? title : `#${ticket.number} ${title}`);
const SIGN_IN_KINDS = { "no-write-scope": REFRESH, "no-scope": REFRESH, "no-auth": LOGIN };

export class TaskEditor {
  constructor(props, cx) {
    this.ticket = props?.ticket ?? {};
    this.repo = props?.repo ?? "";
    this.project = props?.project ?? null;
    this.where = props?.where ?? {};
    this.draft = Boolean(this.ticket.draft);

    this.auth = new Auth();
    this.titleInput = InputState.new({ value: this.ticket.title ?? "" });
    this.bodyInput = TextareaState.new({ value: "", rows: 12 });
    const touched = (_e, cx) => { if (this.notice?.kind === "saved") this.notice = null; cx.notify(); };
    this.titleInput.on("change", touched);
    this.bodyInput.on("change", touched);
    this.titleInput.on("submit", (_e, cx) => this.save(cx));

    // The picker dialog for status or labels: which one is open, and its search.
    this.picker = null; // null | "status" | "labels"
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.on("submit", (_e, cx) => { const first = this.options()[0]; if (first) this.choose(first.name, cx); });

    this.status = this.ticket.status ?? null;
    this.labels = new Set();
    this.labelChoices = []; // [{ name, color }]
    this.statusField = null;
    this.base = snapshot({ title: this.ticket.title, status: this.status }); // what GitHub holds, as far as we know
    this.updatedAt = null;
    this.loaded = false;
    this.loadError = null;
    this.saving = false;
    this.notice = null; // { kind: "saved" | "error" | "conflict", text, error? }
    this.size = null;
    this.load(cx);
  }

  current() {
    return snapshot({ title: this.titleInput.value(), body: this.bodyInput.value(), labels: [...this.labels], status: this.status });
  }

  dirty() {
    return this.loaded && isDirty(this.base, this.current(), { draft: this.draft });
  }

  // Reads the ticket, the project's statuses and the repo's labels, and puts them on screen.
  load(cx) {
    this.loaded = false;
    this.loadError = null;
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const { ticket, repo, project, where } = this;
      const [task, field, labels] = await Promise.allSettled([
        loadTask(gh, repo, ticket, where),
        project ? loadStatusField(gh, project.id, where) : Promise.resolve(null),
        this.draft ? Promise.resolve([]) : loadRepoLabels(gh, repo, where),
      ]);
      if (task.status === "rejected") {
        this.loadError = task.reason instanceof GitHubError ? task.reason : { kind: "other", message: String(task.reason?.message ?? task.reason) };
      } else {
        this.statusField = field.status === "fulfilled" ? field.value : null;
        this.labelChoices = labels.status === "fulfilled" ? labels.value : [];
        for (const name of task.value.labels) if (!this.labelChoices.some((l) => l.name === name)) this.labelChoices.push({ name, color: "8b949e" });
        this.labels = new Set(task.value.labels);
        this.status = this.ticket.status ?? null;
        this.updatedAt = task.value.updatedAt;
        this.titleInput.set_value(task.value.title);
        this.bodyInput.set_value(task.value.body);
        this.base = snapshot({ ...task.value, status: this.status });
        this.loaded = true;
      }
      cx.notify();
    });
  }

  revert(cx) {
    this.titleInput.set_value(this.base.title);
    this.bodyInput.set_value(this.base.body);
    this.labels = new Set(this.base.labels);
    this.status = this.base.status;
    this.notice = null;
    cx.notify();
  }

  // Sends the changes. Unless force, first checks that nobody changed the ticket on GitHub since it
  // was read, and asks instead of overwriting.
  save(cx, force = false) {
    if (this.saving || !this.dirty()) return;
    const after = this.current();
    this.saving = true;
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const { ticket, repo, project, where } = this;
      try {
        if (!force) {
          const fresh = await loadTask(gh, repo, ticket, where);
          if (fresh.updatedAt !== this.updatedAt) {
            this.notice = { kind: "conflict", text: "This ticket changed on GitHub after you opened it." };
            return;
          }
        }
        await saveTask(gh, { repo, ticket, project, statusField: this.statusField, before: this.base, after }, where);
        const renamed = after.title !== this.base.title;
        this.base = after;
        this.updatedAt = await loadTask(gh, repo, ticket, where).then((t) => t.updatedAt, () => this.updatedAt);
        this.notice = { kind: "saved", text: "Saved to GitHub." };
        if (renamed) run("tab.rename", { name: tabName(ticket, after.title) });
        setShared(CHANGED, Date.now());
      } catch (e) {
        const error = e instanceof GitHubError ? e : { kind: "other", message: String(e?.message ?? e) };
        this.notice = { kind: "error", text: error.message, error };
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  openPicker(kind, cx) {
    this.picker = kind;
    this.search.set_value("");
    cx.notify();
    cx.timer.after(50, () => this.search.focus());
  }

  closePicker(cx) {
    this.picker = null;
    cx.notify();
  }

  // The picker's options that match the search: [{ name, color? }].
  options() {
    const all = this.picker === "status" ? (this.statusField?.options ?? []) : this.labelChoices;
    const q = this.search.value().trim().toLowerCase();
    return q ? all.filter((o) => o.name.toLowerCase().includes(q)) : all;
  }

  // A pick in the open picker: a status is chosen and the dialog closes; a label is toggled and it stays.
  choose(name, cx) {
    if (this.notice?.kind === "saved") this.notice = null;
    if (this.picker === "status") { this.status = name; this.picker = null; }
    else if (this.labels.has(name)) this.labels.delete(name);
    else this.labels.add(name);
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const body = this.loadError ? this.renderLoadError(t)
      : !this.loaded ? v_flex().flex_1().min_h(0).p(20).gap(10)
        .children([0, 1, 2].map((i) => div().h(i === 0 ? 40 : 90).flex_none().rounded(8).bg(t.chrome).opacity(1 - i * 0.2)))
      : v_flex().flex_1().min_h(0).px(20).py(16).gap(14)
        .child(this.field(t, "title", this.titleInput, 36))
        .child(this.renderStatus(t))
        .when(!this.draft, (el) => el.child(this.renderLabels(t)))
        .child(this.renderBody(t));
    return v_flex().id("task-editor").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .on_size_change((size, cx) => { this.size = size; this.bodyInput.set_rows(this.rows()); cx.notify(); })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.picker) { this.closePicker(cx); cx.stop_propagation(); }
        else if (e.keystroke === "cmd-s") { this.save(cx); cx.stop_propagation(); }
      })
      .child(this.renderHeader(t))
      .child(body)
      .when(this.loaded, (el) => el.child(this.renderFooter(t, cx)))
      .when(Boolean(this.picker), (el) => el.child(this.renderPicker(t)));
  }

  // Rows the body field gets: what the window leaves after the fields around it.
  rows() {
    const line = S().body * 1.5, room = (this.size?.height ?? 700) - 340;
    return Math.max(6, Math.floor(room / line));
  }

  renderHeader(t) {
    const { ticket } = this;
    return h_flex().h(44).flex_none().pl(20).pr(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(S().secondary).text_color(t.muted)
        .child(ticket.draft ? `Draft · ${this.repo}` : `#${ticket.number} · ${this.repo}`))
      .when(Boolean(ticket.url), (el) => el.child(iconButton("task-open", "external", t, (_e, cx) => cx.open_url(ticket.url))))
      .when(Boolean(this.project), (el) => el.child(div().flex_none().text_size(S().label).text_color(t.muted).child(this.project.title)));
  }

  renderLoadError(t) {
    return v_flex().flex_1().min_h(0).p(20).gap(10)
      .child(h_flex().gap(7).items_start().text_size(S().secondary).text_color(t.ansi1)
        .child(icon("alert", 14, t.ansi1))
        .child(div().flex_1().min_w(0).child(this.loadError.message)))
      .child(action("task-reload", "Try again", t, (_e, cx) => this.load(cx)));
  }

  // A bordered one-line text field around an Input.
  field(t, id, state, height) {
    return div().id(`field-${id}`).h(height).flex_none().px(10).flex().items_center().rounded(8).border_1().border_color(t.input)
      .on_mouse_down("left", stop).child(Input.new(state).h_full().w_full().text_size(S().body).text_color(t.foreground));
  }

  // A heading, with a pencil that opens the picker when onEdit is given.
  section(t, label, child, onEdit) {
    return v_flex().flex_none().gap(6)
      .child(h_flex().h(24).gap(4).items_center()
        .child(div().text_size(S().label).font_semibold().text_color(t.muted).child(label))
        .when(Boolean(onEdit), (el) => el.child(iconButton(`edit-${label.toLowerCase()}`, "edit", t, onEdit))))
      .child(child);
  }

  // A pill showing a value. Not pressable: values change in the picker.
  pill(t, id, label, color) {
    return h_flex().id(id).h(26).px(10).gap(6).flex_none().items_center().rounded(13)
      .border_1().border_color(t.border).bg(t.selected).text_size(S().label).text_color(t.foreground)
      .when(Boolean(color), (el) => el.child(div().w(8).h(8).flex_none().rounded_full().bg(color)))
      .child(label);
  }

  renderStatus(t) {
    const options = this.statusField?.options ?? [];
    if (!options.length && !this.status) return div();
    return this.section(t, "Status", h_flex().flex_wrap().gap(6)
      .child(this.status ? this.pill(t, "status-current", this.status) : note(t, "None")),
    options.length ? (_e, cx) => this.openPicker("status", cx) : null);
  }

  renderLabels(t) {
    if (!this.labelChoices.length) return div();
    const chosen = [...this.labels].sort().map((name) => ({ name, color: this.labelChoices.find((l) => l.name === name)?.color }));
    return this.section(t, "Labels", h_flex().flex_wrap().gap(6)
      .children(chosen.length ? chosen.map((l) => this.pill(t, `label-${l.name}`, l.name, l.color && `#${l.color}`)) : [note(t, "None")]),
    (_e, cx) => this.openPicker("labels", cx));
  }

  // The dialog over the editor: a search box and the options, with the chosen ones marked.
  renderPicker(t) {
    const status = this.picker === "status", options = this.options();
    const row = (o) => {
      const on = status ? o.name === this.status : this.labels.has(o.name);
      return h_flex().id(`pick-${o.name}`).h(32).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).when(on, (el) => el.bg(t.selected))
        .on_mouse_down("left", stop).on_click((_e, cx) => this.choose(o.name, cx))
        .child(div().w(14).h(14).flex_none().child(on ? icon("check", 14, t.foreground) : div()))
        .when(Boolean(o.color), (el) => el.child(div().w(8).h(8).flex_none().rounded_full().bg(`#${o.color}`)))
        .child(div().flex_1().min_w(0).truncate().text_size(S().body).child(o.name));
    };
    const dialog = v_flex().id("task-picker").w(380).max_h(460).flex_none().p(16).gap(12).rounded(12).border_1().border_color(t.border)
      .bg(t.popover).shadow_lg().text_color(t.foreground).text_size(S().body)
      .on_mouse_down("left", stop)
      .child(h_flex().flex_none().items_center().gap(8)
        .child(div().flex_1().min_w(0).text_size(S().title).font_semibold().child(status ? "Status" : "Labels"))
        .child(div().text_size(S().label).text_color(t.muted).child("Esc"))
        .child(iconButton("picker-close", "close", t, (_e, cx) => this.closePicker(cx))))
      .child(h_flex().id("picker-search").h(34).flex_none().px(10).gap(8).items_center().rounded(8).border_1().border_color(t.input)
        .child(icon("search", 14, t.muted))
        .child(Input.new(this.search).h_full().flex_1().text_size(S().body).text_color(t.foreground)))
      .child(div().id("picker-options").max_h(300).overflow_y_scrollbar()
        .child(v_flex().gap(2).children(options.length ? options.map(row) : [div().px(8).py(8).child(note(t, "No matches."))])))
      .when(!status, (el) => el.child(h_flex().flex_none().justify_end().child(action("picker-done", "Done", t, (_e, cx) => this.closePicker(cx)))));
    return div().id("task-picker-backdrop").absolute().inset_0().flex().items_center().justify_center().bg(scrim(t))
      .on_mouse_down("left", (_e, cx) => { this.closePicker(cx); cx.stop_propagation(); })
      .child(dialog);
  }

  renderBody(t) {
    return v_flex().flex_1().min_h(0).gap(6)
      .child(div().flex_none().text_size(S().label).font_semibold().text_color(t.muted).child("Description"))
      .child(div().id("field-body").flex_1().min_h(0).p(10).rounded(8).border_1().border_color(t.input).on_mouse_down("left", stop)
        .child(Textarea.new(this.bodyInput).size_full().text_size(S().body).text_color(t.foreground)));
  }

  renderFooter(t, cx) {
    const dirty = this.dirty(), n = this.notice;
    const signIn = n?.kind === "error" ? SIGN_IN_KINDS[n.error?.kind] : null;
    const diff = changes(this.base, this.current(), { draft: this.draft });
    return v_flex().flex_none().px(20).py(12).gap(10).border_t(1).border_color(t.border)
      .when(Boolean(n) && n.kind !== "saved", (el) => el.child(h_flex().gap(7).items_start().text_size(S().secondary).text_color(t.ansi1)
        .child(icon("alert", 14, t.ansi1)).child(div().flex_1().min_w(0).child(n.text))))
      .when(n?.kind === "conflict", (el) => el.child(h_flex().gap(6)
        .child(action("task-overwrite", "Overwrite", t, (_e, cx) => this.save(cx, true)))
        .child(action("task-reload-remote", "Reload from GitHub", t, (_e, cx) => this.load(cx), true))))
      .when(Boolean(signIn) && !this.auth.state, (el) => el.child(action("task-sign-in", "Sign in to GitHub", t,
        (_e, cx) => this.auth.start(cx, signIn, this.where.on, (cx) => this.save(cx)))))
      .when(Boolean(signIn) && Boolean(this.auth.state), (el) => el.child(this.auth.render(t, (_e, cx) => this.auth.start(cx, signIn, this.where.on, (cx) => this.save(cx)))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(S().secondary).text_color(n?.kind === "saved" ? t.ansi2 : t.muted)
          .child(this.saving ? "Saving…" : n?.kind === "saved" ? n.text : dirty ? `Unsaved: ${Object.keys(diff).join(", ")}` : "No changes"))
        .child(action("task-revert", "Revert", t, (_e, cx) => this.revert(cx), true, !dirty || this.saving))
        .child(action("task-save", this.saving ? "Saving…" : "Save", t, (_e, cx) => this.save(cx), false, !dirty || this.saving)));
  }
}
