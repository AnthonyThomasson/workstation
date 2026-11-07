// Tasks: the tickets on the GitHub Project linked to the selected space's repo. Open tickets first,
// then a collapsed section per close reason, each newest first. Read only.
// Roles (props.role): the panel (default); "toggle", the tab-bar button that opens or closes the
// layout's shared side panel on this panel, as Files, Changes and Skillshare do.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, run, spaces, focused, shared, setShared, theme, settings, layout, nextCommand, readTextFile, props as blockProps } from "herdr";
import { normalizeItems, groupTickets, chooseProject, ticketLine, signInFrom } from "./model.js";
import { GitHubError, MAX_ITEMS, findRepo, findProjects, loadItems } from "./loader.js";

const PANEL = "panel", STACK = "panel-body", SHOWN = "github-tasks";
const POLL = 60000;
const projectKey = (repo) => `github-tasks.project.${repo}`;
// gh runs detached, so the panel can read its one-time code while it waits for the browser. Its
// output goes to a new folder, which the script prints, and its exit code goes to code when it ends.
const SIGN_IN = 'd=$(mktemp -d) || exit 1; ( GH_PROMPT_DISABLED=1 gh "$@" </dev/null >"$d/out" 2>"$d/err"; echo $? > "$d/code" ) >/dev/null 2>&1 &\necho "$d"';
const SIGN_IN_SECONDS = 900; // GitHub's device codes last about 15 minutes
// The permission Tasks reads Projects with, and the sign-in that grants it when gh isn't signed in yet.
const GRANT = ["-h", "github.com", "-s", "read:project"];
const REFRESH = ["auth", "refresh", ...GRANT];
const LOGIN = ["auth", "login", "-h", "github.com", "-p", "https", "-s", "read:project", "-w"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}
const shownHere = () => {
  const root = layout(), panel = find(root, PANEL), body = find(root, STACK);
  return Boolean(panel && !panel.hidden && body?.active === SHOWN);
};

const gh = (args, where) => exec("gh", args, where)
  .catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) }));

// Work started from render: cx.notify() throws while a view renders, so it starts after.
const later = (cx, fn) => cx.spawn(async (cx) => { await cx.sleep(0); return fn(cx); });

const activeSpace = () => spaces().find((s) => s.active) ?? null;

function S() {
  const b = Number(settings().ui_font_size) || 13;
  return { title: b + 1, body: b + 0.5, secondary: b - 0.5, label: b - 1 };
}

const icon = (name, size, color) => svg(`mods/github-tasks/icons/${name}.svg`).size(size).flex_none().text_color(color);
const stop = (_e, cx) => cx.stop_propagation();
const note = (t, text, color) => div().flex_none().text_size(S().secondary).text_color(color ?? t.muted).child(text);

function iconButton(id, name, t, onClick, spin) {
  const glyph = icon(name, 14, t.muted);
  return h_flex().id(id).size(24).flex_none().justify_center().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
    .on_mouse_down("left", stop).on_click(onClick).child(spin ? glyph.spin(900) : glyph);
}

function toggle() {
  const t = theme(), on = shownHere();
  return h_flex().size_full().pr(8).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
    .child(h_flex().id("toggle-github-tasks").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => {
        if (on) run("layout.hide", { id: PANEL });
        else { run("layout.select", { stack: STACK, child: SHOWN }); run("layout.show", { id: PANEL }); }
      })
      .child(svg("mods/github-tasks/icons/tasks.svg").size(14))
      .child("Tasks"));
}

// A solid button, or a quiet outline one.
function action(id, label, t, onClick, quiet = false) {
  return h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(6).cursor_pointer().text_size(S().secondary)
    .when(!quiet, (el) => el.bg(t.solid).text_color(t.solid_foreground).font_semibold())
    .when(quiet, (el) => el.border_1().border_color(t.border).text_color(t.foreground))
    .hover((s) => s.opacity(0.88)).on_mouse_down("left", stop).on_click(onClick).child(label);
}

