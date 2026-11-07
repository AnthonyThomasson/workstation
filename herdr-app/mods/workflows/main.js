// Workflows: how work gets done. Each one names the GitHub label that triggers it and how its
// orchestrator, worker and reviewer run (prompt, agent, model, effort), kept as a JSON file. The panel
// lists them by name and starts new ones; a click opens one in a tab of its own to edit (editor.js).
// Global workflows are kept for everyone on this workstation and copied into the repo's clone.
// Roles (props.role): the panel (default); "toggle", the tab-bar button that opens or closes the
// layout's shared side panel on this panel, as Tasks and Skillshare do; "editor", one workflow in the center.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, spaces, focused, shared, setShared, theme, layout, nextCommand, props as blockProps } from "herdr";
import { S, icon, stop, note, iconButton, action } from "./ui.js";
import { WorkflowEditor } from "./editor.js";
import { CHANGED, REPO_KEY, store, repoDir, checkRepo, expandHome } from "./env.js";

const PANEL = "panel", STACK = "panel-body", SHOWN = "workflows";
const POLL = 5000; // a listing of a local folder costs nothing; this picks up files that arrive by git pull
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}
const shownHere = () => {
  const root = layout(), panel = find(root, PANEL), body = find(root, STACK);
  return Boolean(panel && !panel.hidden && body?.active === SHOWN);
};

// Work started from render: cx.notify() throws while a view renders, so it starts after.
const later = (cx, fn) => cx.spawn(async (cx) => { await cx.sleep(0); return fn(cx); });

function toggle() {
  const t = theme(), on = shownHere();
  return h_flex().size_full().pr(8).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
    .child(h_flex().id("toggle-workflows").h(26).w(100).justify_center().gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => {
        if (on) run("layout.hide", { id: PANEL });
        else { run("layout.select", { stack: STACK, child: SHOWN }); run("layout.show", { id: PANEL }); }
      })
      .child(svg("mods/workflows/icons/workflows.svg").size(14))
      .child("Workflows"));
}

