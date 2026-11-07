// Sync: keeps Herdr's config folder and your config repo in step, from a button in the tab bar.
// The button shows ↓N ↑M: commits the repo is behind its remote, and files changed in Herdr (or
// uncommitted in the repo) that a push would commit. It follows the shown space's machine and uses
// that machine's settings (repo path, sync script, conflict agent). Click it for the popover:
// Pull, Push and Details. Nothing about a particular repo is written in the code.
// Roles (props.role): the button (default); "popover" (a pointer popup), "settings" (a dialog),
// "details" (a tab). The popover and dialog are separate views whose tasks end when they close, so
// they hand work to the button through channel.js, which runs it; results come back as shared state.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  exec, run, spaces, shared, setShared, theme, openOverlay, closeOverlay, knownAgents, pickFolder, notify,
  props as blockProps,
} from "herdr";
import {
  settingsFor, normalizeSettings, badge, changedFiles, viewState, resolved, commitMessage, conflictBrief,
  plural, ago, DEFAULTS,
} from "./model.js";
import { checkRepo, pull, push } from "./ops.js";
import { createChannel } from "./channel.js";
import { renderDetails } from "./details.js";
import { S, icon, stop, later, primary, secondary, disabledButton, pill, note, sectionLabel, dialogButton, dialogFrame } from "./ui.js";

const SETTINGS = "sync.settings.v1"; // { [machine]: { repo, script, agent } }; "" is this computer
const STATE = "sync.state.v1"; // { [machine]: what the last check read }
const CONFLICT = "sync.conflict.v1"; // { [machine]: { kind, files, saved, at } } until the repo is clean
const CHECK_EVERY = 20 * 1000, FETCH_EVERY = 5 * 60 * 1000;

const channel = createChannel({ get: (k) => shared(k), set: (k, v) => setShared(k, v) });
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const activeSpace = () => spaces().find((s) => s.active) ?? null;
const activeKey = () => activeSpace()?.machine ?? "";
const machineName = (key) => key || "This computer";

// One exec of a script of ours on machine `on`; never rejects.
const io = (on) => ({
  sh: (script, args) => exec("sh", ["-c", script, "sync", ...args], { on: on || null })
    .catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) })),
});

const sameState = (a, b) => JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });
const setIn = (key, name, value) => setShared(key, { ...obj(shared(key)), [name]: value });
const dropIn = (key, name) => { const o = { ...obj(shared(key)) }; delete o[name]; setShared(key, o); };

// What every view needs to draw a machine: its settings, last check, conflict and lock.
const context = (key) => {
  const cfg = settingsFor(shared(SETTINGS), key), state = obj(shared(STATE))[key] ?? null, conflict = obj(shared(CONFLICT))[key] ?? null;
  const busy = channel.busyAt(key || null) ? channel.busyText() : null;
  return { key, on: key || null, cfg, state, conflict, busy, kind: viewState({ settings: cfg, state, conflict, busy }) };
};

const openSettings = (key) => openOverlay({ mod: "sync", kind: "dialog", width: 520, height: 470, props: { role: "settings", key } });
const openPopover = (key) => openOverlay({ mod: "sync", kind: "popup", width: 400, height: 470, props: { role: "popover", key } });
const openDetails = () => run("tab.new", { name: "Sync", mod: "sync", props: { role: "details" } });

export default class Sync extends View {
  init(_props, cx) {
    this.role = blockProps()?.role ?? "button";
    this.handle = cx.focus_handle();
    if (this.role === "button") return this.initButton(cx);
    if (this.role === "popover") return this.initPopover(cx);
    if (this.role === "settings") return this.initSettings(cx);
  }

  render(cx) {
    if (this.role === "button") return this.renderButton(cx);
    if (this.role === "popover") return this.renderPopover(cx);
    if (this.role === "settings") return this.renderSettings(cx);
    return this.renderDetailsTab(cx);
  }

  // ================= The button: polls, runs the work the other views ask for =================

  initButton(cx) {
    this.key = null; this.tokens = {}; this.nextRequest = channel.listen();
    cx.timer.every(CHECK_EVERY, (cx) => this.check(cx));
    cx.timer.every(FETCH_EVERY, (cx) => this.check(cx, { fetch: true }));
  }