// What a failure says, and the gh command that fixes it when Tasks can run it.
function explain(error, folder) {
  const place = folder.split("/").filter(Boolean).pop() || "This space's folder";
  switch (error.kind) {
    case "no-scope": return { text: "Tasks needs permission to read GitHub Projects.", signIn: REFRESH };
    case "no-auth": return { text: "gh isn't signed in to GitHub yet.", signIn: LOGIN };
    case "not-a-repo": return { text: `${place} isn't a GitHub repo.`, quiet: true };
    default: return { text: `GitHub didn't answer: ${error.message}` };
  }
}

export default class GitHubTasks extends View {
  init(_props, cx) {
    this.role = blockProps()?.role ?? "panel";
    if (this.role === "toggle") return;
    this.handle = cx.focus_handle();
    this.expanded = new Set(); // closed sections opened this session
    this.auth = null; // a sign-in in progress, or the last one's failure
    this.lastCwd = new Map();
    this.reset(null);
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

  // Where the panel looks: the selected space's focused terminal's folder, as Skillshare does, because
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

  // Signs gh in with the permission Tasks reads Projects with, in the background, then refreshes.
  signIn(cx, args) {
    const ctx = this.ctx;
    if (!ctx || this.auth?.phase === "starting" || this.auth?.dir) return;
    const on = ctx.on, pending = { phase: "starting", code: null, url: null, dir: null };
    this.auth = pending;
    cx.notify();
    cx.spawn(async (cx) => {
      const started = await exec("sh", ["-c", SIGN_IN, "github-tasks-sign-in", ...args], { on })
        .catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
      const dir = started.stdout.trim();
      if (this.auth !== pending) return;
      if (started.code !== 0 || !dir) { this.auth = { phase: "failed", message: started.stderr.trim().split("\n")[0] || "Could not start gh." }; return cx.notify(); }
      this.auth = { ...pending, phase: "waiting", dir };
      cx.notify();
      const mine = () => this.auth?.dir === dir;
      for (let i = 0; i < SIGN_IN_SECONDS; i++) {
        await cx.sleep(1000);
        if (!mine()) return;
        const err = (await readTextFile(`${dir}/err`, { on }).catch(() => null)) ?? "";
        const done = ((await readTextFile(`${dir}/code`, { on }).catch(() => null)) ?? "").trim();
        const { code, url } = signInFrom(err);
        if (code !== this.auth.code || url !== this.auth.url) { this.auth = { ...this.auth, code, url }; cx.notify(); }
        if (!done) continue;
        exec("sh", ["-c", 'rm -rf "$1"', "github-tasks-sign-in", dir], { on }).catch(() => {});
        if (done === "0") {
          this.auth = null;
          this.refresh(cx);
        } else {
          const lines = err.trim().split("\n").filter(Boolean);
          this.auth = { phase: "failed", message: lines[lines.length - 1] ?? "Sign-in didn't finish." };
        }
        return cx.notify();
      }
      if (mine()) { this.auth = { phase: "failed", message: "Sign-in timed out. Try again." }; cx.notify(); }
    });
  }

  render(cx) {
    if (this.role === "toggle") return toggle();
    const t = theme();

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
        .when(Boolean(ctx), (el) => el.child(iconButton("refresh", this.loading ? "ring" : "sync", t, (_e, cx) => this.refresh(cx), this.loading)))
        .child(iconButton("close", "close", t, () => run("layout.hide", { id: PANEL }))))
      .when(Boolean(this.repo), (el) => el.child(this.renderContext(t)))
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
    if (!this.project) return message(note(t, `No project linked to ${this.repo}.`));

    const { open, closed } = this.groups, now = Date.now();
    const rows = [];
    if (this.error) rows.push(div().px(14).py(8).child(this.renderProblem(t, ctx)));
    if (this.truncated) rows.push(div().px(14).pt(10).child(note(t, `Showing the first ${MAX_ITEMS.toLocaleString()} project items, so some tickets may be missing.`, t.blocked)));
    rows.push(this.sectionTitle(t, `Open · ${open.length}`));
    if (open.length) rows.push(...open.map((ticket) => this.row(t, ticket, now, ticket.draft ? t.muted : t.ansi2)));
    else rows.push(div().px(14).py(4).child(note(t, closed.length ? "No open tickets." : `No tickets for ${this.repo} on this project.`)));
    if (closed.length) rows.push(div().flex_none().h(1).mx(14).mt(10).mb(4).bg(t.border));
    for (const section of closed) {
      const isOpen = this.expanded.has(section.key);
      rows.push(this.closedHeader(t, section, isOpen));
      if (isOpen) rows.push(...section.tickets.map((ticket) => this.row(t, ticket, now, section.key === "COMPLETED" ? t.ansi5 : t.muted)));
    }
    return div().id("tickets").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().pb(16).children(rows));
  }

  renderProblem(t, ctx) {
    const { text, signIn, quiet } = explain(this.error, ctx.folder ?? "");
    return v_flex().flex_none().gap(10)
      .child(h_flex().gap(7).items_start().text_size(S().secondary).text_color(quiet ? t.muted : t.ansi1)
        .when(!quiet, (el) => el.child(icon("alert", 14, t.ansi1)))
        .child(div().flex_1().min_w(0).child(text)))
      .when(Boolean(signIn) && !this.auth, (el) => el.child(action("github-sign-in", "Sign in to GitHub", t, (_e, cx) => this.signIn(cx, signIn))))
      .when(Boolean(signIn) && Boolean(this.auth), (el) => el.child(this.renderSignIn(t, signIn)));
  }

  // The sign-in in progress: gh's code to enter on GitHub, or what went wrong.
  renderSignIn(t, args) {
    const a = this.auth;
    if (a.phase === "failed") return v_flex().gap(8)
      .child(div().text_size(S().secondary).text_color(t.ansi1).child(a.message))
      .child(action("github-sign-in-retry", "Try again", t, (_e, cx) => this.signIn(cx, args)));
    if (!a.code) return note(t, "Starting sign-in with GitHub…");
    return v_flex().gap(8)
      .child(note(t, "Enter this code on GitHub, then approve gh:"))
      .child(div().id("github-sign-in-code").px(10).py(8).rounded(6).border_1().border_color(t.border).bg(t.chrome)
        .font_family(settings().font_family || "Menlo").text_size(S().body).font_semibold().text_color(t.foreground).child(a.code))
      .child(h_flex().gap(6)
        .child(action("github-sign-in-open", "Open GitHub", t, (_e, cx) => cx.open_url(a.url ?? "https://github.com/login/device")))
        .child(action("github-sign-in-copy", "Copy code", t, (_e, cx) => cx.write_to_clipboard(a.code), true)))
      .child(note(t, "Waiting for you to approve in the browser…"));
  }

  sectionTitle(t, label) {
    return h_flex().flex_none().min_h(28).px(14).pt(10).pb(4).items_center().text_size(S().label).font_semibold().text_color(t.muted).child(label);
  }

  closedHeader(t, section, isOpen) {
    return h_flex().id(`section-${section.key}`).flex_none().h(30).mx(8).px(6).gap(6).items_center().rounded(6).cursor_pointer()
      .text_size(S().label).font_semibold().text_color(t.muted).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => {
        if (isOpen) this.expanded.delete(section.key); else this.expanded.add(section.key);
        cx.notify();
      })
      .child(icon(isOpen ? "chevron-down" : "chevron-right", 14, t.muted))
      .child(`${section.label} · ${section.tickets.length}`);
  }

  row(t, ticket, now, color) {
    const clickable = Boolean(ticket.url);
    return h_flex().id(`ticket-${ticket.key}`).flex_none().mx(8).mb(2).px(6).py(6).gap(10).items_start().rounded(8)
      .when(clickable, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => cx.open_url(ticket.url)))
      .child(div().mt(6).w(8).h(8).flex_none().rounded_full().when(ticket.draft, (el) => el.border(1.5).border_color(color)).when(!ticket.draft, (el) => el.bg(color)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(S().body).font_medium().child(ticket.title))
        .child(div().truncate().text_size(S().secondary).text_color(t.muted).child(ticketLine(ticket, now))));
  }
}
