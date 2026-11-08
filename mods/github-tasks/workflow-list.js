// The workflows, listed in the Task settings page: where they are kept (Global, and the selected space's repo
// when it is a local git repo), a New workflow button, and a row for each, which opens in a tab of its own to edit
// (workflow-editor.js). Not a View of its own: main.js builds one for the settings role and settings.js draws it.
// Works with no linked project: it needs only the folder of the selected space, which the sidebar publishes.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, shared, setShared, theme } from "herdr";
import { S, icon, stop, note, iconButton, segmented, later } from "./ui.js";
import { SCOPE_LABELS } from "./workflow-model.js";
import { WORKFLOWS_CHANGED, store, repoRootOf } from "./workflow-env.js";

// The tabs over the list: everything, the selected space's repo, or the global ones.
export const TABS = [["all", "All"], ["repo", "Project"], ["global", "Global"]];
const POLL = 5000; // a listing of a local folder costs nothing; this picks up files that arrive by git pull
const baseName = (path) => String(path ?? "").split("/").filter(Boolean).pop() ?? "";

export class WorkflowList {
  // place: () => { cwd, on } | null, where the selected space is. shown: () => whether the settings are on screen.
  constructor(cx, { place, shown }) {
    this.place = place;
    this.shown = shown;
    this.items = [];
    this.scope = "all";
    this.loaded = false;
    this.error = null;
    this.repoRoot = null; // the repo of the selected space, whose .herdr workflows are listed
    this.placeKey = null;
    this.confirming = null; // the workflow whose trash was pressed once; a second press deletes it
    this.changedAt = shared(WORKFLOWS_CHANGED) ?? null; // a save in an editor tab refreshes the list
    this.lastDrawn = Date.now();
    this.refresh(cx);
    // A hidden page is not drawn, so it cannot notice being shown again: look while it shows.
    cx.timer.every(POLL, (cx) => { if (this.shown()) this.refresh(cx); });
  }

  // Reads the lists again: the repo of the selected space (a space that is not in one, or is on another
  // machine, has no repo workflows), and the workflows in it and in the global folder.
  // One at a time; a request made meanwhile runs once more when it ends.
  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    this.again = false;
    const where = this.place();
    cx.spawn(async (cx) => {
      try {
        this.repoRoot = await repoRootOf(where);
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

  openWorkflow(item) {
    // The scope and the repo go along, so the tab keeps working from where the workflow is even once another space is selected.
    run("tab.new", { name: item?.name ?? "New workflow", mod: "github-tasks",
      props: { role: "workflow-editor", id: item?.id ?? null, scope: item?.scope ?? "global", where: this.place() ?? {}, repoRoot: this.repoRoot } });
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
      setShared(WORKFLOWS_CHANGED, Date.now());
      this.refresh(cx);
    });
  }

  // The section, for the page to put below its other content.
  render(cx) {
    const t = theme(), where = this.place();
    // Another space, or another folder in it, may be in another repo: its workflows come and the last one's go.
    const key = where ? `${where.on ?? ""}|${where.cwd ?? ""}` : "";
    if (key !== this.placeKey) { this.placeKey = key; later(cx, (cx) => this.refresh(cx)); }
    // An editor tab saved something, or the page was just shown after a while hidden: the list may be stale.
    const changed = shared(WORKFLOWS_CHANGED) ?? null;
    if (changed !== this.changedAt) { this.changedAt = changed; later(cx, (cx) => this.refresh(cx)); }
    const now = Date.now(), hidden = now - this.lastDrawn > 2 * POLL;
    this.lastDrawn = now;
    if (hidden && this.loaded) later(cx, (cx) => this.refresh(cx));

    return v_flex().id("workflows").flex_none().gap(10)
      .child(v_flex().gap(2)
        .child(div().text_size(S().title).font_semibold().child("Workflows"))
        .child(note(t, "How work gets done: the labels that start each one, and how its orchestrator, worker and reviewer run.")))
      .child(h_flex().gap(8).items_center().flex_wrap()
        .child(h_flex().id("new-workflow").h(30).px(12).gap(6).items_center().rounded(6).cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground).text_size(S().secondary).font_semibold()
          .hover((s) => s.opacity(0.88)).on_mouse_down("left", stop).on_click(() => this.openWorkflow(null))
          .child(icon("plus", 14, t.solid_foreground))
          .child("New workflow"))
        .child(h_flex().id("built-in-prompts").h(30).px(12).items_center().rounded(6).cursor_pointer()
          .border_1().border_color(t.border).text_color(t.foreground).text_size(S().secondary)
          .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
          .on_click(() => run("tab.new", { name: "Built-in prompts", mod: "github-tasks", props: { role: "prompts" } }))
          .child("Built-in prompts")))
      .child(this.renderList(t, where));
  }

