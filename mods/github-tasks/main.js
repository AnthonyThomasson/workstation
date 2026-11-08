// Tasks: the tickets on the GitHub Project linked to the selected space's repo, in the left menu under
// Spaces: Up Next, Backlog (collapsed), In Progress and In Review. Clicking a ticket
// opens it in a tab of its own to edit (editor.js), and saving pushes the change to GitHub. Each row links
// out to GitHub and has Start, which becomes View while its workflow runs.
// Roles (props.role): "sidebar" (default), the list; "settings", the collapsible agent sections and list of
// workflows, in the layout's shared side panel, which the gear opens; "editor", one ticket in the center, opened
// by a click on a row; "workflow-editor", one workflow in the center (workflow-editor.js); "run", a started
// workflow's agents, beside its orchestrator (run-page.js); "prompt", one read-only agent prompt (prompts-page.js).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, spaces, focused, panes, terminals, notify, openOverlay, shared, setShared, theme, layout, nextCommand, props as blockProps } from "herdr";
import { normalizeItems, groupTickets, groupByStage, middleEllipsis, normalizeGroomer, spelled, STATUSES, GROOMER_KEY, chooseProject, projectKey, CONTEXT, PLACE } from "./model.js";
import { GitHubError, MAX_ITEMS, findRepo, findProjects, createProject, loadItems, loadStatusField } from "./loader.js";
import { installedAgents, startNewTask, startProjectSetup } from "./groom.js";
import { S, icon, stop, note, iconButton, action, gh, later, app } from "./ui.js";
import { Auth, REFRESH, LOGIN } from "./auth.js";
import { TaskEditor, CHANGED } from "./editor.js";
import { TaskSettings } from "./settings.js";
import { matchWorkflows } from "./match.js";
import { WorkflowEditor } from "./workflow-editor.js";
import { openOnce, ticketSubject } from "./open-tabs.js";
import { RunPage } from "./run-page.js";
import { PromptPage } from "./prompts-page.js";
import { CloseConfirm } from "./close-confirm.js";
import { closeFocusedTab } from "./close-tab.js";
import { WorkflowList } from "./workflow-list.js";
import { loadWorkflows } from "./workflow-env.js";
import { startRun, liveRunFor, viewRun } from "./start.js";
import { startDoctor } from "./doctor-env.js";
import { DOCTOR_KEY, doctorFor } from "./doctor.js";

const PANEL = "panel", STACK = "panel-body", SHOWN = "github-tasks";
const POLL = 60000;
const COLUMN = "sidebar"; // the layout column the list lives in: its width says how much of a name fits
const SECTIONS = [ // the list's sections, top to bottom; open: whether each starts expanded
  { id: "next", label: "Up Next", open: true },
  { id: "progress", label: "In Progress", open: true },
  { id: "review", label: "In Review", open: true },
  { id: "backlog", label: "Backlog", open: false },
];
const AGENT_KEY = "github-tasks.groomAgent"; // the agent saved before the settings page held it
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}
const shownHere = () => {
  const root = layout(), panel = find(root, PANEL), body = find(root, STACK);
  return Boolean(panel && !panel.hidden && body?.active === SHOWN);
};

