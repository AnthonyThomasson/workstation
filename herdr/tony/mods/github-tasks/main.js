// Tasks: the tickets on the GitHub Project linked to the selected space's repo. Only open tickets
// show, newest first. Clicking one opens it in a tab of its
// own to edit (editor.js), and saving pushes the change to GitHub.
// Roles (props.role): the panel (default); "toggle", the tab-bar button that opens or closes the
// layout's shared side panel on this panel, as Files, Changes and Skills do; "editor", one ticket
// in the center, opened by a click on a row; "settings", the statuses and grooming prompt, in a tab.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, spaces, focused, shared, setShared, theme, layout, nextCommand, props as blockProps } from "herdr";
import { normalizeItems, groupTickets, groupByStage, normalizeSettings, normalizeGroomer, sameStatus, statusesKey, GROOMER_KEY, chooseProject, ticketLine } from "./model.js";
import { GitHubError, MAX_ITEMS, findRepo, findProjects, createProject, loadItems, createDraft, loadStatusField } from "./loader.js";
import { installedAgents, startGrooming, startProjectSetup } from "./groom.js";
import { S, icon, stop, note, iconButton, action, gh } from "./ui.js";
import { Auth, REFRESH, LOGIN } from "./auth.js";
import { TaskEditor, CHANGED } from "./editor.js";
import { TaskSettings } from "./settings.js";

const PANEL = "panel", STACK = "panel-body", SHOWN = "github-tasks";
const POLL = 60000;
const projectKey = (repo) => `github-tasks.project.${repo}`;
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

// Work started from render: cx.notify() throws while a view renders, so it starts after.
const later = (cx, fn) => cx.spawn(async (cx) => { await cx.sleep(0); return fn(cx); });

const activeSpace = () => spaces().find((s) => s.active) ?? null;

