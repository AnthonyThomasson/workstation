// The workflows, listed in the Task settings page: where they are kept (Global, and the selected space's repo
// when it is a local git repo), a New workflow button, and a row for each, which opens in a tab of its own to edit
// (workflow-editor.js). Not a View of its own: main.js builds one for the settings role and settings.js draws it.
// Works with no linked project: it needs only the folder of the selected space, which the sidebar publishes.
import { div } from "gpui-kit";
import { v_flex, h_flex, Popover } from "gpui-base";
import { run, shared, setShared, theme } from "herdr";
import { openOnce, workflowSubject } from "./open-tabs.js";
import { S, icon, stop, note, iconButton, segmented, later, action, scrim } from "./ui.js";
import { SCOPE_LABELS } from "./workflow-model.js";
import { restorePlan, canRestoreDefaults, workflowRefreshState } from "./store.js";
import { WORKFLOWS_CHANGED, store, repoRootOf, starterWorkflows } from "./workflow-env.js";

// The tabs over the list: everything, the selected space's repo, or the global ones.
export const TABS = [["all", "All"], ["repo", "Project"], ["global", "Global"]];
const POLL = 5000; // a listing of a local folder costs nothing; this picks up files that arrive by git pull
const baseName = (path) => String(path ?? "").split("/").filter(Boolean).pop() ?? "";
const placeKeyOf = (where) => where ? `${where.on ?? ""}|${where.cwd ?? ""}` : "";

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
    this.loadedPlaceKey = null; // the place whose items were loaded, not merely the place currently selected
    this.confirming = null; // the workflow whose trash was pressed once; a second press deletes it
    this.menu = null; // scope/id of the row whose ⋯ menu is open
    this.restoring = null; // { plan, working, error } while the Restore defaults confirmation is open
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
    const where = this.place(), placeKey = placeKeyOf(where);
    cx.spawn(async (cx) => {
      let succeeded = false;
      try {
        const repoRoot = await repoRootOf(where);
        // A refresh that finds another repo invalidates the confirmation, including one already working.
        if (this.restoring && this.restoring.plan.repoRoot !== (repoRoot ?? null)) this.restoring = null;
        this.repoRoot = repoRoot;
        this.items = await store({ repo: this.repoRoot }).list();
        this.error = null;
        succeeded = true;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      const state = workflowRefreshState(this, placeKey, succeeded);
      this.loadedPlaceKey = state.loadedPlaceKey;
      this.loaded = state.loaded;
      this.loading = false;
      cx.notify();
      if (this.again) this.refresh(cx);
    });
  }

  openWorkflow(item, cx) {
    // The scope and the repo go along, so the tab keeps working from where the workflow is even once another space is selected.
    openOnce(workflowSubject(item?.scope ?? "global", item?.id), { name: item?.name ?? "New workflow", mod: "github-tasks",
      props: { role: "workflow-editor", id: item?.id ?? null, scope: item?.scope ?? "global", where: this.place() ?? {}, repoRoot: this.repoRoot } }, cx);
  }

  // A clone or paste that succeeds announces it to every list; a failure stays on screen instead of being
  // cleared by a refresh, and the store has already refused an invalid paste before writing.
  change(cx, operation) {
    cx.spawn(async (cx) => {
      try {
        await operation(store({ repo: this.repoRoot }));
        this.error = null;
        setShared(WORKFLOWS_CHANGED, Date.now());
        this.refresh(cx);
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  clone(item, cx) {
    this.menu = null;
    this.error = null;
    cx.notify();
    this.change(cx, (s) => s.clone(item.scope, item.id));
  }

  copy(item, cx) {
    this.menu = null;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const text = await store({ repo: this.repoRoot }).copyText(item.scope, item.id);
        if (text == null) throw new Error("That workflow is already gone.");
        cx.write_to_clipboard(text); // exact stored YAML; a legacy JSON file is converted to YAML
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  paste(item, cx) {
    const source = cx.read_from_clipboard();
    this.menu = null;
    this.error = source == null ? "The clipboard has no text to paste." : null;
    cx.notify();
    if (source != null) this.change(cx, (s) => s.paste(item.scope, item.id, source));
  }

  openRestore(cx) {
    const placeChanged = placeKeyOf(this.place()) !== this.loadedPlaceKey;
    if (!canRestoreDefaults({ loaded: this.loaded, placeChanged })) return;
    const plan = restorePlan(this.items, this.scope, this.repoRoot);
    // Both the plan and its store belong to the repo whose workflows the dialog names, even if the place changes.
    this.restoring = { plan, store: store({ repo: plan.repoRoot }), working: false, error: null };
    this.menu = null;
    cx.notify();
  }

  closeRestore(cx) {
    if (this.restoring?.working) return;
    this.restoring = null;
    cx.notify();
  }

  restoreDefaults(cx) {
    const current = this.restoring;
    if (!current || current.working) return;
    current.working = true;
    current.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const starters = await starterWorkflows();
        await current.store.restore(current.plan, starters);
        this.restoring = null;
        setShared(WORKFLOWS_CHANGED, Date.now());
        this.refresh(cx);
      } catch (e) {
        current.working = false;
        current.error = String(e?.message ?? e);
        cx.notify();
      }
    });
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
    const key = placeKeyOf(where), placeChanged = key !== this.placeKey;
    const restoreAvailable = canRestoreDefaults({ loaded: this.loaded, placeChanged: key !== this.loadedPlaceKey });
    if (placeChanged) {
      this.placeKey = key;
      this.loaded = false; // the old place's items cannot be restored while this place's refresh is pending
      this.restoring = null; // the dialog names the old place's workflows; never carry it across places
      later(cx, (cx) => this.refresh(cx));
    }
    // An editor tab saved something, or the page was just shown after a while hidden: the list may be stale.
    const changed = shared(WORKFLOWS_CHANGED) ?? null;
    if (changed !== this.changedAt) { this.changedAt = changed; later(cx, (cx) => this.refresh(cx)); }
    const now = Date.now(), hidden = now - this.lastDrawn > 2 * POLL;
    this.lastDrawn = now;
    if (hidden && this.loaded) later(cx, (cx) => this.refresh(cx));

    return v_flex().id("workflows").flex_none().gap(10)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.restoring) { this.closeRestore(cx); cx.stop_propagation(); }
      })
      .child(v_flex().gap(2)
        .child(div().text_size(S().title).font_semibold().child("Workflows"))
        .child(note(t, "How work gets done: the labels that start each one, and how its orchestrator, worker, reviewer and investigator run.")))
      .child(h_flex().gap(8).items_center().flex_wrap()
        .child(h_flex().id("new-workflow").h(30).px(12).gap(6).items_center().rounded(6).cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground).text_size(S().secondary).font_semibold()
          .hover((s) => s.opacity(0.88)).on_mouse_down("left", stop).on_click((_e, cx) => this.openWorkflow(null, cx))
          .child(icon("plus", 14, t.solid_foreground))
          .child("New workflow"))
        .child(h_flex().id("restore-defaults").h(30).px(12).items_center().rounded(6)
          .border_1().border_color(t.border).text_color(t.foreground).text_size(S().secondary)
          .opacity(restoreAvailable ? 1 : 0.5)
          .when(restoreAvailable, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
            .on_click((_e, cx) => this.openRestore(cx)))
          .child("Restore defaults")))
      .child(this.renderList(t, where))
      .when(Boolean(this.restoring), (el) => el.child(this.renderRestore(t)));
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

  // The row's small anchored menu. Popover owns outside-press and Escape dismissal; the list owns which row is open.
  workflowMenu(t, item, key) {
    const option = (name, label, choose) => h_flex().id(`workflow-${name}-${item.scope}-${item.id}`).h(30).px(8).flex_none().items_center().rounded(6)
      .cursor_pointer().text_size(S().body).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop).on_click((_e, cx) => choose(item, cx)).child(label);
    return Popover.new(`workflow-actions-${key}`)
      .open(this.menu === key)
      .on_open_change((open, cx) => { this.menu = open ? key : null; cx.notify(); })
      .anchor("bottom_right")
      .trigger(h_flex().id(`workflow-menu-${item.scope}-${item.id}`).size(24).flex_none().justify_center().items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip("Workflow actions").child(icon("more", 14, t.muted)))
      .content(v_flex().w(140).p(4).gap(2).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .child(option("clone", "Clone", (item, cx) => this.clone(item, cx)))
        .child(option("copy", "Copy", (item, cx) => this.copy(item, cx)))
        .child(option("paste", "Paste", (item, cx) => this.paste(item, cx))));
  }

  // Confirm in the panel, naming every file that will go and where the two shipped starters will be created.
  renderRestore(t) {
    const current = this.restoring, plan = current.plan;
    const destination = plan.createScope === "repo" ? "Project" : "Global";
    const deletion = (item) => h_flex().gap(8).items_center().flex_none()
      .child(div().flex_1().min_w(0).child(item.name))
      .child(div().flex_none().text_size(S().label).text_color(t.muted).child(item.scope === "repo" ? "Project" : "Global"));
    const dialog = v_flex().id("restore-defaults-dialog").w(420).max_h(560).flex_none().p(16).gap(12).rounded(12)
      .border_1().border_color(t.border).bg(t.popover).shadow_lg().text_color(t.foreground).text_size(S().body)
      .on_mouse_down("left", stop)
      .child(h_flex().flex_none().items_center().gap(8)
        .child(div().flex_1().min_w(0).text_size(S().title).font_semibold().child("Restore defaults?"))
        .child(div().text_size(S().label).text_color(t.muted).child("Esc"))
        .when(!current.working, (el) => el.child(iconButton("restore-defaults-close", "close", t, (_e, cx) => this.closeRestore(cx)))))
      .child(note(t, plan.deletions.length ? "These workflows will be deleted:" : "There are no workflows here to delete."))
      .when(Boolean(plan.deletions.length), (el) => el.child(div().id("restore-defaults-deletions").max_h(240).overflow_y_scrollbar()
        .child(v_flex().gap(4).children(plan.deletions.map(deletion)))))
      .child(note(t, `Bug and Story will be re-created in ${destination}.`))
      .when(Boolean(current.error), (el) => el.child(note(t, current.error, t.ansi1)))
      .child(h_flex().flex_none().justify_end().gap(8)
        .child(action("restore-defaults-cancel", "Cancel", t, (_e, cx) => this.closeRestore(cx), true, current.working))
        .child(action("restore-defaults-confirm", current.working ? "Restoring…" : "Restore defaults", t, (_e, cx) => this.restoreDefaults(cx), false, current.working)));
    return div().id("restore-defaults-backdrop").absolute().inset_0().flex().items_center().justify_center().bg(scrim(t))
      .on_mouse_down("left", (_e, cx) => { this.closeRestore(cx); cx.stop_propagation(); })
      .child(dialog);
  }

  row(t, item, showWhere) {
    const key = `${item.scope}/${item.id}`, armed = this.confirming === key;
    // Where it is kept, when the list mixes both: Global, or the repo's name.
    const where = !showWhere ? null : item.scope === "global" ? SCOPE_LABELS.global : item.scope === "repo" ? baseName(this.repoRoot) || SCOPE_LABELS.repo : null;
    return h_flex().id(`workflow-${item.scope}-${item.id}`).flex_none().px(8).py(7).gap(8).items_center().rounded(8)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => this.openWorkflow(item, cx))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(S().body).font_medium().text_color(item.error ? t.ansi1 : t.foreground).child(item.name))
        .when(Boolean(item.error), (el) => el.child(div().truncate().text_size(S().label).text_color(t.ansi1).child(item.error))))
      .when(Boolean(where), (el) => el.child(div().flex_none().max_w(110).truncate().px(6).h(18).flex().items_center().rounded(9).border_1().border_color(t.border)
        .text_size(S().label).text_color(t.muted).child(where)))
      .when(armed, (el) => el.child(div().flex_none().text_size(S().label).text_color(t.ansi1).child("Delete?")))
      .child(this.workflowMenu(t, item, key))
      .child(iconButton(`delete-${item.scope}-${item.id}`, "trash", t, (_e, cx) => this.trash(item, cx), false, armed ? "Press again to delete" : "Delete", armed ? t.ansi1 : t.muted));
  }
}
