// Tasks: the tickets on the GitHub Project linked to the selected space's repo, in the left menu under
// Spaces: Investigations, Up Next, Backlog (collapsed), In Progress and In Review. Up Next and Backlog rows drag to reorder and to move between the two (drop() writes it to the project). Clicking a ticket
// opens it in a large popup to edit (editor/editor.js, lib/popup.js), and saving pushes the change to GitHub. Each row links
// out to GitHub and has Start, which becomes View while its workflow runs.
// Roles (props.role): "sidebar" (default), the list; "settings", the collapsible agent sections and list of
// workflows, in the layout's shared side panel, which the gear opens; "editor", one ticket, in a popup (props.popup)
// opened by a click on a row, or in a tab an older version opened; "workflow-editor", one workflow or refactor type (props.kind) in the center (workflow-ui/workflow-editor.js); "run", a started
// workflow's agents, beside its orchestrator (runs-ui/run-page.js); "investigation", a New Task session's Done button, beside its agent (investigations-ui/investigation-page.js); "new-task", the small dialog the + opens to describe the ticket (investigations-ui/new-task.js); "start", the Start dialog a row's Start opens when several workflows match or none (runs-ui/start-dialog-view.js); "prompt", one read-only agent prompt (prompts-page.js); "agent-bar", the bar over a peeked agent's terminal in its popup (widgets/agent-bar.js); "agent-backdrop", the dim around that popup, a press on which closes it (widgets/agent-backdrop.js).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, spaces, focused, notify, shared, setShared, terminals, playSound, theme, layout, nextCommand, openOverlay, props as blockProps } from "herdr";
import { BACK_AFTER, Shakes, bellFirst, bellTip, bellToast, waitingAgents, INVESTIGATION_LABEL, RUN_LABEL, normalizeItems, groupTickets, groupByStage, projectOrdered, planMove, applyMove, middleEllipsis, normalizeGroomer, GROOMER_KEY, chooseProject, projectKey, CONTEXT, PLACE, editorOverlay, initialOpen, investigationsAlone, sectionPlan, SpaceLists, spaceKey, resetList, forgetRepo, clearTickets, applyPlace, applyRepo, applyProject, failReload, doneReload, CHANGED, AGENT_KEY, DOCTOR_KEY } from "./lib/index.js";
import { GitHubError, MAX_ITEMS, findRepo, findProjects, createProject, loadItems, loadStatusField, moveTicket, setupProject, setupNote } from "./github/index.js";
import { installedAgents, investigationsHere, reconnectInvestigations, viewInvestigation, InvestigationPage, NewTaskPage, RefactorPage } from "./investigations-ui/index.js";
import { S, icon, stop, note, iconButton, action, gh, later, AgentBar, AgentBackdrop } from "./widgets/index.js";
import { Auth, REFRESH, LOGIN } from "./github-ui/index.js";
import { TaskEditor } from "./editor/index.js";
import { readPlace, RunPage, liveRunFor, viewRun, reconnectRuns, StartPage, startChosen } from "./runs-ui/index.js";
import { statusColor, statusLabel, cantStartHere, startOverlay, startProps } from "./runs/index.js";
import { TaskSettings } from "./settings/index.js";
import { matchWorkflows, REFACTOR } from "./workflow/index.js";
import { WorkflowEditor, WorkflowList, loadWorkflows } from "./workflow-ui/index.js";
import { PromptPage } from "./prompts-page.js";
import { investigationRow, refactorOverlay, TOOLTIP as REFACTOR_TIP, newTaskOverlay, newTaskProps, chooseAgent } from "./investigations/index.js";
import { startDoctor, doctorFor } from "./doctor/index.js";

const PANEL = "panel", STACK = "panel-body", SHOWN = "github-tasks";
const POLL = 60000;
const IDLE = "#00000000"; // a drop target's edge when nothing is landing there: transparent, so the sidebar shows through
const REDRAW = 3000; // how often the list is drawn again: a run starting or ending turns a row's Start into View and back
const COLUMN = "sidebar"; // the layout column the list lives in: its width says how much of a name fits
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}
const shownHere = () => {
  const root = layout(), panel = find(root, PANEL), body = find(root, STACK);
  return Boolean(panel && !panel.hidden && body?.active === SHOWN);
};

const activeSpace = () => spaces().find((s) => s.active) ?? null;

// Shows the settings in the layout's shared side panel.
const showSettings = () => { run("layout.select", { stack: STACK, child: SHOWN }); run("layout.show", { id: PANEL }); };

// What a failure says, and the gh command that fixes it when Tasks can run it.
function explain(error, folder) {
  const place = folder.split("/").filter(Boolean).pop() || "This space's folder";
  switch (error.kind) {
    case "no-scope": return { text: "Tasks needs permission to read GitHub Projects.", signIn: REFRESH };
    case "no-write-scope": return { text: "Saving needs permission to edit GitHub Projects.", signIn: REFRESH };
    case "no-auth": return { text: "gh isn't signed in to GitHub yet.", signIn: LOGIN };
    case "not-a-repo": return { text: `${place} isn't a GitHub repo.`, quiet: true };
    default: return { text: `GitHub didn't answer: ${error.message}` };
  }
}