function toggle() {
  const t = theme(), on = shownHere();
  return h_flex().size_full().pr(8).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
    .child(h_flex().id("toggle-github-tasks").tooltip("Tasks").h(30).w(34).justify_center().flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => {
        if (on) run("layout.hide", { id: PANEL });
        else { run("layout.select", { stack: STACK, child: SHOWN }); run("layout.show", { id: PANEL }); }
      })
      .child(svg("mods/github-tasks/icons/tasks.svg").size(16)));
}

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
    this.role = blockProps()?.role ?? "panel";
    if (this.role === "toggle") return;
    if (this.role === "editor") { this.editor = new TaskEditor(blockProps(), cx); return; }
    if (this.role === "settings") { this.page = new TaskSettings(blockProps(), cx); return; }
    this.handle = cx.focus_handle();
    this.auth = new Auth();
    this.changedAt = shared(CHANGED) ?? null; // a save in an editor tab refreshes the list
    this.lastCwd = new Map();
    this.reset(null);
    this.backlogOpen = false; // the Backlog section is collapsed until opened
    this.agents = []; // installed agents Start Grooming can use
    this.grooming = false;
    installedAgents().then((list) => { this.agents = list; cx.notify(); });
    this.wasHidden = true;
    // No GitHub calls while hidden; showing the panel again refreshes (see render).
    cx.timer.every(POLL, (cx) => { if (shownHere()) this.refresh(cx); });
    cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "focus") this.handle.focus(); cx.notify(); } });
  }

  // A new place starts over, and whatever is still loading for the old one is dropped.
  reset(ctx) {
    this.ctx = ctx;
    this.token = (this.token ?? 0) + 1;
    this.loading = false;
    this.forgetRepo();
    this.error = null;
    this.setupError = null;
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
        }
      } finally {
        if (current()) { this.loading = false; cx.notify(); }
      }
    });
  }

  pickProject(project, cx) {
    if (project.id === this.project?.id) return;
    setShared(projectKey(this.repo), project.id);
    this.project = project;
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
    if (this.role === "toggle") return toggle();
    if (this.role === "editor") return this.editor.render(cx);
    if (this.role === "settings") return this.page.render(cx);
    const t = theme();

    // An editor tab saved something: the list is stale.
    const changed = shared(CHANGED) ?? null;
    if (changed !== this.changedAt) { this.changedAt = changed; later(cx, (cx) => this.refresh(cx)); }

    // Follow the selected space, and ask GitHub only while the panel shows.
    // Another space starts over. Another folder in the same space keeps the list until its repo is
    // known, because most folder changes stay in one repo.
    const ctx = this.context(), key = ctx ? `${ctx.space}|${ctx.on}` : null;
    const newSpace = key !== this.ctxKey;
    const newFolder = !newSpace && ctx?.folder !== this.ctx?.folder;
    if (newSpace) { this.ctxKey = key; this.reset(ctx); }
    else if (newFolder) { this.ctx = ctx; this.token++; this.loading = false; }
    const shownNow = shownHere();
    if (shownNow && ctx && (newSpace || newFolder || this.wasHidden)) later(cx, (cx) => this.refresh(cx));
    this.wasHidden = !shownNow;

    return v_flex().id("github-tasks").track_focus(this.handle).size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(S().body)
      .child(h_flex().h(42).flex_none().pl(14).pr(8).gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(S().title).font_semibold().child("Tasks"))
        .when(Boolean(this.project), (el) => el.child(iconButton("settings", "settings", t, () => this.openSettings())))
        .when(Boolean(ctx), (el) => el.child(iconButton("refresh", this.loading ? "ring" : "sync", t, (_e, cx) => this.refresh(cx), this.loading)))
        .child(iconButton("close", "close", t, () => run("layout.hide", { id: PANEL }))))
      .when(Boolean(this.repo), (el) => el.child(this.renderContext(t)))
      .when(Boolean(this.project), (el) => el.child(this.renderGroom(t)))
      .child(this.renderBody(t, ctx));
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

    const now = Date.now(), cfg = this.statuses();
    const { inProgress, groomed, backlog } = groupByStage(this.groups.open, cfg);
    const rows = [];
    if (this.error) rows.push(div().px(14).py(8).child(this.renderProblem(t, ctx)));
    if (this.setupError) rows.push(div().px(14).py(8).child(note(t, this.setupError, t.blocked)));
    if (this.truncated) rows.push(div().px(14).pt(10).child(note(t, `Showing the first ${MAX_ITEMS.toLocaleString()} project items, so some tickets may be missing.`, t.blocked)));
    const section = (title, list, color) => {
      rows.push(this.sectionTitle(t, `${title} · ${list.length}`));
      if (list.length) rows.push(...list.map((ticket) => this.row(t, ticket, now, ticket.draft ? t.muted : color)));
      else rows.push(div().px(14).py(4).child(note(t, `Nothing in ${title}.`)));
    };
    if (inProgress.length) section("In Progress", inProgress, t.ansi3);
    section(cfg.groomed, groomed, t.ansi2);
    rows.push(this.backlogTitle(t, cfg.backlog, backlog.length));
    if (this.backlogOpen) {
      if (backlog.length) rows.push(...backlog.map((ticket) => this.row(t, ticket, now, ticket.draft ? t.muted : t.ansi4)));
      else rows.push(div().px(14).py(4).child(note(t, `Nothing in ${cfg.backlog}.`)));
    }
    return div().id("tickets").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().pb(16).children(rows));
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

  statuses() { return normalizeSettings(this.repo ? shared(statusesKey(this.repo)) : null); }

  // The Backlog header: pressing it opens or collapses the tickets under it.
  backlogTitle(t, status, count) {
    const label = sameStatus(status, "To Do") ? "Backlog" : `Backlog (${status})`;
    return h_flex().id("backlog-title").flex_none().min_h(28).mx(8).px(6).pt(10).pb(4).gap(4).items_center().cursor_pointer()
      .text_size(S().label).font_semibold().text_color(t.muted).hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => { this.backlogOpen = !this.backlogOpen; cx.notify(); })
      .child(icon(this.backlogOpen ? "chevron-down" : "chevron-right", 12, t.muted))
      .child(`${label} · ${count}`);
  }

  // Start Grooming and the agent it opens.
  renderGroom(t) {
    const agent = this.agent(), busy = this.grooming;
    return h_flex().flex_none().px(14).py(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(action("start-grooming", busy ? "Starting…" : "Start Grooming", t, (_e, cx) => this.groom(cx), false, busy || !agent))
      .child(action("new-task", this.creating ? "Adding…" : "New Task", t, (_e, cx) => this.newTask(cx), true, this.creating));
  }

  // The chosen agent: the saved one if it is installed, else Claude, else the first installed.
  agent() {
    const saved = normalizeGroomer(shared(GROOMER_KEY)).agent ?? shared(AGENT_KEY);
    return this.agents.find((a) => a.key === saved) ?? this.agents.find((a) => a.key === "claude") ?? this.agents[0] ?? null;
  }

  groom(cx) {
    const ctx = this.ctx, project = this.project, agent = this.agent();
    if (!ctx || !project || !agent || this.grooming) return;
    this.grooming = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // The prompt names the statuses as the project spells them ("Todo", not the default "To Do").
        const where = { cwd: ctx.folder, on: ctx.on }, cfg = this.statuses();
        const options = (await loadStatusField(gh, project.id, where).catch(() => null))?.options ?? [];
        const real = (name) => options.find((o) => sameStatus(o.name, name))?.name ?? name;
        await startGrooming({ agent, repo: this.repo, project, settings: { backlog: real(cfg.backlog), groomed: real(cfg.groomed) }, groomer: normalizeGroomer(shared(GROOMER_KEY)), where });
        this.error = null;
      } catch (e) {
        this.error = { kind: "other", message: String(e?.message ?? e) };
      } finally {
        this.grooming = false;
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

  // Settings open in a tab of their own, as the workflows' do.
  openSettings() {
    const project = this.project, ctx = this.ctx;
    if (!project || !ctx) return;
    run("tab.new", {
      name: "Task settings", mod: "github-tasks",
      props: { role: "settings", repo: this.repo, project: { id: project.id, title: project.title, url: project.url }, where: { cwd: ctx.folder, on: ctx.on } },
    });
  }

  sectionTitle(t, label) {
    return h_flex().flex_none().min_h(28).px(14).pt(10).pb(4).items_center().text_size(S().label).font_semibold().text_color(t.muted).child(label);
  }

  // A click opens the ticket in a tab to edit. Its folder and machine go along, so the editor asks
  // GitHub from the same place the panel does.
  openTicket(ticket) {
    const ctx = this.ctx, project = this.project;
    if (!ctx || !project) return;
    const name = ticket.draft ? ticket.title : `#${ticket.number} ${ticket.title}`;
    run("tab.new", {
      name,
      mod: "github-tasks",
      props: { role: "editor", ticket, repo: this.repo, project: { id: project.id, title: project.title }, where: { cwd: ctx.folder, on: ctx.on } },
    });
  }

  // The + button: adds a draft task to the project, then opens it in the editor to fill in.
  newTask(cx) {
    const ctx = this.ctx, project = this.project;
    if (!ctx || !project || this.creating) return;
    this.creating = true;
    cx.notify();
    const where = { cwd: ctx.folder, on: ctx.on };
    cx.spawn(async (cx) => {
      try {
        const ticket = await createDraft(gh, project.id, "New task", where);
        this.error = null;
        this.openTicket(ticket);
        this.refresh(cx);
      } catch (e) {
        this.error = e instanceof GitHubError ? e : { kind: "other", message: String(e?.message ?? e) };
      } finally {
        this.creating = false;
        cx.notify();
      }
    });
  }

  row(t, ticket, now, color) {
    return h_flex().id(`ticket-${ticket.key}`).flex_none().mx(8).mb(2).px(6).py(6).gap(10).items_start().rounded(8)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => this.openTicket(ticket))
      .child(div().mt(6).w(8).h(8).flex_none().rounded_full().when(ticket.draft, (el) => el.border(1.5).border_color(color)).when(!ticket.draft, (el) => el.bg(color)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(S().body).font_medium().child(ticket.title))
        .child(div().truncate().text_size(S().secondary).text_color(t.muted).child(ticketLine(ticket, now))))
      .when(Boolean(ticket.url), (el) => el.child(iconButton(`open-${ticket.key}`, "external", t, (_e, cx) => cx.open_url(ticket.url))));
  }
}