  renderList(t, where) {
    if (!this.loaded) return v_flex().gap(8).children([0, 1, 2].map((i) => div().h(40).flex_none().rounded(8).bg(t.chrome).opacity(1 - i * 0.2)));
    // Without a repo there is only Global, so no tabs.
    const scope = this.repoRoot ? this.scope : "global";
    const count = (k) => (k === "all" ? this.items.length : this.items.filter((i) => i.scope === k).length);
    const shown = scope === "all" ? this.items : this.items.filter((i) => i.scope === scope);
    const folderName = baseName(this.repoRoot || where?.cwd) || "~";
    const header = v_flex().flex_none().gap(8)
      .child(h_flex().gap(8).items_center()
        .child(icon("folder", 14, t.muted))
        .child(div().text_size(S().body).font_semibold().child(this.repoRoot ? folderName : "Global"))
        .child(div().flex_1().min_w(0).truncate().text_size(S().secondary).text_color(t.muted)
          .child(this.repoRoot ? "" : where?.on ? "Project workflows need a space on this computer" : `${folderName} is not in a git repo`)))
      .when(Boolean(this.repoRoot), (el) => el.child(segmented("scope", TABS.map(([k, l]) => [k, `${l} ${count(k)}`]), scope, t, (k, cx) => { this.scope = k; cx.notify(); })));
    const rows = [];
    if (this.error) rows.push(note(t, this.error, t.ansi1));
    if (!shown.length && !this.error) rows.push(note(t, scope === "all" || scope === "global" && !this.items.length ? "No workflows yet. Make one with New workflow." : "No workflows here yet."));
    rows.push(...shown.map((item) => this.row(t, item, scope === "all" && Boolean(this.repoRoot))));
    return v_flex().flex_none().gap(10).child(header).child(v_flex().id("workflow-list").gap(2).children(rows));
  }

  row(t, item, showWhere) {
    const key = `${item.scope}/${item.id}`, armed = this.confirming === key;
    // Where it is kept, when the list mixes both: Global, or the repo's name.
    const where = !showWhere ? null : item.scope === "global" ? SCOPE_LABELS.global : item.scope === "repo" ? baseName(this.repoRoot) || SCOPE_LABELS.repo : null;
    return h_flex().id(`workflow-${item.scope}-${item.id}`).flex_none().px(8).py(7).gap(8).items_center().rounded(8)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => this.openWorkflow(item))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(S().body).font_medium().text_color(item.error ? t.ansi1 : t.foreground).child(item.name))
        .when(Boolean(item.error), (el) => el.child(div().truncate().text_size(S().label).text_color(t.ansi1).child(item.error))))
      .when(Boolean(where), (el) => el.child(div().flex_none().max_w(110).truncate().px(6).h(18).flex().items_center().rounded(9).border_1().border_color(t.border)
        .text_size(S().label).text_color(t.muted).child(where)))
      .when(armed, (el) => el.child(div().flex_none().text_size(S().label).text_color(t.ansi1).child("Delete?")))
      .child(iconButton(`delete-${item.scope}-${item.id}`, "trash", t, (_e, cx) => this.trash(item, cx), false, armed ? "Press again to delete" : "Delete", armed ? t.ansi1 : t.muted));
  }
}