  // Reads the shown machine's repo (with a git fetch when asked). A newer read wins over an older one.
  check(cx, { fetch = false } = {}) {
    const key = activeKey(), c = context(key);
    if (!c.cfg.repo || channel.busyAt(c.on)) return Promise.resolve();
    const token = this.tokens[key] = (this.tokens[key] ?? 0) + 1;
    return cx.spawn(async (cx) => {
      const prev = c.state, at = Date.now();
      const state = await checkRepo(io(c.on), c.cfg, { fetch });
      if (token !== this.tokens[key] || channel.busyAt(c.on)) return;
      state.fetchedAt = fetch && !state.fetchError ? at : prev?.fetchedAt ?? null;
      if (!sameState(prev, state)) setIn(STATE, key, state);
      const conflict = obj(shared(CONFLICT))[key];
      if (conflict && state.repo && !state.error && resolved(state, conflict)) dropIn(CONFLICT, key);
      cx.notify();
    });
  }

  render_requests(cx) {
    const req = this.nextRequest();
    if (req) later(cx, (cx) => this.perform(req, cx));
  }

  perform(req, cx) {
    const key = req.key ?? "", c = context(key);
    if (req.op === "fetch") { if (key === activeKey()) return this.check(cx, { fetch: true }); return; }
    if (req.op === "agent") return this.openAgent(key, c, cx);
    if (!["pull", "push"].includes(req.op)) return;
    if (!c.cfg.repo) { notify({ title: "Sync", body: "Choose the config repo first (the gear in the popover).", level: "warning" }); return; }
    if (!channel.claim(c.on, req.op === "pull" ? "Pulling…" : "Pushing…")) { notify({ title: "Sync", body: "Another sync is running on this machine.", level: "warning" }); return; }
    cx.notify();
    return cx.spawn(async (cx) => {
      try {
        const out = req.op === "pull" ? await pull(io(c.on), c.cfg) : await push(io(c.on), c.cfg, req.message || commitMessage(changedFiles(c.state).length, c.state?.host));
        await this.finish(req.op, out, key, c, cx);
      } catch (e) {
        notify({ title: req.op === "pull" ? "Pull failed" : "Push failed", body: String(e?.message ?? e), level: "error" });
      } finally {
        channel.release(c.on);
        cx.notify();
        this.check(cx, { fetch: false });
      }
    });
  }

  async finish(op, out, key, c, cx) {
    const title = op === "pull" ? "Pull" : "Push";
    if (out.result === "ok") {
      const bits = [out.message];
      if (op === "pull" && out.extra.relinked === "yes") bits.push("Skillshare targets linked again.");
      else if (op === "pull" && out.extra.relinked?.startsWith("failed")) bits.push(`Skillshare sync: ${out.extra.relinked}`);
      notify({ title: `${title} done`, body: bits.filter(Boolean).join(" "), level: "success" });
      dropIn(CONFLICT, key);
      return;
    }
    if (out.result === "conflict") {
      const conflict = { kind: out.extra.kind ?? "rebase", files: out.files, saved: out.extra.saved ?? null, at: Date.now() };
      setIn(CONFLICT, key, conflict);
      notify({ title: "Conflict, resolving", body: `${out.message} ${plural(out.files.length, "file")}: ${out.files.map((f) => f.path).join(", ")}`, level: "warning" });
      await this.openAgent(key, { ...c, conflict }, cx);
      return;
    }
    notify({ title: `${title} failed`, body: out.message || "The sync script stopped.", level: "error" });
  }

  // The configured agent, in a new tab in the repo folder, with a brief naming each conflicting file.
  async openAgent(key, c, cx) {
    const conflict = c.conflict ?? obj(shared(CONFLICT))[key];
    if (!conflict) return;
    const wanted = c.cfg.agent || DEFAULTS.agent;
    const list = await knownAgents({ on: c.on }).catch(() => []);
    const agent = list.find((a) => a.key === wanted && a.installed) ?? list.find((a) => a.key === wanted) ?? null;
    const repo = c.state?.top ?? c.cfg.repo;
    const task = conflictBrief({ repo, script: c.cfg.script, kind: conflict.kind, files: conflict.files });
    const space = spaces().find((s) => (s.machine ?? "") === key && s.active) ?? spaces().find((s) => (s.machine ?? "") === key);
    run("tab.new", { name: "Sync conflict", space: space?.id, folder: repo, argv: agent?.run ?? [wanted], task });
  }