const CLOSE_DEPS = {
  focused, panes, terminals, notify, run: app,
  tabName: (id) => spaces().flatMap((s) => s.tabs ?? []).find((x) => x.id === id)?.name ?? "This task",
  ask: ({ tab, name }) => openOverlay({ mod: "github-tasks", props: { role: "close-confirm", tab, name }, kind: "dialog", modal: true, width: 420 }),
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
    if (this.role === "prompt") { this.promptPage = new PromptPage(blockProps()); return; }
    if (this.role === "close-confirm") { this.closeConfirm = new CloseConfirm(blockProps()); return; }
    if (this.role === "settings") {
      this.settingsKey = null;
      this.page = null;
      this.workflowList = new WorkflowList(cx, { place: () => shared(PLACE) ?? null, shown: shownHere });
      return;
    }
    this.handle = cx.focus_handle();
    this.auth = new Auth();
    this.changedAt = shared(CHANGED) ?? null; // a save in an editor tab refreshes the list
    this.lastCwd = new Map();
    this.reset(null);
    this.open = Object.fromEntries(SECTIONS.map((x) => [x.id, x.open])); // which sections are expanded
    this.starting = new Set(); // the tickets whose Start is working
    this.agents = []; // installed agents New Task can use
    this.startingTask = false;
    installedAgents().then((list) => { this.agents = list; cx.notify(); });
    this.doctor = startDoctor(cx); // checks the setup on its own, apart from the ticket list; the gear shows a dot while it finds problems
    cx.timer.every(POLL, (cx) => this.refresh(cx));
    cx.timer.every(3000, (cx) => cx.notify()); // a run starting or ending turns a row's Start into View and back
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        // keys.json binds the close-tab key to "github-tasks.close_tab"; a tab with a running workflow asks first (close-tab.js).
        else if (command === "close_tab") closeFocusedTab(CLOSE_DEPS);
        cx.notify();
      }
    });
  }

  // A new place starts over, and whatever is still loading for the old one is dropped.
  reset(ctx) {
    this.ctx = ctx;
    this.token = (this.token ?? 0) + 1;
    this.loading = false;
    this.forgetRepo();
    this.error = null;
    this.setupError = null;
    this.startError = null;
  }

  forgetRepo() {
    this.repo = null;
    this.repoFolder = null;
    this.projects = [];
    this.project = null;
    this.clearTickets();
  }

  clearTickets() {
    this.groups = { open: [], closed: [] };
    this.truncated = false;
    this.loaded = false;
  }

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

  refresh(cx) {
    const ctx = this.ctx;
    if (!ctx || this.loading) return;
    this.loading = true;
    const token = this.token, where = { cwd: ctx.folder, on: ctx.on }, current = () => token === this.token;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // The folder is asked about once. Another folder in the same repo keeps the list on screen.
        const repo = this.repo && this.repoFolder === ctx.folder ? this.repo : await findRepo(gh, where);
        if (!current()) return;
        if (repo !== this.repo) { this.forgetRepo(); this.repo = repo; cx.notify(); }
        this.repoFolder = ctx.folder;
        const projects = await findProjects(gh, repo, where);
        if (!current()) return;
        this.projects = projects;
        this.project = chooseProject(projects, shared(projectKey(repo)));
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
          this.error = e instanceof GitHubError ? e : { kind: "other", message: String(e?.message ?? e) };
          if (this.error.kind === "not-a-repo") this.forgetRepo();
          this.publish(); // whatever failed, the settings show what the list knows now, never an earlier space's repo
        }
      } finally {
        if (current()) { this.loading = false; cx.notify(); }
      }
    });
  }

  // Tells the settings, which live in the side panel, which repo and project this list is for. Null when there is no repo.
  // The place goes out whether or not there is a repo: the workflows are kept per computer and per local repo.
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
    if (this.role === "prompt") return this.promptPage.render(cx);
    if (this.role === "close-confirm") return this.closeConfirm.render(cx);
    if (this.role === "settings") return this.renderSettings(cx);
    const t = theme();

    // An editor tab saved something: the list is stale.
    const changed = shared(CHANGED) ?? null;
    if (changed !== this.changedAt) { this.changedAt = changed; later(cx, (cx) => this.refresh(cx)); }

    // Follow the selected space. Another space starts over. Another folder in the same space keeps the
    // list until its repo is known, because most folder changes stay in one repo.
    const ctx = this.context(), key = ctx ? `${ctx.space}|${ctx.on}` : null;
    const newSpace = key !== this.ctxKey;
    const newFolder = !newSpace && ctx?.folder !== this.ctx?.folder;
    if (newSpace) { this.ctxKey = key; this.reset(ctx); later(cx, () => this.publish()); } // the old space's repo is forgotten, so the settings forget it too
    else if (newFolder) { this.ctx = ctx; this.token++; this.loading = false; later(cx, () => this.publish()); } // the settings follow the folder at once, not after the refresh
    if (ctx && (newSpace || newFolder)) later(cx, (cx) => this.refresh(cx));

    const problems = doctorFor(shared(DOCTOR_KEY), shared(PLACE))?.issues?.length ?? 0; // only an answer for the place shown
    return v_flex().id("github-tasks").track_focus(this.handle).size_full().min_h(0).border_t(1).border_color(t.border)
      .text_color(t.foreground).text_size(S().body)
      .child(h_flex().h(36).flex_none().pl(14).pr(8).gap(2).items_center()
        .child(div().flex_1().text_size(S().label).font_semibold().text_color(t.muted).child("Tasks"))
        .child(iconButton("settings", "settings", t, () => showSettings(), false, problems ? `Task settings (${problems} ${problems === 1 ? "problem" : "problems"} found)` : "Task settings", undefined, problems ? t.ansi1 : undefined))
        .when(Boolean(ctx), (el) => el.child(iconButton("refresh", this.loading ? "ring" : "sync", t, (_e, cx) => this.refresh(cx), this.loading, "Refresh"))))
      .when(this.projects.length > 1, (el) => el.child(this.renderContext(t)))
      .child(this.renderBody(t, ctx));
  }

  // The settings, in the layout's side panel: for the repo and project the sidebar's list is showing.
  renderSettings(cx) {
    const t = theme(), ctx = shared(CONTEXT) ?? null, key = JSON.stringify(ctx); // no repo or project is still a page, with placeholders
    if (key !== this.settingsKey) {
      this.settingsKey = key;
      later(cx, (cx) => { this.page = new TaskSettings(ctx, cx, () => run("layout.hide", { id: PANEL }), this.workflowList); cx.notify(); });
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
    const message = (el) => v_flex().flex_1().min_h(0).p(16).gap(10).child(el);
    if (!ctx) return message(note(t, "Open a space to see its tickets."));
    if (!this.loaded && this.error) return v_flex().flex_1().min_h(0).p(16).gap(10).child(this.renderProblem(t, ctx));
    if (!this.loaded) return v_flex().flex_1().min_h(0).p(16).gap(10).children([0, 1, 2, 3, 4].map((i) => div().h(44).flex_none().rounded(8).bg(t.chrome).opacity(1 - i * 0.15)));
    if (!this.project) return message(this.renderNoProject(t, ctx));

    const { inProgress, inReview, groomed, backlog } = groupByStage(this.groups.open);
    const lists = { next: groomed, backlog, progress: inProgress, review: inReview };
    const colors = { next: t.ansi2, backlog: t.ansi4, progress: t.ansi3, review: t.ansi5 };
    const rows = [];
    if (this.error) rows.push(div().px(14).py(8).child(this.renderProblem(t, ctx)));
    if (this.setupError) rows.push(div().px(14).py(8).child(note(t, this.setupError, t.blocked)));
    if (this.startError) rows.push(div().px(14).py(8).child(note(t, this.startError, t.blocked)));
    if (this.truncated) rows.push(div().px(14).pt(6).child(note(t, `Showing the first ${MAX_ITEMS.toLocaleString()} project items, so some tickets may be missing.`, t.blocked)));
    for (const { id, label } of SECTIONS) {
      const list = lists[id], open = this.open[id];
      rows.push(this.sectionTitle(t, id, label, list.length, open));
      if (!open) continue;
      if (list.length) rows.push(...list.map((ticket) => this.row(t, ticket, ticket.draft ? t.muted : colors[id])));
      else rows.push(div().px(14).py(2).child(note(t, `Nothing in ${label}.`)));
    }
    return div().id("tickets").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().pb(12).children(rows));
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
    const saved = normalizeGroomer(shared(GROOMER_KEY)).agent ?? shared(AGENT_KEY);
    return this.agents.find((a) => a.key === saved) ?? this.agents.find((a) => a.key === "claude") ?? this.agents[0] ?? null;
  }

  startTask(cx) {
    const ctx = this.ctx, project = this.project, agent = this.agent();
    if (!ctx || !project || !agent || this.startingTask) return;
    this.startingTask = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // The prompt names the statuses as the project spells them ("Todo", not the fixed "To Do").
        const where = { cwd: ctx.folder, on: ctx.on };
        const options = (await loadStatusField(gh, project.id, where).catch(() => null))?.options ?? [];
        await startNewTask({ agent, repo: this.repo, project, settings: { backlog: spelled(options, STATUSES.backlog), groomed: spelled(options, STATUSES.groomed) }, groomer: normalizeGroomer(shared(GROOMER_KEY)), where });
        this.error = null;
      } catch (e) {
        this.error = { kind: "other", message: String(e?.message ?? e) };
      } finally {
        this.startingTask = false;
        cx.notify();
      }
    });
  }

  // The Create Project button, shown when the repo has no project: makes one linked to the repo, selects
  // it and lists its tickets, then opens the default agent to set it up with the Herdr modules.
  makeProject(cx) {
    const ctx = this.ctx, repo = this.repo, agent = this.agent();
    if (!ctx || !repo || this.makingProject) return;
    this.makingProject = true;
    this.setupError = null;
    cx.notify();
    const where = { cwd: ctx.folder, on: ctx.on }, groomer = normalizeGroomer(shared(GROOMER_KEY));
    cx.spawn(async (cx) => {
      try {
        const project = await createProject(gh, repo, where);
        this.error = null;
        setShared(projectKey(repo), project.id);
        this.token++;
        this.loading = false;
        const at = this.token;
        this.refresh(cx);
        // The project exists by now, so a failure to open the agent is shown apart from the list's errors.
        await startProjectSetup({ agent, repo, project, groomer, where }).catch((e) => {
          if (at === this.token) this.setupError = `The project was made, but its setup didn't open: ${e?.message ?? e}`;
        });
      } catch (e) {
        this.error = e instanceof GitHubError ? e : { kind: "other", message: String(e?.message ?? e) };
      } finally {
        this.makingProject = false;
        cx.notify();
      }
    });
  }

  // The + beside Backlog: starts a session that helps write one new ticket.
  newTaskButton(t) {
    const agent = this.agent();
    return iconButton("new-task", "plus", t, (_e, cx) => this.startTask(cx), false, this.startingTask ? "Starting…" : agent ? "Start a new task with an agent" : "No agent is installed to help with a task");
  }

  // A section's header: pressing it expands or collapses the tickets under it.
  sectionTitle(t, id, label, count, open) {
    return h_flex().id(`section-${id}`).flex_none().min_h(26).mx(8).px(6).pt(6).pb(2).gap(4).items_center().cursor_pointer()
      .text_size(S().label).font_semibold().text_color(t.muted).hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => { this.open[id] = !this.open[id]; cx.notify(); })
      .child(icon(open ? "chevron-down" : "chevron-right", 12, t.muted))
      .child(div().flex_1().child(`${label} · ${count}`))
      .when(id === "backlog", (el) => el.child(this.newTaskButton(t)));
  }

  // A click opens the ticket in a tab to edit. Its folder and machine go along, so the editor asks
  // GitHub from the same place the panel does.
  openTicket(ticket, cx, extra = {}) {
    const ctx = this.ctx, project = this.project;
    if (!ctx || !project) return;
    const name = ticket.draft ? ticket.title : `#${ticket.number} ${ticket.title}`;
    openOnce(extra.autoStart ? null : ticketSubject(this.repo, ticket), {
      name,
      mod: "github-tasks",
      props: { role: "editor", ticket, repo: this.repo, project: { id: project.id, title: project.title }, where: { cwd: ctx.folder, on: ctx.on }, ...extra },
    }, cx);
  }

  // Start: the one workflow the ticket's labels trigger starts at once. With several, or none, the ticket opens in
  // the editor with its Start dialog showing, which lists them or says why there is nothing to start.
  startTicket(ticket, cx) {
    const ctx = this.ctx, project = this.project, repo = this.repo;
    if (!ctx || !project || this.starting.has(ticket.key)) return;
    this.starting.add(ticket.key);
    this.startError = null;
    cx.notify();
    const where = { cwd: ctx.folder, on: ctx.on };
    cx.spawn(async (cx) => {
      try {
        const { items } = await loadWorkflows(where);
        const matches = matchWorkflows(items, ticket.labels ?? []);
        if (matches.length === 1) {
          const statusField = await loadStatusField(gh, project.id, where).catch(() => null); // without it the ticket's status just isn't moved
          await startRun(matches[0], ticket, repo, where, cx, { project, statusField });
        } else {
          this.openTicket(ticket, cx, { autoStart: true });
        }
      } catch (e) {
        this.startError = String(e?.message ?? e);
      } finally {
        this.starting.delete(ticket.key);
        cx.notify();
      }
    });
  }

  // One ticket on one line: a dot for its stage, its name with the middle cut out to fit, a link to GitHub, and
  // Start (View while its workflow runs).
  row(t, ticket, color) {
    const running = liveRunFor(this.repo, ticket), busy = this.starting.has(ticket.key);
    const width = find(layout(), COLUMN)?.size?.px ?? 268;
    const room = width - 16 - 12 - 8 - 16 - (ticket.url ? 28 : 0) - 28; // what the name has left, in px
    const max = Math.max(12, Math.floor(room / (S().body * 0.55)));
    return h_flex().id(`ticket-${ticket.key}`).flex_none().mx(8).mb(1).px(6).h(28).gap(8).items_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => this.openTicket(ticket, cx))
      .child(div().w(8).h(8).flex_none().rounded_full().when(ticket.draft, (el) => el.border(1.5).border_color(color)).when(!ticket.draft, (el) => el.bg(color)))
      .child(div().flex_1().min_w(0).truncate().text_size(S().body).child(middleEllipsis(ticket.title, max)))
      .when(Boolean(ticket.url), (el) => el.child(iconButton(`open-${ticket.key}`, "external", t, (_e, cx) => cx.open_url(ticket.url), false, "Open on GitHub")))
      .when(Boolean(running), (el) => el.child(iconButton(`view-${ticket.key}`, "eye", t, (_e, cx) => viewRun(running, cx, { ticket, repo: this.repo, project: this.project }), false, "View the running agent")))
      .when(!running, (el) => el.child(iconButton(`start-${ticket.key}`, busy ? "ring" : "play", t, (_e, cx) => this.startTicket(ticket, cx), busy, "Start")));
  }
}