export default class Workflows extends View {
  init(_props, cx) {
    this.role = blockProps()?.role ?? "panel";
    if (this.role === "toggle") return;
    if (this.role === "editor") { this.editor = new WorkflowEditor(blockProps(), cx); return; }
    this.handle = cx.focus_handle();
    this.items = [];
    this.loaded = false;
    this.error = null;
    this.lastCwd = new Map(); // each space's last known terminal folder; focus on a panel has none
    this.confirming = null; // the id whose trash was pressed once; a second press deletes it
    this.changedAt = shared(CHANGED) ?? null; // a save in an editor tab refreshes the list
    this.wasHidden = true;
    this.repoInput = InputState.new({ value: shared(REPO_KEY) ?? "", placeholder: "~/path/to/workstation" });
    this.repoInput.on("submit", (_e, cx) => this.saveRepo(cx));
    this.repoNote = null; // { text, ok } about the clone path just entered
    this.refresh(cx);
    // A hidden panel is not drawn, so it cannot notice being shown again: look while it shows.
    cx.timer.every(POLL, (cx) => { if (shownHere()) this.refresh(cx); });
    cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "focus") this.handle.focus(); cx.notify(); } });
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        this.items = await store().list();
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loaded = true;
      this.loading = false;
      cx.notify();
    });
  }

  // Remembers where the workstation clone is, if it looks like one.
  saveRepo(cx) {
    const value = this.repoInput.value().trim();
    cx.spawn(async (cx) => {
      if (!value) {
        setShared(REPO_KEY, "");
        this.repoNote = { text: "Global workflows stay in this app's folder only.", ok: true };
      } else {
        const ok = await checkRepo(expandHome(value).replace(/\/+$/, ""));
        if (ok) setShared(REPO_KEY, value);
        this.repoNote = ok
          ? { text: "Saved. Global workflows are copied there when saved.", ok }
          : { text: "No herdr-app folder there, so nothing was saved.", ok };
      }
      cx.notify();
    });
  }

  // Where the selected space is, as Tasks reads it: its focused terminal's folder, else the space's own,
  // and the machine it is on. The editor asks GitHub for the repo's labels from there.
  context() {
    const space = spaces().find((s) => s.active);
    if (!space) return null;
    const f = focused();
    if (f?.space === space.id && f.cwd) this.lastCwd.set(space.id, f.cwd);
    return { cwd: this.lastCwd.get(space.id) ?? (space.folder || undefined), on: space.machine ?? undefined };
  }

  openWorkflow(item) {
    run("tab.new", { name: item?.name ?? "New workflow", mod: "workflows", props: { role: "editor", id: item?.id ?? null, where: this.context() ?? {} } });
  }

  // First press arms the trash, the second deletes; the arming lapses after a few seconds.
  trash(item, cx) {
    if (this.confirming !== item.id) {
      this.confirming = item.id;
      cx.timer.after(3000, (cx) => { if (this.confirming === item.id) { this.confirming = null; cx.notify(); } });
      cx.notify();
      return;
    }
    this.confirming = null;
    cx.spawn(async (cx) => {
      try { await store().remove(item.id); } catch (e) { this.error = String(e?.message ?? e); }
      setShared(CHANGED, Date.now());
      this.refresh(cx);
    });
  }

  render(cx) {
    if (this.role === "toggle") return toggle();
    if (this.role === "editor") return this.editor.render(cx);
    const t = theme();
    this.context(); // keeps each space's folder current for the editor tabs this panel opens

    // An editor tab saved something, or the panel was just shown: the list may be stale.
    const changed = shared(CHANGED) ?? null;
    if (changed !== this.changedAt) { this.changedAt = changed; later(cx, (cx) => this.refresh(cx)); }
    const shownNow = shownHere();
    if (shownNow && this.wasHidden) later(cx, (cx) => this.refresh(cx));
    this.wasHidden = !shownNow;

    return v_flex().id("workflows").track_focus(this.handle).size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(S().body)
      .child(h_flex().h(42).flex_none().pl(14).pr(8).gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(S().title).font_semibold().child("Workflows"))
        .child(iconButton("close", "close", t, () => run("layout.hide", { id: PANEL }))))
      .child(h_flex().flex_none().px(14).py(10).border_b(1).border_color(t.border)
        .child(h_flex().id("new-workflow").h(30).px(12).gap(6).items_center().rounded(6).cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground).text_size(S().secondary).font_semibold()
          .hover((s) => s.opacity(0.88)).on_mouse_down("left", stop).on_click(() => this.openWorkflow(null))
          .child(icon("plus", 14, t.solid_foreground))
          .child("New workflow")))
      .child(this.renderList(t))
      .child(this.renderRepo(t));
  }

  renderList(t) {
    if (!this.loaded) return v_flex().flex_1().min_h(0).p(16).gap(10).children([0, 1, 2].map((i) => div().h(40).flex_none().rounded(8).bg(t.chrome).opacity(1 - i * 0.2)));
    const rows = [];
    if (this.error) rows.push(div().px(14).py(8).child(note(t, this.error, t.ansi1)));
    if (!this.items.length && !this.error) rows.push(div().px(14).py(12).child(note(t, "No workflows yet. Make one with New workflow.")));
    rows.push(...this.items.map((item) => this.row(t, item)));
    return div().id("workflow-list").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().py(6).children(rows));
  }

  row(t, item) {
    const armed = this.confirming === item.id;
    return h_flex().id(`workflow-${item.id}`).flex_none().mx(8).mb(2).px(8).py(7).gap(8).items_center().rounded(8)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => this.openWorkflow(item))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(S().body).font_medium().text_color(item.error ? t.ansi1 : t.foreground).child(item.name))
        .when(Boolean(item.error), (el) => el.child(div().truncate().text_size(S().label).text_color(t.ansi1).child(item.error))))
      .when(item.global, (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(9).border_1().border_color(t.border)
        .text_size(S().label).text_color(t.muted).child("Global")))
      .when(armed, (el) => el.child(div().flex_none().text_size(S().label).text_color(t.ansi1).child("Delete?")))
      .child(iconButton(`delete-${item.id}`, "trash", t, (_e, cx) => this.trash(item, cx), armed ? t.ansi1 : t.muted));
  }

  // Where the workstation clone is, so a global workflow can be committed from there.
  renderRepo(t) {
    const set = repoDir();
    return v_flex().flex_none().px(14).py(10).gap(6).border_t(1).border_color(t.border)
      .child(div().text_size(S().label).font_semibold().text_color(t.muted).child("Workstation clone"))
      .child(div().id("repo-field").h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.input)
        .on_mouse_down("left", stop).child(Input.new(this.repoInput).h_full().w_full().text_size(S().secondary).text_color(t.foreground)))
      .child(note(t, this.repoNote?.text ?? (set
        ? "Global workflows are copied to its herdr-app/workflows folder. Enter saves."
        : "Folder of the workstation repo. Global workflows are copied into it so you can commit them. Enter saves."),
      this.repoNote && !this.repoNote.ok ? t.ansi1 : t.muted));
  }
}