  renderButton(cx) {
    const t = theme(), key = activeKey();
    if (this.key !== key) { this.key = key; later(cx, (cx) => this.check(cx, { fetch: true })); }
    this.render_requests(cx);
    const c = context(key), b = badge(c.state);
    const tip = {
      unset: "Sync: set up the config repo", loading: "Sync: checking…", norepo: "Sync: the repo folder is not a git repository",
      error: `Sync: ${c.state?.error ?? "error"}`, conflict: "Sync: conflict, resolving", busy: `Sync: ${c.busy}`,
      ok: b.text ? `Behind by ${plural(b.down, "commit")}, ${plural(b.up, "file")} changed in Herdr` : "Sync: up to date",
    }[c.kind];
    const label = {
      unset: () => div().text_size(11).text_color(t.muted).child("Set up"),
      norepo: () => div().text_size(11).text_color(t.blocked).child("No repo"),
      error: () => icon("alert", 14, t.blocked),
      busy: () => icon("ring", 14, t.working).spin(900),
      loading: () => div(),
      conflict: () => v_flex().items_center().text_size(9.5).text_color(t.blocked).child("Conflict,").child("resolving"),
      ok: () => b.text
        ? h_flex().gap(5).text_size(12).font_semibold()
            .when(b.down > 0, (el) => el.child(div().text_color(t.working).child(`↓${b.down}`)))
            .when(b.up > 0, (el) => el.child(div().text_color(t.foreground).child(`↑${b.up}`)))
        : icon("check", 14, t.muted),
    }[c.kind]();
    return h_flex().size_full().pr(8).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("sync-button").tooltip(tip).h(30).px(8).gap(5).flex_none().items_center().justify_center().rounded(6)
        .text_color(t.muted).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => (c.kind === "unset" ? openSettings(key) : openPopover(key)))
        .when(c.kind !== "unset" && c.kind !== "norepo", (el) => el.child(icon("sync", 14, c.kind === "conflict" ? t.blocked : t.muted)))
        .child(label));
  }

  // ================= The popover =================

  initPopover(cx) {
    this.handle.focus();
    const p = blockProps() ?? {};
    this.key = p.key ?? "";
    this.openFiles = false; this.openCommits = false; this.autoMessage = ""; this.edited = false;
    this.msg = InputState.new({ placeholder: "Commit message" });
    this.msg.on("change", () => { this.edited = this.msg.value() !== this.autoMessage; });
    channel.request({ op: "fetch", key: this.key }); // a popover opening fetches
    cx.timer.every(30 * 1000, (cx) => cx.notify()); // "checked N min ago"
  }

  rowFrame(t, id, left, button, extra) {
    return v_flex().flex_none().gap(8).px(14).py(12).border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_center().child(left).child(button))
      .children((Array.isArray(extra) ? extra : [extra]).filter(Boolean));
  }

  toggleHead(t, id, text, sub, open, onToggle) {
    return h_flex().id(id).flex_1().min_w(0).gap(8).items_center().cursor_pointer().on_mouse_down("left", stop).on_click(onToggle)
      .child(icon(open ? "chevron-down" : "chevron-right", 12, t.muted))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(S().body).font_semibold().child(text))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(S().label).text_color(t.muted).child(sub))));
  }

  renderPopover(cx) {
    const t = theme(), c = context(this.key), st = c.state, p = blockProps() ?? {};
    const close = () => closeOverlay(p.overlay);
    const files = st?.repo ? changedFiles(st) : [], behind = st?.behind ?? [], unpushed = st?.unpushed ?? [];
    const ready = c.kind === "ok", working = Boolean(c.busy);
    // The default commit message follows the file count until the person edits it.
    const auto = commitMessage(files.length, st?.host);
    if (auto !== this.autoMessage) {
      const wasAuto = !this.edited;
      this.autoMessage = auto;
      if (wasAuto) later(cx, (cx) => { this.msg.set_value(auto); this.edited = false; cx.notify(); });
    }
    const req = (op) => (_e, cx) => { channel.request({ op, key: this.key, message: this.msg.value().trim() || auto }); cx.notify(); };

    const header = h_flex().flex_none().px(14).py(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0).child(div().text_size(S().title).font_semibold().child("Sync"))
        .child(div().truncate().text_size(S().label).text_color(t.muted).child(`${machineName(this.key)}${c.cfg.repo ? ` · ${c.cfg.repo}` : ""}`)))
      .child(h_flex().id("sync-settings").tooltip("Settings").size(28).flex_none().items_center().justify_center().rounded(6)
        .hover((s) => s.bg(t.hover)).cursor_pointer().on_mouse_down("left", stop)
        .on_click(() => { close(); openSettings(this.key); }).child(icon("settings", 15, t.muted)));

    const body = v_flex().id("popover-body").flex_1().min_h(0).overflow_y_scrollbar();
    if (c.kind === "unset") {
      body.child(v_flex().p(14).gap(10).child(note(t, "Choose the git repository that holds your Herdr config, and sync stays one click away."))
        .child(h_flex().child(primary("set-up", "Set up…", t, () => { close(); openSettings(this.key); }))));
    } else if (c.kind === "norepo" || c.kind === "error" || c.kind === "loading") {
      body.child(v_flex().p(14).gap(10)
        .child(note(t, c.kind === "norepo" ? `${c.cfg.repo} is not a git repository.` : c.kind === "loading" ? "Checking the repo…" : st.error, c.kind === "loading" ? t.muted : t.blocked))
        .child(h_flex().child(secondary("change-repo", "Settings…", t, () => { close(); openSettings(this.key); }))));
    } else {
      if (c.conflict) {
        body.child(v_flex().flex_none().gap(6).px(14).py(12).bg(t.selected).border_b(1).border_color(t.border)
          .child(div().text_size(S().body).font_semibold().text_color(t.blocked).child("Conflict, resolving"))
          .child(note(t, `${(c.conflict.files ?? []).map((f) => f.path).join(", ") || "See git status"}. Nothing was pushed; it clears when the repo is clean.`))
          .child(h_flex().child(secondary("agent-again", "Open the agent again", t, req("agent"), { h: 26 }))));
      }
      if (working) body.child(h_flex().flex_none().gap(8).px(14).py(10).items_center().border_b(1).border_color(t.border).text_size(S().secondary).text_color(t.working)
        .child(icon("ring", 13, t.working).spin(900)).child(c.busy));
      // 1. Pull
      body.child(this.rowFrame(t, "pull",
        this.toggleHead(t, "pull-head", behind.length ? `Behind by ${plural(behind.length, "commit")}` : "Up to date with the remote",
          behind.length ? "from " + (st.upstream ?? "the remote") : st.fetchError ? `Could not fetch: ${st.fetchError}` : `Fetched ${ago(st.fetchedAt) || "not yet"}`,
          this.openCommits && behind.length > 0, () => { this.openCommits = !this.openCommits; cx.notify(); }),
        behind.length && ready && !working ? primary("pull-button", "Pull", t, req("pull")) : disabledButton("pull-off", "Pull", t),
        this.openCommits && behind.length > 0 ? v_flex().gap(2).pl(20).children(behind.slice(0, 50).map((cm, i) =>
          h_flex().id(`commit-${i}`).gap(8).text_size(S().secondary)
            .child(div().flex_none().w(56).text_color(t.muted).child(cm.hash)).child(div().flex_1().min_w(0).truncate().child(cm.subject)))) : null));
      // 2. Push
      const n = files.length;
      body.child(this.rowFrame(t, "push",
        this.toggleHead(t, "push-head", n ? `${plural(n, "file")} changed in Herdr` : "No files changed in Herdr",
          unpushed.length ? `${plural(unpushed.length, "commit")} not pushed` : null,
          this.openFiles && n > 0, () => { this.openFiles = !this.openFiles; cx.notify(); }),
        (n || unpushed.length) && ready && !working ? primary("push-button", "Push", t, req("push")) : disabledButton("push-off", "Push", t),
        [this.openFiles && n > 0 ? v_flex().gap(2).pl(20).children(files.slice(0, 100).map((f, i) =>
          h_flex().id(`file-${i}`).gap(8).text_size(S().secondary)
            .child(div().flex_none().w(14).text_color(f.code === "D" ? t.ansi1 : f.code === "??" || f.code === "A" ? t.ansi2 : t.muted).child(f.code === "??" ? "+" : f.code))
            .child(div().flex_1().min_w(0).truncate().child(f.path))
            .child(div().flex_none().text_color(t.dim).child(f.where === "herdr" ? "Herdr" : "repo")))) : null,
        n > 0 ? v_flex().gap(4).child(sectionLabel(t, "Commit message"))
          .child(h_flex().h(30).px(10).items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
            .child(Input.new(this.msg).flex_1().min_w(0).h_full().text_size(S().secondary).text_color(t.foreground))) : null]));
      // 3. Skillshare (filled in by the Details work of ticket #2)
      body.child(this.rowFrame(t, "skillshare",
        v_flex().flex_1().min_w(0).child(div().text_size(S().body).font_semibold().child("Skillshare"))
          .child(div().truncate().text_size(S().label).text_color(t.muted).child("Targets are in Details")),
        disabledButton("sync-targets-off", "Sync targets", t), null));
    }

    const footer = h_flex().flex_none().px(14).py(10).gap(8).items_center().border_t(1).border_color(t.border)
      .child(h_flex().id("sync-details-link").gap(4).items_center().cursor_pointer().text_size(S().secondary).text_color(t.foreground)
        .hover((s) => s.text_color(t.accent)).on_mouse_down("left", stop).on_click(() => { close(); openDetails(); }).child("Details…"))
      .child(div().flex_1())
      .child(div().text_size(S().label).text_color(t.dim).child(c.state?.fetchedAt ? `Fetched ${ago(c.state.fetchedAt)}` : ""));

    return v_flex().id("sync-popover").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .size_full().min_h(0).bg(t.popover).text_size(S().body).text_color(t.foreground)
      .child(header).child(body).child(footer);
  }

  // ================= The settings dialog =================

  initSettings(cx) {
    this.handle.focus();
    const p = blockProps() ?? {};
    this.key = p.key ?? "";
    const cfg = settingsFor(shared(SETTINGS), this.key);
    this.agent = cfg.agent; this.agents = null;
    this.repo = InputState.new({ value: cfg.repo, placeholder: "/path/to/your/config-repo" });
    this.script = InputState.new({ value: cfg.script, placeholder: DEFAULTS.script });
    cx.spawn(async (cx) => {
      this.agents = (await knownAgents({ on: this.key || null }).catch(() => [])).filter((a) => a.installed);
      cx.notify();
    });
  }

  save(close, cx) {
    const cfg = normalizeSettings({ repo: this.repo.value(), script: this.script.value(), agent: this.agent });
    setIn(SETTINGS, this.key, cfg);
    channel.request({ op: "fetch", key: this.key });
    close();
  }

  renderSettings(cx) {
    const t = theme(), p = blockProps() ?? {}, close = () => closeOverlay(p.overlay);
    const field = (label, input, help, extra) => v_flex().flex_none().gap(4).child(sectionLabel(t, label))
      .child(h_flex().gap(8).items_center()
        .child(h_flex().flex_1().min_w(0).h(32).px(10).items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
          .child(Input.new(input).flex_1().min_w(0).h_full().text_size(S().body).text_color(t.foreground)))
        .children(extra ? [extra] : []))
      .when(Boolean(help), (el) => el.child(note(t, help)));
    const browse = this.key === "" ? secondary("browse", "Browse…", t, (_e, cx) => {
      cx.spawn(async (cx) => { const dir = await pickFolder({ prompt: "Use this folder" }).catch(() => null); if (dir) this.repo.set_value(dir); cx.notify(); });
    }) : null;
    const choices = this.agents ?? [];
    const agentRow = v_flex().flex_none().gap(4).child(sectionLabel(t, "Agent for conflicts"))
      .child(h_flex().gap(6).flex_wrap().children(choices.length ? choices.map((a) => {
        const on = a.key === this.agent;
        return h_flex().id(`agent-${a.key}`).h(28).px(10).items_center().rounded(6).border_1().border_color(on ? t.accent : t.border)
          .bg(on ? t.selected : t.raised).text_size(S().secondary).text_color(on ? t.foreground : t.muted).cursor_pointer()
          .hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click((_e, cx) => { this.agent = a.key; cx.notify(); }).child(a.name);
      }) : [note(t, this.agents ? "No agent is installed on this machine." : "Looking for agents…")]))
      .child(note(t, `Opens in a new tab in the repo folder when a push or pull hits a conflict. Default: ${DEFAULTS.agent}.`));
    return dialogFrame(t, "sync-settings", this.handle, `Sync settings · ${machineName(this.key)}`,
      [field("Config repo", this.repo, this.key ? `The repo's path on ${this.key}.` : "The git repository that holds your Herdr config.", browse),
        field("Sync script", this.script, "Run from the repo folder with --push, --pull and --dry-run. Default ./mount.sh."),
        agentRow],
      [dialogButton("cancel", "Cancel", t, close), dialogButton("save", "Save", t, (_e, cx) => this.save(close, cx), "primary")], close, (cx) => this.save(close, cx));
  }

  // ================= The Details tab =================

  renderDetailsTab(cx) {
    const t = theme(), key = activeKey(), c = context(key);
    if (this.key !== key) { this.key = key; later(cx, () => channel.request({ op: "fetch", key })); }
    return renderDetails({
      t, key, on: c.on, cfg: c.cfg, state: c.state, conflict: c.conflict, busy: c.busy,
      request: (op) => channel.request({ ...op, key }), openSettings: () => openSettings(key),
    });
  }
}