export default class GitHubTasks extends View {
  init(_props, cx) {
    this.role = blockProps()?.role ?? "sidebar";
    if (this.role === "editor") { this.editor = new TaskEditor(blockProps(), cx); return; }
    if (this.role === "workflow-editor") { this.workflowEditor = new WorkflowEditor(blockProps(), cx); return; }
    if (this.role === "run") {
      this.runPage = new RunPage(blockProps());
      this.runPage.refresh(cx);
      cx.timer.every(3000, (cx) => { this.runPage.refresh(cx); cx.notify(); }); // agents starting and ending, and their status
      return;
    }
    if (this.role === "investigation") {
      this.investigationPage = new InvestigationPage(blockProps());
      this.investigationPage.refresh(cx);
      cx.timer.every(3000, (cx) => { this.investigationPage.refresh(cx); cx.notify(); }); // the agent's status and end, and its investigators and workers starting and ending
      return;
    }
    if (this.role === "new-task") { this.newTask = new NewTaskPage(blockProps(), cx); return; }
    if (this.role === "refactor") { this.refactorPage = new RefactorPage(blockProps(), cx); return; }
    if (this.role === "start") { this.startPage = new StartPage(blockProps(), cx); return; }
    if (this.role === "prompt") { this.promptPage = new PromptPage(blockProps()); return; }
    if (this.role === "agent-bar") { this.agentBar = new AgentBar(blockProps(), cx); return; }
    if (this.role === "agent-backdrop") { this.agentBackdrop = new AgentBackdrop(blockProps()); return; }
    if (this.role === "settings") {
      this.settingsKey = null;
      this.page = null;
      this.workflowList = new WorkflowList(cx, { place: () => shared(PLACE) ?? null, shown: shownHere });
      this.refactorList = new WorkflowList(cx, { place: () => shared(PLACE) ?? null, shown: shownHere, kind: REFACTOR });
      return;
    }
    this.handle = cx.focus_handle();
    this.auth = new Auth();
    this.changedAt = shared(CHANGED) ?? null; // a save in an editor refreshes the list
    this.lastCwd = new Map();
    this.lists = new SpaceLists(); // each space's last list, shown at once when the space is selected again
    this.reset(null);
    this.open = initialOpen(); // which sections are expanded
    this.starting = new Set(); // the tickets whose Start is working
    this.writing = 0; // moves still being written to GitHub: the list isn't reloaded until the last one is done
    this.drag = null; // the key of the Up Next / Backlog row being dragged, from its press until a release (a drop, or nothing)
    this.statusField = null; // { projectId, field }: the project's Status field, loaded by the first move between Up Next and Backlog
    this.cx = cx;
    this.shakes = new Shakes(); // which rows have just started needing the person (lib/bell.js)
    this.releasing = new Set(); // the rows whose release frame is waiting on a timer
    this.waiting = new Map(); // row id -> the agents of its run or session that need the person (blocked or in error), as of the last draw
    this.agents = []; // installed agents New Task can use
    installedAgents().then((list) => { this.agents = list; cx.notify(); });
    this.doctor = startDoctor(cx); // checks the setup on its own, apart from the ticket list; the gear shows a dot while it finds problems
    cx.timer.every(POLL, (cx) => this.refresh(cx));
    cx.timer.every(REDRAW, (cx) => cx.notify());
    // A restart drops what terminal.show showed: show each live run's orchestrator again in its tab (twice, in case the app was still loading).
    cx.spawn(async (cx) => { await reconnectRuns(cx); await cx.sleep(5000); await reconnectRuns(cx); });
    // The same for New Task sessions (Investigations), which are shown in tabs like a run's orchestrator.
    cx.spawn(async (cx) => { await reconnectInvestigations(cx); await cx.sleep(5000); await reconnectInvestigations(cx); });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        cx.notify();
      }
    });
  }

  // A new place starts over, and whatever is still loading for the old one is dropped.
  reset(ctx) { resetList(this, ctx); }

  forgetRepo() { forgetRepo(this); }

  clearTickets() { clearTickets(this); }

  // Where the panel looks: the selected space's focused terminal's folder, as Skills does, because
  // a space's own folder can be some other repo or just home. Focus moving to a panel has no folder,
  // so each space's last one is remembered.
  context() {
    const space = activeSpace();
    if (!space) return null;
    const f = focused();
    if (f?.space === space.id && f.cwd) this.lastCwd.set(space.id, f.cwd);
    return { space: space.id, on: space.machine ?? undefined, folder: this.lastCwd.get(space.id) ?? (space.folder || undefined) };
  }

  // quiet: a background look (the 3-second poll), which doesn't spin the Refresh button. fresh: the person pressed Refresh,
  // so the place's repo is looked for again too.
  refresh(cx, { quiet = false, fresh = false } = {}) {
    const ctx = this.ctx;
    if (!ctx || this.writing || (this.loading && !(this.quiet && !quiet))) return; // a load now could read GitHub before a write lands
    if (this.loading) this.token++; // a person's refresh replaces a quiet one still going
    if (fresh) this.placeCache = null;
    this.loading = true;
    this.quiet = quiet;
    const token = this.token, where = { cwd: ctx.folder, on: ctx.on }, current = () => token === this.token;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const place = await readPlace(ctx, this.placeCache);
        if (!current()) return;
        this.applyPlace(place);
        // The folder is asked about once. Another folder in the same repo keeps the list on screen. A list kept from
        // when the space was left asks again: its repo may be another one by now.
        const repo = this.repo && this.repoFolder === ctx.folder && !this.restored ? this.repo : await findRepo(gh, where);
        if (!current()) return;
        if (applyRepo(this, repo)) cx.notify();
        this.repoFolder = ctx.folder;
        const projects = await findProjects(gh, repo, where);
        if (!current()) return;
        this.projects = projects;
        this.project = chooseProject(projects, shared(projectKey(repo)));
        applyProject(this); // a kept list is dropped when the project is another one
        this.publish();
        if (!this.project) { this.clearTickets(); this.loaded = true; this.error = null; return; }
        const { nodes, truncated } = await loadItems(gh, this.project.id, where, current);
        if (!current()) return;
        this.groups = groupTickets(normalizeItems(nodes, repo));
        this.truncated = truncated;
        this.loaded = true;
        this.error = null;
      } catch (e) {
        if (current()) {
          failReload(this); // a kept list is dropped, so only the error shows
          this.error = e instanceof GitHubError ? e : { kind: "other", message: String(e?.message ?? e) };
          if (this.error.kind === "not-a-repo") this.forgetRepo();
          this.publish(); // whatever failed, the settings show what the list knows now, never an earlier space's repo
        }
      } finally {
        if (current()) { doneReload(this); this.loading = false; this.quiet = false; cx.notify(); }
      }
    });
  }

  // The place is known (its main checkout): the settings are told.
  applyPlace(place) {
    applyPlace(this, place);
    this.publish();
  }

  // Tells the settings, which live in the side panel, which repo and project this list is for. Null when there is no repo.
  // The place goes out whether or not there is a repo: the workflows are kept per computer.
  publish() {
    const ctx = this.ctx, project = this.project;
    setShared(PLACE, ctx ? { cwd: ctx.folder, on: ctx.on } : null);
    setShared(CONTEXT, this.repo && ctx ? { repo: this.repo, project: project ? { id: project.id, title: project.title, url: project.url } : null, where: { cwd: ctx.folder, on: ctx.on } } : null);
  }

  pickProject(project, cx) {
    if (project.id === this.project?.id) return;
    setShared(projectKey(this.repo), project.id);
    this.project = project;
    this.publish();
    this.token++;
    this.loading = false;
    this.restored = null; // the person chose: nothing is waiting to be checked
    this.clearTickets();
    this.refresh(cx);
  }

  // Signs gh in with the permission Tasks needs, in the background, then refreshes.
  signIn(cx, args) {
    const ctx = this.ctx;
    if (ctx) this.auth.start(cx, args, ctx.on, (cx) => this.refresh(cx));
  }

  render(cx) {
    if (this.role === "editor") return this.editor.render(cx);
    if (this.role === "workflow-editor") return this.workflowEditor.render(cx);
    if (this.role === "run") return this.runPage.render(cx);
    if (this.role === "investigation") return this.investigationPage.render(cx);
    if (this.role === "new-task") return this.newTask.render(cx);
    if (this.role === "refactor") return this.refactorPage.render(cx);
    if (this.role === "start") return this.startPage.render(cx);
    if (this.role === "prompt") return this.promptPage.render(cx);
    if (this.role === "agent-bar") return this.agentBar.render(cx);
    if (this.role === "agent-backdrop") return this.agentBackdrop.render(cx);
    if (this.role === "settings") return this.renderSettings(cx);
    const t = theme();

    // An editor saved something: the list is stale.
    const changed = shared(CHANGED) ?? null;
    if (changed !== this.changedAt) { this.changedAt = changed; later(cx, (cx) => this.refresh(cx)); }

    // Follow the selected space. Another space starts over. Another folder in the same space keeps the
    // list until its repo is known, because most folder changes stay in one repo.
    const ctx = this.context(), key = spaceKey(ctx);
    const newSpace = key !== this.ctxKey;
    const newFolder = !newSpace && ctx?.folder !== this.ctx?.folder;
    if (newSpace) { // the old space's list is kept, and the new space's, if it has one, shows at once while its reload runs
      this.lists.save(this.ctxKey, this);
      this.ctxKey = key;
      this.reset(ctx);
      this.lists.restore(key, this);
      later(cx, () => this.publish()); // the settings follow: the old space's repo is forgotten, a kept one is shown
    } else if (newFolder) { this.ctx = ctx; this.token++; this.loading = false; later(cx, () => this.publish()); } // the settings follow the folder at once, not after the refresh
    if (ctx && (newSpace || newFolder)) later(cx, (cx) => this.refresh(cx));

    const problems = doctorFor(shared(DOCTOR_KEY), shared(PLACE))?.issues?.length ?? 0; // only an answer for the place shown
    return v_flex().id("github-tasks").track_focus(this.handle).size_full().min_h(0).border_t(1).border_color(t.border)
      .text_color(t.foreground).text_size(S().body)
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx)) // a release on anything that isn't a drop target drops nothing
      .child(h_flex().h(36).flex_none().pl(14).pr(8).gap(2).items_center()
        .child(div().flex_1().text_size(S().label).font_semibold().text_color(t.muted).child("Tasks"))
        .when(Boolean(ctx), (el) => el.child(this.newTaskButton(t)).child(this.refactorButton(t)))
        .child(iconButton("settings", "settings", t, () => showSettings(), false, problems ? `Task settings (${problems} ${problems === 1 ? "problem" : "problems"} found)` : "Task settings", undefined, problems ? t.ansi1 : undefined))
        .when(Boolean(ctx), (el) => el.child(iconButton("refresh", this.loading && !this.quiet ? "ring" : "sync", t, (_e, cx) => this.refresh(cx, { fresh: true }), this.loading && !this.quiet, "Refresh"))))
      .when(this.projects.length > 1, (el) => el.child(this.renderContext(t)))
      .child(this.renderBody(t, ctx));
  }

  // The settings, in the layout's side panel: for the repo and project the sidebar's list is showing.
  renderSettings(cx) {
    const t = theme(), ctx = shared(CONTEXT) ?? null, key = JSON.stringify(ctx); // no repo or project is still a page, with placeholders
    if (key !== this.settingsKey) {
      this.settingsKey = key;
      later(cx, (cx) => { this.page = new TaskSettings(ctx, cx, () => run("layout.hide", { id: PANEL }), this.workflowList, this.refactorList); cx.notify(); });
    }
    if (this.page && key === this.settingsKey) return this.page.render(cx);
    return v_flex().id("task-settings-empty").size_full().p(16).gap(10).bg(t.background).text_size(S().body)
      .child(h_flex().items_center().child(div().flex_1().text_size(S().title).font_semibold().child("Task settings"))
        .child(iconButton("settings-close", "close", t, () => run("layout.hide", { id: PANEL }), false, "Close")));
  }

  // Where the list comes from: the repo, its project, and a choice if several are linked.
  renderContext(t) {
    const project = this.project;
    return v_flex().flex_none().px(14).py(10).gap(4).border_b(1).border_color(t.border)
      .child(div().truncate().text_size(S().body).font_semibold().child(this.repo))
      .when(Boolean(project), (el) => el.child(h_flex().id("project-link").gap(6).items_center().cursor_pointer().text_size(S().secondary).text_color(t.muted)
        .hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click((_e, cx) => cx.open_url(project.url))
        .child(div().min_w(0).truncate().child(project.title))
        .child(icon("external", 12, t.muted))))
      .when(this.projects.length > 1, (el) => el.child(h_flex().flex_wrap().gap(4).pt(4).children(this.projects.map((p) => {
        const on = p.id === project?.id;
        return h_flex().id(`project-${p.id}`).h(24).px(8).max_w_full().items_center().rounded(6).cursor_pointer()
          .border_1().border_color(t.border).bg(on ? t.selected : t.background).text_size(S().label).text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(on ? t.selected : t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => this.pickProject(p, cx))
          .child(div().min_w(0).truncate().child(p.title));
      }))));
  }

  renderBody(t, ctx) {
    const message = (...els) => this.withInvestigations(t, ctx, els);
    if (!ctx) return message(note(t, "Open a space to see its tickets."));
    if (!this.loaded && this.error) return message(this.renderProblem(t, ctx));
    if (!this.loaded) return message(...this.skeleton(t));
    if (!this.project) return message(this.renderNoProject(t, ctx));

    const rows = [];
    if (this.error) rows.push(div().px(14).py(8).child(this.renderProblem(t, ctx)));
    if (this.setupError) rows.push(div().px(14).py(8).child(note(t, this.setupError, t.blocked)));
    if (this.startError) rows.push(div().px(14).py(8).child(note(t, this.startError, t.blocked)));
    if (this.truncated) rows.push(div().px(14).pt(6).child(note(t, `Showing the first ${MAX_ITEMS.toLocaleString()} project items, so some tickets may be missing.`, t.blocked)));
    rows.push(...this.sectionRows(t, groupByStage(this.groups.open)));
    return div().id("tickets").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().pb(12).children(rows));
  }

  // A message in place of the ticket list (a problem, no project, the skeleton) with, under it, the Investigations section when a
  // repo is known (sections.js's investigationsAlone): their rows are the way back to a session, so they stay while the list can't draw.
  withInvestigations(t, ctx, els) {
    const sections = investigationsAlone({
      ctx, remote: Boolean(this.place?.remote), mainRoot: this.place?.mainRoot, repo: this.repo,
      items: ctx ? this.watch({ investigations: this.investigationList() }).investigations : [],
    }, this.open);
    if (!sections.length) return v_flex().flex_1().min_h(0).p(16).gap(10).children(els);
    const rows = [];
    for (const section of sections) {
      rows.push(this.sectionTitle(t, section));
      if (section.open) rows.push(...section.items.map((entry) => this.investigationRowView(t, entry)));
      if (section.empty) rows.push(div().px(14).py(2).child(note(t, section.empty)));
    }
    return div().id("tickets").flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().pb(12).child(v_flex().flex_none().p(16).gap(10).children(els)).children(rows));
  }

  skeleton(t) { return [0, 1, 2, 3, 4].map((i) => div().h(44).flex_none().rounded(8).bg(t.chrome).opacity(1 - i * 0.15)); }

  // The sections, top to bottom, each with its tickets (and, under Investigations, the repo's New Task sessions, which aren't
  // tickets): stages is groupByStage's answer. What shows is sections.js's plan.
  sectionRows(t, { inProgress, inReview, groomed, backlog }) {
    const colors = { next: t.ansi2, backlog: t.ansi4, progress: t.ansi3, review: t.ansi5 };
    const rows = [];
    const lists = this.watch({ next: groomed, investigations: this.investigationList(), backlog, progress: inProgress, review: inReview });
    for (const section of sectionPlan(lists, this.open)) {
      rows.push(this.sectionTitle(t, section));
      if (!section.open) continue;
      if (section.id === "investigations") rows.push(...section.items.map((entry) => this.investigationRowView(t, entry)));
      else rows.push(...section.items.map((ticket) => this.row(t, ticket, ticket.draft ? t.muted : colors[section.id], section.id)));
      if (projectOrdered(section.id)) rows.push(this.endZone(t, section.id));
      if (section.empty) rows.push(div().px(14).py(2).child(note(t, section.empty)));
    }
    return rows;
  }

  // The id of a row of the sidebar: a ticket's (its key is its GitHub node id, so it is the same in no two repos) or an investigation's.
  rowId(section, item) { return section === "investigations" ? `investigation-${item.id}` : `ticket-${item.key}`; }

  // The bell (lib/bell.js): looks at every row of these lists ({ section id: items }) and notes the agents of its run (a ticket's, found
  // by its live orchestrator) or session (an investigation's) that are blocked or in error, into this.waiting. The shakes are told, so a
  // row that has just started needing the person shakes once. Answers the lists with the rows that need the person first.
  watch(lists) {
    const all = terminals(), waiting = new Map(), titles = new Map();
    for (const [section, items] of Object.entries(lists)) {
      for (const item of items) {
        const id = section === "investigations" ? item.id : liveRunFor(this.repo, item)?.labels?.[RUN_LABEL];
        const key = this.rowId(section, item);
        waiting.set(key, waitingAgents(all, section === "investigations" ? INVESTIGATION_LABEL : RUN_LABEL, id));
        titles.set(key, section === "investigations" ? investigationRow(item).text : item.number ? `#${item.number}` : item.title);
      }
    }
    this.waiting = waiting; // only the rows listed now
    // A row that has just started needing the person gets a toast and the attention sound, once (the same moment it shakes).
    for (const key of this.shakes.observe(new Map([...waiting].map(([k, agents]) => [k, agents.length > 0])), Date.now())) {
      const toast = bellToast(titles.get(key), waiting.get(key));
      if (!toast) continue;
      const { sound, ...toastNote } = toast;
      later(this.cx, () => { try { notify(toastNote); playSound(sound); } catch { /* a toast that can't be shown must not break the list */ } });
    }
    // Up Next and Backlog keep the project's order (a dragged row stays where it was dropped): their bell shows on the row, but doesn't move it.
    return Object.fromEntries(Object.entries(lists).map(([section, items]) => [section, projectOrdered(section) ? items : bellFirst(items, (item) => waiting.get(this.rowId(section, item)).length > 0)]));
  }

  // What a row that needs the person gets: the bell in place of its dot, which opens the row's page (`open(cx)`: a ticket's run page or an
  // investigation's page, where the waiting agent is; so does a click anywhere on the row), and
  // for a moment after it started needing them a shake. The row is pushed aside, and `BACK_AFTER` (140ms) later let go with a spring that
  // overshoots, so it swings back and forth and settles: native (spring), with no timer drawing it; the one timer here only draws the
  // frame where it is let go.
  bellFor(t, id, open) {
    const agents = this.waiting.get(id) ?? [];
    if (!agents.length) return null;
    const now = Date.now(), phase = this.shakes.phase(id, now), release = this.shakes.releaseIn(id, now);
    if (release !== null && !this.releasing.has(id)) { // each row that is pushed out gets its own frame where it is let go
      this.releasing.add(id);
      this.cx.timer.after(release + 30, () => { this.releasing.delete(id); this.cx.notify(); });
    }
    const color = agents[0].status === "error" ? t.ansi1 : t.blocked;
    // The bell takes the place of the row's dot and rings (rocks from side to side) for as long as someone waits. GPUI can't rotate an
    // element, so it is two copies of the bell tilted each way (icons/bell-left.svg, bell-right.svg, swung about the top), stacked, with
    // native opacity loops in opposite phase: one fades in as the other fades out, and ease-in-out keeps each crisp at its end.
    const swing = (side, from, to) => icon(`bell-${side}`, 15, color).absolute().top(0).left(0).loop("opacity", { from, to, period: 360 });
    const glyph = div().relative().size(15).child(swing("left", 1, 0)).child(swing("right", 0, 1));
    return {
      open, tip: bellTip(agents), // the whole row's click and tooltip do the same while the bell shows
      shake: (el) => el.relative().left(phase === "out" ? 10 : 0).spring("left", { response: 260, damping: 0.22 }),
      lead: h_flex().id(`bell-${id}`).w(16).h(20).flex_none().justify_center().items_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(bellTip(agents)).on_mouse_down("left", stop).on_click((_e, cx) => open(cx)).child(glyph),
    };
  }

  // The New Task sessions of the repo shown: started from its main checkout (the place's) or for its GitHub name, from
  // any space. Read from shared state and the terminals on every draw, so the 3-second poll's redraw makes them come and go.
  investigationList() {
    return investigationsHere({ repoRoot: this.place?.remote ? null : this.place?.mainRoot ?? null, repo: this.repo });
  }

  // One session on one line: a dot in its agent's status colour (grey once it has ended; the wiggling bell while one needs the person) and its first line, cut to fit. A click
  // switches to its space and tab (viewInvestigation), reopening them if they were closed.
  investigationRowView(t, entry) {
    const view = investigationRow(entry);
    const open = (cx) => cx.spawn(async (cx) => { await viewInvestigation(entry, cx); });
    const color = statusColor(view.status, t), bell = this.bellFor(t, `investigation-${entry.id}`, open);
    return h_flex().id(`investigation-${entry.id}`).flex_none().mx(8).mb(1).px(6).h(28).gap(8).items_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .tooltip(bell ? `${view.text}\n${bell.tip}` : `${view.text}: ${statusLabel(view.status)}. ${view.tip}`)
      .on_click((_e, cx) => open(cx))
      .when(Boolean(bell), (el) => bell.shake(el).child(bell.lead))
      .when(!bell, (el) => el.child(div().w(8).h(8).flex_none().rounded_full().bg(color)))
      .child(div().flex_1().min_w(0).truncate().text_size(S().body).text_color(view.ended ? t.muted : t.foreground).child(view.text));
  }

  // The repo has no project: say so, and offer to make one linked to it.
  renderNoProject(t, ctx) {
    return v_flex().gap(10)
      .when(Boolean(this.error), (el) => el.child(this.renderProblem(t, ctx)))
      .child(note(t, `No project linked to ${this.repo}.`))
      .child(action("create-project", this.makingProject ? "Creating…" : "Create Project", t, (_e, cx) => this.makeProject(cx), false, this.makingProject));
  }

  renderProblem(t, ctx) {
    const { text, signIn, quiet } = explain(this.error, ctx.folder ?? "");
    return v_flex().flex_none().gap(10)
      .child(h_flex().gap(7).items_start().text_size(S().secondary).text_color(quiet ? t.muted : t.ansi1)
        .when(!quiet, (el) => el.child(icon("alert", 14, t.ansi1)))
        .child(div().flex_1().min_w(0).child(text)))
      .when(Boolean(signIn) && !this.auth.state, (el) => el.child(action("github-sign-in", "Sign in to GitHub", t, (_e, cx) => this.signIn(cx, signIn))))
      .when(Boolean(signIn) && Boolean(this.auth.state), (el) => el.child(this.auth.render(t, (_e, cx) => this.signIn(cx, signIn))));
  }

  // The chosen agent: the saved one if it is installed, else Claude, else the first installed.
  agent() {
    return chooseAgent(this.agents, normalizeGroomer(shared(GROOMER_KEY)).agent ?? shared(AGENT_KEY));
  }

  // The + in the Tasks header: opens the New task dialog (new-task.js), a small overlay that asks what the ticket should be about, then
  // starts a New Task session (an Investigation) with that description. Nothing opens without a place to start from or an agent.
  // The broom beside it (openRefactor) opens the Refactor dialog (refactor.js) from the same place, under the same conditions.
  openNewTask() { this.openStartDialog(false); }
  openRefactor() { this.openStartDialog(true); }
  openStartDialog(refactor) {
    const ctx = this.ctx, project = this.project;
    if (!ctx || (!refactor && !this.agent()) || !project) return;
    const props = newTaskProps({ repo: this.repo, project, where: { cwd: ctx.folder, on: ctx.on } });
    openOverlay(refactor ? refactorOverlay(props) : newTaskOverlay(props));
  }

  // The Create Project button, shown when the repo has no project: makes one linked to the repo, selects
  // it and lists its tickets, then sets it up without an agent (project-setup.js): the six statuses, and the
  // labels the saved workflows trigger on. The project stays linked even if a step fails; the sidebar says which.
  makeProject(cx) {
    const ctx = this.ctx, repo = this.repo;
    if (!ctx || !repo || this.makingProject) return;
    this.makingProject = true;
    this.setupError = null;
    cx.notify();
    const where = { cwd: ctx.folder, on: ctx.on };
    cx.spawn(async (cx) => {
      try {
        const project = await createProject(gh, repo, where);
        this.error = null;
        setShared(projectKey(repo), project.id);
        this.token++;
        this.loading = false;
        const at = this.token;
        this.refresh(cx);
        // The project exists by now, so a failure to set it up is shown apart from the list's errors.
        const { problems, doctorFixes } = await setupProject(gh, { repo, project, loadWorkflows, where });
        if (at === this.token) this.setupError = setupNote(problems, doctorFixes);
      } catch (e) {
        this.error = e instanceof GitHubError ? e : { kind: "other", message: String(e?.message ?? e) };
      } finally {
        this.makingProject = false;
        cx.notify();
      }
    });
  }

  // The + in the Tasks header (left of the settings gear, shown while a space is open): opens the New task dialog.
  newTaskButton(t) {
    const agent = this.agent();
    return iconButton("new-task", "plus", t, () => this.openNewTask(), false, agent ? "Start a new task with an agent" : "No agent is installed to help with a task");
  }

  // The broom in the Tasks header (right of the +, shown while a space is open): opens the Refactor dialog.
  refactorButton(t) {
    return iconButton("refactor", "broom", t, () => this.openRefactor(), false, REFACTOR_TIP); // no New Task agent needed: the refactor type names its own
  }

  // A section's header: pressing it expands or collapses the tickets under it.
  sectionTitle(t, { id, title, open }) {
    const target = projectOrdered(id); // Up Next and Backlog take a drop on their header: first in the section, collapsed or not
    return h_flex().id(`section-${id}`).flex_none().min_h(26).mx(8).px(6).pt(6).pb(2).gap(4).items_center().cursor_pointer()
      .text_size(S().label).font_semibold().text_color(t.muted)
      .hover((s) => (target && this.drag ? s.bg(t.selected).text_color(t.foreground) : s.text_color(t.foreground)))
      .on_mouse_down("left", stop).on_click((_e, cx) => { this.open[id] = !this.open[id]; cx.notify(); })
      .when(target, (el) => el.on_mouse_up("left", (_e, cx) => this.drop({ kind: "header", section: id }, cx)))
      .child(icon(open ? "chevron-down" : "chevron-right", 12, t.muted))
      .child(div().flex_1().child(title));
  }

  // A click opens the ticket in a large popup over the app to edit (editor/editor.js, lib/popup.js). Its folder and machine go
  // along, so the editor asks GitHub from the same place the panel does.
  openTicket(ticket) {
    const ctx = this.ctx, project = this.project;
    if (!ctx || !project) return;
    openOverlay(editorOverlay({
      role: "editor", ticket, repo: this.repo, project: { id: project.id, title: project.title }, where: { cwd: ctx.folder, on: ctx.on },
    }));
  }

  // Start: the one workflow the ticket's labels trigger starts at once. With several, or none, the Start dialog opens as an
  // overlay of its own (start-dialog-view.js), listing them or saying why there is nothing to start, with the unreadable workflow
  // files. If the workflows can't be loaded, the reason shows here in the sidebar and no dialog opens.
  startTicket(ticket, cx) {
    const ctx = this.ctx, project = this.project, repo = this.repo;
    if (!ctx || !project || this.starting.has(ticket.key)) return;
    this.starting.add(ticket.key);
    this.startError = null;
    cx.notify();
    const where = { cwd: ctx.folder, on: ctx.on };
    cx.spawn(async (cx) => {
      try {
        const { items, errors } = await loadWorkflows(where);
        const matches = matchWorkflows(items, ticket.labels ?? []);
        if (matches.length === 1) {
          await startChosen(matches[0], ticket, { repo, project, where }, cx);
        } else {
          const cant = cantStartHere(where);
          if (cant) throw new Error(cant);
          openOverlay(startOverlay(startProps({ ticket, repo, project, where, matches, skipped: errors })));
        }
      } catch (e) {
        this.startError = String(e?.message ?? e);
      } finally {
        this.starting.delete(ticket.key);
        cx.notify();
      }
    });
  }

  // The thin drop zone under the last row of Up Next and of an expanded Backlog: last in the section. It is always in the layout at its
  // fixed height (a press must not move any row), and only while dragging does its top edge show the accent line when hovered.
  endZone(t, section) {
    return div().id(`end-${section}`).flex_none().mx(8).h(8).border_t(2).border_color(IDLE).hover((s) => (this.drag !== null ? s.border_color(t.accent) : s))
      .on_mouse_up("left", (_e, cx) => this.drop({ kind: "end", section }, cx));
  }

  endDrag(cx) {
    if (this.drag === null) return;
    this.drag = null;
    cx.notify();
  }

  // A release over a drop target (lib/reorder.js's targets) ends the drag. On the row that was pressed it is only a click (its on_click
  // opens the editor); anywhere that means nothing, nothing happens. Otherwise the row moves at once, and GitHub is told: the Status
  // first when the section changes, then the position. If that fails the error shows as a failed Start's does and the list is reloaded,
  // so the ticket goes back to where GitHub has it.
  drop(target, cx) {
    const key = this.drag, ctx = this.ctx, project = this.project;
    this.drag = null;
    cx.notify();
    if (key === null || (target.kind === "row" && target.key === key) || !ctx || !project) return;
    const plan = planMove(this.groups.open, key, target, this.statusField?.projectId === project.id ? this.statusField.field?.options : undefined);
    if (!plan) return;
    this.groups = { ...this.groups, open: applyMove(this.groups.open, key, plan.afterId, plan.status) };
    this.token++; // a load already running would draw the order from before the move
    this.loading = false;
    this.startError = null;
    this.writing++;
    const where = { cwd: ctx.folder, on: ctx.on };
    cx.spawn(async (cx) => {
      try {
        let field = this.statusField?.projectId === project.id ? this.statusField.field : null;
        if (plan.status && this.statusField?.projectId !== project.id) {
          field = await loadStatusField(gh, project.id, where);
          this.statusField = { projectId: project.id, field };
        }
        await moveTicket(gh, { projectId: project.id, itemId: key, afterId: plan.afterId, status: plan.status, statusField: plan.status ? field : null }, where);
      } catch (e) {
        this.startError = String(e?.message ?? e);
      } finally {
        // The last write done: whatever load was running may have read GitHub before it landed, so it is dropped and the list reloads.
        if (--this.writing === 0) { this.token++; this.loading = false; this.refresh(cx, { quiet: true }); }
        cx.notify();
      }
    });
  }

  // One ticket on one line: a dot for its stage (the wiggling bell instead while an agent of its run needs the person), its name with the middle cut out to fit, a link to GitHub, and
  // Start (View while its workflow runs).
  row(t, ticket, color, section) {
    const running = liveRunFor(this.repo, ticket), busy = this.starting.has(ticket.key);
    const view = (cx) => cx.spawn(async (cx) => { await viewRun(running, cx, { ticket, repo: this.repo, project: this.project }); });
    const bell = running ? this.bellFor(t, this.rowId("ticket", ticket), view) : null; // a ticket only waits through its live run
    const width = find(layout(), COLUMN)?.size?.px ?? 268;
    const num = ticket.number ? `#${ticket.number}` : null; // drafts have no number
    const numPx = num ? num.length * S().body * 0.55 + 6 : 0;
    const room = width - 16 - 12 - (bell ? 16 : 8) - 16 - (ticket.url ? 28 : 0) - 28 - numPx; // what the name has left, in px (the bell, when shown, is in the dot's place)
    const max = Math.max(12, Math.floor(room / (S().body * 0.55)));
    const draggable = projectOrdered(section), landing = this.drag !== null && draggable && this.drag !== ticket.key; // not the dragged row itself
    return h_flex().id(`ticket-${ticket.key}`).flex_none().mx(8).mb(1).px(6).h(28).gap(8).items_center().rounded(6)
      .cursor_pointer().hover((s) => (landing ? s.bg(t.hover).border_color(t.accent) : s.bg(t.hover)))
      .on_click((_e, cx) => (bell ? bell.open(cx) : this.openTicket(ticket, cx)))
      .tooltip(bell ? `${ticket.title}\n${bell.tip}` : ticket.title)
      // A press on an Up Next / Backlog row starts a drag; releasing on the same row is still a click (opens the editor), on another
      // Up Next / Backlog row drops above it. While dragging the row under the pointer shows its landing edge (an accent line on top).
      .on_mouse_down("left", draggable ? (_e, cx) => { cx.stop_propagation(); this.drag = ticket.key; cx.notify(); } : stop)
      .when(draggable, (el) => el.on_mouse_up("left", (_e, cx) => this.drop({ kind: "row", key: ticket.key }, cx)))
      .when(draggable, (el) => el.border_t(2).border_color(IDLE)) // always there, so a press never moves a row
      .when(this.drag === ticket.key, (el) => el.opacity(0.4))
      .when(Boolean(bell), (el) => bell.shake(el).child(bell.lead))
      .when(!bell, (el) => el.child(div().w(8).h(8).flex_none().rounded_full().when(ticket.draft, (el) => el.border(1.5).border_color(color)).when(!ticket.draft, (el) => el.bg(color))))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .when(Boolean(num), (el) => el.child(div().flex_none().text_size(S().body).text_color(t.muted).child(num)))
        .child(div().flex_1().min_w(0).truncate().text_size(S().body).child(middleEllipsis(ticket.title, max))))
      .when(Boolean(ticket.url), (el) => el.child(iconButton(`open-${ticket.key}`, "external", t, (_e, cx) => cx.open_url(ticket.url), false, "Open on GitHub")))
      .when(Boolean(running), (el) => el.child(iconButton(`view-${ticket.key}`, "eye", t, (_e, cx) => view(cx), false, "View the running agent")))
      .when(!running, (el) => el.child(iconButton(`start-${ticket.key}`, busy ? "ring" : "play", t, (_e, cx) => this.startTicket(ticket, cx), busy, "Start")));
  }
}
