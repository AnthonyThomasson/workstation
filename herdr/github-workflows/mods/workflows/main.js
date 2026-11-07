// Workflows: how work gets done. Each one names the GitHub labels that trigger it and how its
// orchestrator, worker and reviewer run (prompt, agent, model, effort), kept as a YAML file. The panel
// lists them by name and starts new ones; a click opens one in a tab of its own to edit (editor.js).
// Two places hold them (model.js SCOPES): global, in ~/.config/herdr-app/workflows; and a repo's .herdr
// folder, committed with that project. A repo's are listed only while a space in that repo is the selected one.
// Roles (props.role): the panel (default); "toggle", the tab-bar button that opens or closes the
// layout's shared side panel on this panel, as Tasks does; "editor", one workflow in the center;
// "settings", the built-in instructions of every role (settings.js);
// "run", a started workflow's agents, beside its orchestrator (run.js).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, spaces, focused, shared, setShared, theme, layout, nextCommand, props as blockProps } from "herdr";
import { S, icon, stop, note, iconButton, action, segmented } from "./ui.js";
import { WorkflowEditor } from "./editor.js";
import { RunPage } from "./run.js";
import { SettingsPage } from "./settings.js";
import { SCOPE_LABELS } from "./model.js";
import { CHANGED, store, repoRootOf } from "./env.js";

const PANEL = "panel", STACK = "panel-body", SHOWN = "workflows";
// The tabs over the list: everything, the selected space's repo, or the global ones.
const TABS = [["all", "All"], ["repo", "Project"], ["global", "Global"]];
const POLL = 5000; // a listing of a local folder costs nothing; this picks up files that arrive by git pull
const baseName = (path) => String(path ?? "").split("/").filter(Boolean).pop() ?? "";
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
    .child(h_flex().id("toggle-workflows").tooltip("Workflows").h(30).w(34).justify_center().flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => {
        if (on) run("layout.hide", { id: PANEL });
        else { run("layout.select", { stack: STACK, child: SHOWN }); run("layout.show", { id: PANEL }); }
      })
      .child(svg("mods/workflows/icons/workflows.svg").size(16)));
}

