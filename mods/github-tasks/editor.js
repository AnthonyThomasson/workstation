// One ticket, in a large popup over the app (props.role "editor", props.popup): the Tasks panel opens it when a row is
// clicked. A popup is a full-window overlay this file draws itself: a dimmed backdrop and a panel in the middle, because
// Herdr would close a dialog on Esc or a click beside it before we could ask about unsaved edits (popup.js). An editor
// tab opened before that (no props.popup) still renders as before.
// The title, body, status and labels are editable; Save sends only what changed to GitHub.
// Not a View of its own: main.js builds one in init and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { run, setShared, theme, closeOverlay } from "herdr";
import { snapshot, isDirty, changes, pickableStatuses } from "./model.js";
import { GitHubError, loadTask, loadStatusField, saveTask, markWontDo } from "./loader.js";
import { loadLabels } from "./labels.js";
import { S, icon, stop, note, iconButton, action, gh, scrim } from "./ui.js";
import { Auth, REFRESH, LOGIN } from "./auth.js";
import { matchWorkflows } from "./match.js";
import { loadWorkflows } from "./workflow-env.js";
import { startRun } from "./start.js";
import { markdownLiteral } from "./settings-model.js";
import { panelSize, panelAppeared, closeStep, escStep, afterSave, PRESS_BUTTONS } from "./popup.js";
import { wontDoFooter, wontDoPrompt, windowSubject, retryAfterSignIn } from "./wontdo.js";
import { closeOpen, ticketSubject } from "./open-tabs.js";

// Set to the time of each save, so the panel's list refreshes.
export const CHANGED = "github-tasks.changed";

const tabName = (ticket, title) => (ticket.draft ? title : `#${ticket.number} ${title}`);
// Stops presses of every button (but `except`) on an element, so the popup's window isn't dragged by them.
const stopPresses = (el, except) => PRESS_BUTTONS.filter((b) => b !== except).reduce((e, b) => e.on_mouse_down(b, stop), el);
const SIGN_IN_KINDS = { "no-write-scope": REFRESH, "no-scope": REFRESH, "no-auth": LOGIN };

export class TaskEditor {
  constructor(props, cx) {
    this.props = props ?? {}; // local-editor.js reads its extras from here, because load() runs before its constructor does
    this.ticket = props?.ticket ?? {};
    this.repo = props?.repo ?? "";
    this.project = props?.project ?? null;
    this.where = props?.where ?? {};
    this.draft = Boolean(this.ticket.draft);
    this.popup = Boolean(props?.popup); // in the popup (see the top), not in a tab
    this.autoStart = Boolean(props?.autoStart); // the sidebar's Start asked for several workflows or none: show the dialog once loaded

    this.handle = cx.focus_handle(); // the editor's root takes the keyboard when the textarea goes, so Cmd-S still reaches it
    this.auth = new Auth();
    this.editingBody = false; // the Description shows as markdown, or as the textarea while this is true
    this.opened = false; // set by the first load: only then may an empty draft open in the textarea
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

    // The Start dialog: null, or { phase: "loading" | "ready" | "starting" | "error", matches, labels, chosen, error, skipped }.
    this.start = null;
    this.startable = false; // whether the saved labels match any workflow, which is what enables Start

    this.status = this.ticket.status ?? null;
    this.labels = new Set();
    this.labelChoices = []; // [{ name, color }]
    this.statusField = null;
    this.base = snapshot({ title: this.ticket.title, status: this.status }); // what GitHub holds, as far as we know
    this.updatedAt = null;
    this.loaded = false;
    this.loadError = null;
    this.saving = false;
    this.confirming = false; // the footer asks "Close #n as not planned…?" in place of its buttons
    this.retry = null; // what the sign-in button re-runs after an auth error: "wontdo", else a save
    this.wontDoing = false; // the Won't Do call is running: the footer's buttons are inert
    this.notice = null; // { kind: "saved" | "error" | "conflict", text, error? }
    this.size = null;

    // The popup's own state: the window's size, the "Unsaved changes" card, and what waits for a save to end ("card": Save
    // on that card; "close": a close request made while it ran).
    this.window = null;
    this.prompt = false;
    this.pending = null;
    if (this.popup) cx.timer.after(50, () => this.handle.focus()); // a window doesn't take the keyboard when it opens (render also focuses once the panel is there)
    this.load(cx);
  }