export default class Workflows extends View {
  init(_props, cx) {
    this.role = blockProps()?.role ?? "panel";
    if (this.role === "toggle") return;
    if (this.role === "editor") { this.editor = new WorkflowEditor(blockProps(), cx); return; }
    if (this.role === "run") { this.page = new RunPage(blockProps()); return; }
    if (this.role === "settings") { this.page = new SettingsPage(); return; }
    this.handle = cx.focus_handle();
    this.items = [];
    this.scope = "all";
    this.loaded = false;
    this.error = null;
    this.lastCwd = new Map(); // each space's last known terminal folder; focus on a panel has none
    this.repoRoot = null; // the repo of the selected space, whose .herdr workflows are listed
    this.ctxKey = null;
    this.confirming = null; // the workflow whose trash was pressed once; a second press deletes it
    this.changedAt = shared(CHANGED) ?? null; // a save in an editor tab refreshes the list
    this.wasHidden = true;
    this.refresh(cx);
    // A hidden panel is not drawn, so it cannot notice being shown again: look while it shows.
    cx.timer.every(POLL, (cx) => { if (shownHere()) this.refresh(cx); });
    cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "focus") this.handle.focus(); cx.notify(); } });
  }

  // Reads the lists again: the repo of the selected space (a space that is not in one, or is on another
  // machine, has no repo workflows), and the workflows in it and in the global folder.
  // One at a time; a request made meanwhile runs once more when it ends.
  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    this.again = false;
    const ctx = this.context();
    cx.spawn(async (cx) => {
      try {
        this.repoRoot = await repoRootOf(ctx);
        this.items = await store({ repo: this.repoRoot }).list();
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loaded = true;
      this.loading = false;
      cx.notify();
      if (this.again) this.refresh(cx);
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
    // The scope and the repo go along, so the tab keeps working from where the workflow is even once another space is selected.
    run("tab.new", { name: item?.name ?? "New workflow", mod: "workflows",
      props: { role: "editor", id: item?.id ?? null, scope: item?.scope ?? "global", where: this.context() ?? {}, repoRoot: this.repoRoot } });
  }

  // First press arms the trash, the second deletes; the arming lapses after a few seconds.
  trash(item, cx) {
    const key = `${item.scope}/${item.id}`;
    if (this.confirming !== key) {
      this.confirming = key;
      cx.timer.after(3000, (cx) => { if (this.confirming === key) { this.confirming = null; cx.notify(); } });
      cx.notify();
      return;
    }
    this.confirming = null;
    cx.spawn(async (cx) => {
      try { await store({ repo: this.repoRoot }).remove(item.scope, item.id); } catch (e) { this.error = String(e?.message ?? e); }
      setShared(CHANGED, Date.now());
      this.refresh(cx);
    });
  }

  render(cx) {
    if (this.role === "toggle") return toggle();
    if (this.role === "editor") return this.editor.render(cx);
    if (this.role === "run" || this.role === "settings") return this.page.render();
    const t = theme();
    // Another space, or another folder in it, may be in another repo: its workflows come and the last one's go.
    const ctx = this.context(), key = ctx ? `${ctx.on ?? ""}|${ctx.cwd ?? ""}` : "";
    if (key !== this.ctxKey) { this.ctxKey = key; later(cx, (cx) => this.refresh(cx)); }

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
        .child(iconButton("settings", "settings", t, () => run("tab.new", { name: "Workflow settings", mod: "workflows", props: { role: "settings" } })))
        .child(iconButton("close", "close", t, () => run("layout.hide", { id: PANEL }))))
      .child(h_flex().flex_none().px(14).py(10).border_b(1).border_color(t.border)
        .child(h_flex().id("new-workflow").h(30).px(12).gap(6).items_center().rounded(6).cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground).text_size(S().secondary).font_semibold()
          .hover((s) => s.opacity(0.88)).on_mouse_down("left", stop).on_click(() => this.openWorkflow(null))
          .child(icon("plus", 14, t.solid_foreground))
          .child("New workflow")))
      .child(this.renderList(t, ctx));
  }

  renderList(t, ctx) {
    if (!this.loaded) return v_flex().flex_1().min_h(0).p(16).gap(10).children([0, 1, 2].map((i) => div().h(40).flex_none().rounded(8).bg(t.chrome).opacity(1 - i * 0.2)));
    // Without a repo there is only Global, so no tabs.
    const scope = this.repoRoot ? this.scope : "global";
    const count = (k) => (k === "all" ? this.items.length : this.items.filter((i) => i.scope === k).length);
    const shown = scope === "all" ? this.items : this.items.filter((i) => i.scope === scope);
    const folderName = baseName(this.repoRoot || ctx?.cwd) || "~";
    const header = v_flex().flex_none().px(14).pt(10).pb(12).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(icon("folder", 14, t.muted))
        .child(div().text_size(S().body).font_semibold().child(this.repoRoot ? folderName : "Global"))
        .child(div().flex_1().min_w(0).truncate().text_size(S().secondary).text_color(t.muted)
          .child(this.repoRoot ? "" : ctx?.on ? "Project workflows need a space on this computer" : `${folderName} is not in a git repo`)))
      .when(Boolean(this.repoRoot), (el) => el.child(segmented("scope", TABS.map(([k, l]) => [k, `${l} ${count(k)}`]), scope, t, (k, cx) => { this.scope = k; cx.notify(); })));
    const rows = [];
    if (this.error) rows.push(div().px(14).py(8).child(note(t, this.error, t.ansi1)));
    if (!shown.length && !this.error) rows.push(div().px(14).py(12).child(note(t, scope === "all" || scope === "global" && !this.items.length ? "No workflows yet. Make one with New workflow." : "No workflows here yet.")));
    rows.push(...shown.map((item) => this.row(t, item, scope === "all" && Boolean(this.repoRoot))));
    return v_flex().flex_1().min_h(0)
      .child(header)
      .child(div().id("workflow-list").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().py(6).children(rows)));
  }

  row(t, item, showWhere) {
    const key = `${item.scope}/${item.id}`, armed = this.confirming === key;
    // Where it is kept, when the list mixes both: Global, or the repo's name.
    const where = !showWhere ? null : item.scope === "global" ? SCOPE_LABELS.global : item.scope === "repo" ? baseName(this.repoRoot) || SCOPE_LABELS.repo : null;
    return h_flex().id(`workflow-${item.scope}-${item.id}`).flex_none().mx(8).mb(2).px(8).py(7).gap(8).items_center().rounded(8)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => this.openWorkflow(item))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(S().body).font_medium().text_color(item.error ? t.ansi1 : t.foreground).child(item.name))
        .when(Boolean(item.error), (el) => el.child(div().truncate().text_size(S().label).text_color(t.ansi1).child(item.error))))
      .when(Boolean(where), (el) => el.child(div().flex_none().max_w(110).truncate().px(6).h(18).flex().items_center().rounded(9).border_1().border_color(t.border)
        .text_size(S().label).text_color(t.muted).child(where)))
      .when(armed, (el) => el.child(div().flex_none().text_size(S().label).text_color(t.ansi1).child("Delete?")))
      .child(iconButton(`delete-${item.scope}-${item.id}`, "trash", t, (_e, cx) => this.trash(item, cx), armed ? t.ansi1 : t.muted));
  }
}