  current() {
    return snapshot({ title: this.titleInput.value(), body: this.bodyInput.value(), labels: [...this.labels], status: this.status });
  }

  // Whether this is a local task (local-editor.js): it has no project, so no Status option to be missing.
  isLocal() { return false; }

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
        this.draft ? Promise.resolve([]) : loadLabels(gh, repo, where),
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
        if (!this.opened && this.draft && !task.value.body.trim()) this.editingBody = true; else this.leaveBody();
        this.opened = true;
        this.base = snapshot({ ...task.value, status: this.status });
        this.loaded = true;
        this.checkStartable(cx);
        if (this.autoStart) { this.autoStart = false; this.openStart(cx); }
      }
      cx.notify();
    });
  }

  // Whether any workflow matches the ticket as GitHub holds it. Start stays dimmed until one does.
  checkStartable(cx) {
    const labels = [...this.base.labels], token = (this.checkToken = (this.checkToken ?? 0) + 1);
    cx.spawn(async (cx) => {
      let startable = false;
      try { startable = matchWorkflows((await loadWorkflows(this.where)).items, labels).length > 0; } catch { /* no workflows to read */ }
      if (token !== this.checkToken || startable === this.startable) return;
      this.startable = startable;
      cx.notify();
    });
  }

  revert(cx) {
    this.titleInput.set_value(this.base.title);
    this.bodyInput.set_value(this.base.body);
    this.leaveBody();
    this.labels = new Set(this.base.labels);
    this.status = this.base.status;
    this.notice = null;
    cx.notify();
  }

  // Sends the changes. Unless force, first checks that nobody changed the ticket on GitHub since it
  // was read, and asks instead of overwriting.
  save(cx, force = false) {
    if (this.saving || this.wontDoing || !this.dirty()) return;
    const after = this.current();
    this.saving = true;
    this.notice = null;
    this.retry = null;
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
        this.leaveBody();
        this.checkStartable(cx);
        if (renamed && !this.popup) run("tab.rename", { name: tabName(ticket, after.title) });
        setShared(CHANGED, Date.now());
      } catch (e) {
        const error = e instanceof GitHubError ? e : { kind: "other", message: String(e?.message ?? e) };
        this.notice = { kind: "error", text: error.message, error };
      } finally {
        this.saving = false;
        cx.notify();
        this.settleSave(cx); // last: it may close the popup
      }
    });
  }

  // Closing the popup. A request (Esc, the ✕, a press on the backdrop) closes it when nothing is unsaved, asks first when
  // something is, and waits for a save that is running: overlay tasks end with the popup, so a save is never cut off.
  requestClose(cx) {
    if (!this.popup) return;
    const step = closeStep({ dirty: this.dirty(), saving: this.saving, starting: this.start?.phase === "starting" });
    if (step === "close") this.closeNow();
    else if (step === "prompt") this.showPrompt(cx);
    else if (step === "wait") this.pending = this.pending ?? "close";
    cx.notify();
  }

  closeNow() {
    if (this.props.overlay) closeOverlay(this.props.overlay);
  }

  showPrompt(cx) {
    this.prompt = true;
    this.handle.focus(); // Enter and Esc go to the card, not to a field behind it
    cx.notify();
  }

  keepEditing(cx) {
    this.prompt = false;
    this.pending = null;
    this.handle.focus();
    cx.notify();
  }

  // Save on the card: saves, then closes. A save that fails leaves the popup open with the error showing.
  saveAndClose(cx) {
    if (!this.saving && !this.dirty()) { this.closeNow(); return; }
    this.pending = "card";
    this.save(cx);
  }

  // A save has ended: whatever waited for it goes on.
  settleSave(cx) {
    const next = afterSave({ pending: this.pending, dirty: this.dirty() });
    this.pending = null;
    if (next === "close") this.closeNow();
    else if (next === "prompt") this.showPrompt(cx);
    else if (next === "stay") this.prompt = false;
  }

  // The footer, as wontdo.js decides it: which buttons are on, and whether the confirm strip is up.
  footerState() {
    const f = wontDoFooter({
      draft: this.draft, saving: this.saving, dirty: this.dirty(), local: this.isLocal(), statusOptions: this.statusField?.options,
      startable: this.startable, confirming: this.confirming, busy: this.wontDoing,
    });
    if (f.dropConfirm) this.confirming = false; // reverting must not bring the question back
    return f;
  }

  // Gh has signed in again: the notice goes and what failed is run again (Won't Do is safe to repeat).
  afterSignIn(cx) {
    const again = retryAfterSignIn(this.retry);
    this.notice = null;
    this.retry = null;
    if (again === "wontdo") { this.confirming = true; this.wontDo(cx); } else this.save(cx);
  }

  // Won't Do asks first, in the footer. Cancel (or Escape) puts the buttons back and changes nothing.
  askWontDo(cx) {
    if (this.footerState().wontDo.disabled) return;
    this.confirming = true;
    this.notice = null;
    this.handle.focus(); // so Escape reaches the window even if a field had the keyboard
    cx.notify();
  }

  cancelWontDo(cx) {
    if (this.wontDoing) return;
    this.confirming = false;
    cx.notify();
  }

  // What marking the ticket Won't Do does at its source; local-editor.js moves the task's file instead. Throws on failure.
  async sendWontDo() {
    const { repo, ticket, project, statusField, where } = this;
    await markWontDo(gh, { repo, ticket, project, statusField }, where);
  }

  // Confirmed. On success the sidebar drops the ticket and this window closes; on failure the error shows in the footer
  // like Save's and the window stays.
  wontDo(cx) {
    if (this.wontDoing || !this.confirming) return;
    this.wontDoing = true;
    this.notice = null;
    this.retry = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let inert = false; // a success that left the window open: its buttons stay off
      try {
        await this.sendWontDo();
        this.confirming = false;
        setShared(CHANGED, Date.now());
      } catch (e) {
        const error = e instanceof GitHubError ? e : { kind: "other", message: String(e?.message ?? e) };
        this.confirming = false;
        this.retry = "wontdo";
        this.notice = { kind: "error", text: error.message, error };
        setShared(CHANGED, Date.now()); // the status may have been set even though closing failed
        this.wontDoing = false;
        cx.notify();
        return;
      }
      // It is done. Closing the tab is a courtesy: if it can't, the window stays, inert, and says so. Closing blind (no
      // recorded tab) could close another tab, so that is never tried.
      try {
        if (!closeOpen(windowSubject(this.props, ticketSubject(this.repo, this.ticket)))) throw new Error("no recorded tab");
      } catch {
        inert = true;
        this.notice = { kind: "saved", text: "Marked Won't Do. You can close this tab." };
      } finally {
        this.wontDoing = inert;
        cx.notify();
      }
    });
  }

  // Start: the workflow this ticket's labels trigger starts at once; when several do, the dialog lists them to
  // choose from. A ticket as GitHub holds it is what starts, so the saved labels are matched, not unsaved edits.
  openStart(cx) {
    const labels = [...this.base.labels], token = (this.startToken = (this.startToken ?? 0) + 1);
    this.start = { phase: "loading", matches: [], labels, chosen: null, error: null, skipped: [] };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { items, errors } = await loadWorkflows(this.where);
        if (token !== this.startToken || !this.start) return;
        const matches = matchWorkflows(items, labels);
        this.start = { ...this.start, phase: "ready", matches, skipped: errors };
        if (matches.length === 1) this.runWorkflow(matches[0], cx);
      } catch (e) {
        if (token !== this.startToken || !this.start) return;
        this.start = { ...this.start, phase: "error", error: String(e?.message ?? e) };
      }
      cx.notify();
    });
  }

  // Starts the workflow on the ticket. The dialog goes once the tab is open, and stays with the reason if it can't.
  runWorkflow(workflow, cx) {
    const ticket = { ...this.ticket, ...this.base };
    this.start = { ...this.start, phase: "starting", chosen: workflow, error: null };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const statusField = this.project ? await loadStatusField(gh, this.project.id, this.where).catch(() => null) : null; // without it the ticket's status just isn't moved
        await startRun(workflow, ticket, this.repo, this.where, cx, { project: this.project, statusField });
        this.start = null;
        if (this.popup) { this.closeNow(); return; } // the run's tab is open: the popup has done its job
      } catch (e) {
        this.start = { ...this.start, phase: "error", error: String(e?.message ?? e) };
      }
      cx.notify();
    });
  }

  // A run that is starting finishes first: it can't be called back halfway, and the dialog says how it went.
  closeStart(cx) {
    if (this.start?.phase === "starting") return;
    this.startToken++;
    this.start = null;
    cx.notify();
  }

  // Switches the Description between rendered markdown and the textarea, which takes focus. The text is kept either way.
  setEditingBody(on, cx) {
    if (on) { this.editingBody = true; cx.timer.after(50, () => this.bodyInput.focus?.()); }
    else this.leaveBody();
    cx.notify();
  }

  // Back to rendered markdown. The textarea goes with its focus, so the editor's root takes the keyboard (Cmd-S).
  leaveBody() {
    this.editingBody = false;
    this.handle.focus();
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
    const all = this.picker === "status" ? pickableStatuses(this.statusField?.options) : this.labelChoices; // Won't Do is the button's, not the picker's
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
    if (!this.popup) return this.renderEditor(cx);
    const t = theme(), panel = panelSize(this.window);
    // The backdrop covers the window; a press on it asks to close, and the panel stops presses so they don't. The
    // stops also keep the window from being dragged.
    const backdrop = div().id("editor-popup").size_full().flex().items_center().justify_center().bg("#000000a6")
      .on_size_change((win, cx) => {
        // The editor's root only exists once the window is measured, so that is when it can take the keyboard.
        if (panelAppeared(this.window, win)) cx.timer.after(50, () => this.handle.focus());
        this.window = win;
        cx.notify();
      })
      .on_mouse_down("left", (_e, cx) => { this.requestClose(cx); cx.stop_propagation(); });
    return stopPresses(backdrop, "left")
      .when(Boolean(panel), (el) => el.child(stopPresses(div().id("editor-panel").w(panel.width).h(panel.height).flex_none().rounded(12).border_1().border_color(t.border)
        .overflow_hidden().shadow_lg()).child(this.renderEditor(cx))));
  }

  renderEditor(cx) {
    const t = theme();
    const body = this.loadError ? this.renderLoadError(t)
      : !this.loaded ? v_flex().flex_1().min_h(0).p(20).gap(10)
        .children([0, 1, 2].map((i) => div().h(i === 0 ? 40 : 90).flex_none().rounded(8).bg(t.chrome).opacity(1 - i * 0.2)))
      : v_flex().flex_1().min_h(0).px(20).py(16).gap(14)
        .child(this.field(t, "title", this.titleInput, 36))
        .child(this.renderStatus(t))
        .when(!this.draft, (el) => el.child(this.renderLabels(t)))
        .child(this.renderBody(t));
    return v_flex().id("task-editor").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .on_size_change((size, cx) => { this.size = size; this.bodyInput.set_rows(this.rows()); cx.notify(); })
      .on_key_down((e, cx) => {
        if (this.prompt && (e.keystroke === "enter" || e.keystroke === "cmd-s")) { this.saveAndClose(cx); cx.stop_propagation(); return; }
        if (e.key === "escape") {
          const step = escStep({ prompt: this.prompt, start: Boolean(this.start), picker: Boolean(this.picker), confirm: this.confirming, popup: this.popup });
          if (step === "none") return;
          if (step === "keep-editing") this.keepEditing(cx);
          else if (step === "close-start") this.closeStart(cx);
          else if (step === "close-picker") this.closePicker(cx);
          else if (step === "cancel-confirm") this.cancelWontDo(cx);
          else this.requestClose(cx);
          cx.stop_propagation();
        } else if (e.keystroke === "cmd-s") { this.save(cx); cx.stop_propagation(); }
      })
      .when(this.popup, (el) => el.child(this.renderPopupBar(t)))
      .child(this.renderHeader(t))
      .child(body)
      .when(this.loaded, (el) => el.child(this.renderFooter(t, cx)))
      .when(Boolean(this.picker), (el) => el.child(this.renderPicker(t)))
      .when(Boolean(this.start), (el) => el.child(this.renderStart(t)))
      .when(this.prompt, (el) => el.child(this.renderUnsaved(t)));
  }

  // The popup's top bar: the ticket's name, and the ✕.
  renderPopupBar(t) {
    const title = this.base.title ?? this.ticket.title ?? "", { ticket } = this;
    return h_flex().h(48).flex_none().pl(20).pr(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(S().title).font_semibold().child(ticket.draft ? title : `#${ticket.number} ${title}`))
      .child(div().flex_none().text_size(S().label).text_color(t.muted).child("Esc"))
      .child(iconButton("popup-close", "close", t, (_e, cx) => this.requestClose(cx), false, "Close"));
  }

  // The card a close with unsaved edits shows over the dimmed editor.
  renderUnsaved(t) {
    const card = v_flex().id("task-unsaved").w(400).flex_none().p(16).gap(12).rounded(12).border_1().border_color(t.border)
      .bg(t.popover).shadow_lg().text_color(t.foreground).text_size(S().body)
      .on_mouse_down("left", stop)
      .child(div().text_size(S().title).font_semibold().child("Unsaved changes"))
      .child(note(t, "Save your edits before closing?"))
      .child(h_flex().gap(8).justify_end()
        .child(action("unsaved-keep", "Keep editing", t, (_e, cx) => this.keepEditing(cx), true))
        .child(action("unsaved-discard", "Discard", t, () => this.closeNow(), true, this.saving))
        .child(action("unsaved-save", this.saving ? "Saving…" : "Save", t, (_e, cx) => this.saveAndClose(cx), false, this.saving)));
    return div().id("task-unsaved-backdrop").absolute().inset_0().flex().items_center().justify_center().bg(scrim(t))
      .on_mouse_down("left", stop)
      .child(card);
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
    const options = pickableStatuses(this.statusField?.options);
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

  // The dialog Start opens: the workflow starting, why it couldn't, or, when the labels trigger several, a
  // list to choose from first.
  renderStart(t) {
    const s = this.start, chosen = s.chosen, several = s.matches.length > 1;
    const title = chosen ? chosen.name : several ? "Choose a workflow" : "Start";
    const close = (_e, cx) => this.closeStart(cx);
    const where = (w) => (w.scope === "global" ? "Global" : "Repo");
    const row = (w) => h_flex().id(`start-${w.scope}-${w.id}`).flex_none().px(10).py(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((st) => st.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => this.runWorkflow(w, cx))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(S().body).font_medium().child(w.name))
        .child(div().truncate().text_size(S().label).text_color(t.muted).child(w.trigger.labels.length ? `${w.trigger.match === "all" ? "All of" : "Any of"}: ${w.trigger.labels.join(", ")}` : "Fallback: no labels")))
      .child(div().flex_none().px(6).h(18).flex().items_center().rounded(9).border_1().border_color(t.border).text_size(S().label).text_color(t.muted).child(where(w)))
      .child(icon("chevron-right", 14, t.muted));
    const body = s.phase === "loading" ? v_flex().gap(8).children([0, 1].map((i) => div().h(40).flex_none().rounded(8).bg(t.chrome).opacity(1 - i * 0.3)))
      : s.phase === "error" ? note(t, s.error, t.ansi1)
      : s.phase === "starting" ? h_flex().gap(8).items_center().child(icon("ring", 14, t.muted).spin(900)).child(note(t, "Getting the branch ready and starting the orchestrator…"))
      : several ? div().id("start-list").max_h(380).overflow_y_scrollbar().child(v_flex().gap(2).children(s.matches.map(row)))
      : v_flex().gap(6)
        .child(note(t, s.labels.length ? "No workflow matches this ticket's labels." : "This ticket has no labels, and no workflow is the fallback."))
        .child(note(t, "Make one in the Task settings."));
    const labels = s.labels.length ? s.labels.join(", ") : "none";
    const dialog = v_flex().id("task-start").w(560).max_h(560).flex_none().p(16).gap(12).rounded(12).border_1().border_color(t.border)
      .bg(t.popover).shadow_lg().text_color(t.foreground).text_size(S().body)
      .on_mouse_down("left", stop)
      .child(h_flex().flex_none().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(S().title).font_semibold().child(title))
        .child(div().text_size(S().label).text_color(t.muted).child("Esc"))
        .child(iconButton("start-close", "close", t, close)))
      .child(div().flex_none().truncate().text_size(S().label).text_color(t.muted).child(`Matched on labels: ${labels}`))
      .child(body)
      .when(s.skipped.length > 0, (el) => el.child(note(t, `Skipped unreadable workflows: ${s.skipped.join("; ")}`, t.ansi1)));
    return div().id("task-start-backdrop").absolute().inset_0().flex().items_center().justify_center().bg(scrim(t))
      .on_mouse_down("left", (_e, cx) => { this.closeStart(cx); cx.stop_propagation(); })
      .child(dialog);
  }

  // The Description: rendered markdown (HTML kept as text) that scrolls inside its box, or the textarea while editing.
  renderBody(t) {
    const editing = this.editingBody, text = this.bodyInput.value();
    const content = editing ? Textarea.new(this.bodyInput).size_full().text_size(S().body).text_color(t.foreground)
      : text.trim() ? div().id("body-scroll").size_full().overflow_y_scrollbar().child(TextView.markdown("ticket-body", markdownLiteral(text)).selectable(true))
      : note(t, "No description");
    return v_flex().flex_1().min_h(0).gap(6)
      .child(h_flex().flex_none().h(24).gap(4).items_center()
        .child(div().text_size(S().label).font_semibold().text_color(t.muted).child("Description"))
        .child(iconButton("edit-description", editing ? "eye" : "edit", t, (_e, cx) => this.setEditingBody(!editing, cx), false, editing ? "Show rendered" : "Edit")))
      .child(div().id("field-body").flex_1().min_h(0).p(10).rounded(8).border_1().border_color(t.input)
        .on_mouse_down("left", stop)
        .child(content));
  }

  renderFooter(t, cx) {
    const dirty = this.dirty(), n = this.notice;
    const signIn = n?.kind === "error" ? SIGN_IN_KINDS[n.error?.kind] : null;
    const diff = changes(this.base, this.current(), { draft: this.draft });
    const f = this.footerState(), working = this.isLocal() ? "Moving…" : "Closing…";
    const wontDoButton = (id, label, onClick, disabled, tip) => action(id, label, t, onClick, false, disabled, { danger: true, tip });
    return v_flex().flex_none().px(20).py(12).gap(10).border_t(1).border_color(t.border)
      .when(Boolean(n) && n.kind !== "saved", (el) => el.child(h_flex().gap(7).items_start().text_size(S().secondary).text_color(t.ansi1)
        .child(icon("alert", 14, t.ansi1)).child(div().flex_1().min_w(0).child(n.text))))
      .when(n?.kind === "conflict", (el) => el.child(h_flex().gap(6)
        .child(action("task-overwrite", "Overwrite", t, (_e, cx) => this.save(cx, true)))
        .child(action("task-reload-remote", "Reload from GitHub", t, (_e, cx) => this.load(cx), true))))
      .when(Boolean(signIn) && !this.auth.state, (el) => el.child(action("task-sign-in", "Sign in to GitHub", t,
        (_e, cx) => this.auth.start(cx, signIn, this.where.on, (cx) => this.afterSignIn(cx)))))
      .when(Boolean(signIn) && Boolean(this.auth.state), (el) => el.child(this.auth.render(t, (_e, cx) => this.auth.start(cx, signIn, this.where.on, (cx) => this.afterSignIn(cx)))))
      .child(f.confirm
        ? h_flex().gap(8).items_center()
          .child(this.wontDoing ? icon("ring", 14, t.muted).spin(900) : icon("alert", 14, t.ansi1))
          .child(div().flex_1().min_w(0).truncate().text_size(S().secondary).text_color(t.foreground)
            .child(this.wontDoing ? working : wontDoPrompt({ number: this.ticket.number, local: this.isLocal() })))
          .child(action("wontdo-cancel", "Cancel", t, (_e, cx) => this.cancelWontDo(cx), true, f.cancel.disabled))
          .child(wontDoButton("wontdo-confirm", "Won't Do", (_e, cx) => this.wontDo(cx), f.ok.disabled))
        : h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(S().secondary).text_color(n?.kind === "saved" ? t.ansi2 : t.muted)
            .child(this.saving ? "Saving…" : n?.kind === "saved" ? n.text : dirty ? `Unsaved: ${Object.keys(diff).join(", ")}` : "No changes"))
          .child(wontDoButton("task-wontdo", "Won't Do", (_e, cx) => this.askWontDo(cx), f.wontDo.disabled, f.wontDo.tip))
          .child(action("task-start", "Start", t, (_e, cx) => this.openStart(cx), true, f.start.disabled))
          .child(action("task-revert", "Revert", t, (_e, cx) => this.revert(cx), true, f.revert.disabled))
          .child(action("task-save", this.saving ? "Saving…" : "Save", t, (_e, cx) => this.save(cx), false, f.save.disabled)));
  }
}
