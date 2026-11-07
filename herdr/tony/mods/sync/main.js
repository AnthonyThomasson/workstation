// Sync: keeps Herdr's config folder and your config repo in step, from an icon in the tab bar.
// The icon is a circular arrow; small yellow arrows at its top-right corner say files changed in Herdr (up, what Push
// would send) or the repo is behind its remote (down). It follows the shown space's machine and uses that machine's
// settings (repo path, sync script). Click it to open or close the Details panel in the layout's right-hand panel
// column: Repo (the branch or worktree being synced, Sync, Push) and Settings.
//   Sync: the repo to Herdr, one way (the repo wins), then the running Herdr is asked whether it loaded the result.
//   Push: Herdr's changes into the repo, commit, push. Only from main.
// Roles (props.role): the button (default), always mounted: it owns the timers, the checks and the work the panel asks
// for; "details" (the panel the button shows). The panel is a separate view whose tasks end when it hides, so it hands
// work to the button through channel.js, which runs it; results come back as shared state.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { exec, run, spaces, layout, shared, setShared, theme, pickFolder, notify, readTextFile, props as blockProps } from "herdr";
import { settingsFor, normalizeSettings, badge, changedFiles, viewState, commitMessage, plural, fetchBlocksCheck, DEFAULTS } from "./model.js";
import { checkRepo, push, syncHerdr, listTargets, switchBranch, PATHS } from "./ops.js";
import { createRunner } from "./jobs.js";
import { createChannel } from "./channel.js";
import { renderDetails } from "./details.js";
import { icon, stop, later } from "./ui.js";

const SETTINGS = "sync.settings.v1"; // { [machine]: { repo, script, dir } }; "" is this computer
const STATE = "sync.state.v1"; // { [machine]: what the last check read }
const BUMP = "sync.where.bump.v1"; // changes when the branch and worktree lists should be read again
const CHECK_EVERY = 20 * 1000, FETCH_EVERY = 5 * 60 * 1000, WHERE_EVERY = 20 * 1000;

const channel = createChannel({ get: (k) => shared(k), set: (k, v) => setShared(k, v) });
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const activeKey = () => (spaces().find((s) => s.active) ?? null)?.machine ?? "";
const machineName = (key) => key || "This computer";

// Everything that can be slow (git fetch, push, the sync script) runs as a detached job that is polled (jobs.js),
// because Herdr stops an exec after 30 s. The runner adds the usual PATH.
const runner = createRunner({
  exec: (script, args, on) => exec("sh", ["-c", `${PATHS}\n${script}`, "sync", ...args], { on: on || null })
    .catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) })),
  readText: (path, on) => readTextFile(path, { on: on || null }),
});
const repoIO = (cx, on, { lock } = {}) => {
  const touch = () => { if (lock !== undefined) channel.touch(lock); };
  return {
    sh: (script, args) => { touch(); return runner.sh(script, args, on || null); },
    job: (script, args) => { touch(); return runner.job(args, { on: on || null, script, sleep: (ms) => { touch(); return cx.sleep(ms); } }); },
  };
};

const sameState = (a, b) => JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });
const setIn = (key, name, value) => setShared(key, { ...obj(shared(key)), [name]: value });

// What every view needs to draw a machine: its settings (`cfg` as saved; `rcfg` points at the picked worktree), last check and lock.
const context = (key) => {
  const cfg = settingsFor(shared(SETTINGS), key), state = obj(shared(STATE))[key] ?? null;
  const busy = channel.busyAt(key || null) ? channel.busyText() : null;
  return { key, on: key || null, cfg, rcfg: { ...cfg, repo: cfg.dir || cfg.repo }, state, busy, kind: viewState({ settings: cfg, state, busy }) };
};

const PANEL = "panel", STACK = "panel-body", SHOWN = "sync";
const find = (node, id) => {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
};
const shownHere = () => {
  const root = layout(), panel = find(root, PANEL), body = find(root, STACK);
  return Boolean(panel && !panel.hidden && body?.active === SHOWN);
};
const showPanel = () => { run("layout.select", { stack: STACK, child: SHOWN }); run("layout.show", { id: PANEL }); };

export default class Sync extends View {
  init(_props, cx) {
    this.role = blockProps()?.role ?? "button";
    this.handle = cx.focus_handle();
    if (this.role === "button") return this.initButton(cx);
    if (this.role === "details") return this.initDetails(cx);
  }

  render(cx) {
    return this.role === "button" ? this.renderButton(cx) : this.renderDetailsTab(cx);
  }

  // ================= The button: polls, runs the work the panel asks for =================

  initButton(cx) {
    this.key = null; this.tokens = {}; this.fetching = {}; this.nextRequest = channel.listen();
    cx.timer.every(CHECK_EVERY, (cx) => this.check(cx));
    cx.timer.every(FETCH_EVERY, (cx) => this.check(cx, { fetch: true }));
  }

  // Reads the shown machine's repo (the picked worktree), with a git fetch when asked. A newer read wins over an older
  // one, but a plain 20 s check never replaces a fetch that is still running: it waits for the next tick instead.
  check(cx, { fetch = false } = {}) {
    const key = activeKey(), c = context(key);
    if (!c.cfg.repo || channel.busyAt(c.on)) return Promise.resolve();
    if (!fetch && fetchBlocksCheck(this.fetching[key]?.at)) return Promise.resolve();
    const token = this.tokens[key] = (this.tokens[key] ?? 0) + 1;
    if (fetch) this.fetching[key] = { token, at: Date.now() };
    return cx.spawn(async (cx) => {
      try {
        const prev = c.state, at = Date.now();
        const state = await checkRepo(repoIO(cx, c.on), c.rcfg, { fetch });
        if (token !== this.tokens[key] || channel.busyAt(c.on)) return;
        state.fetchedAt = fetch && !state.fetchError ? at : obj(shared(STATE))[key]?.fetchedAt ?? prev?.fetchedAt ?? null;
        if (!sameState(prev, state)) setIn(STATE, key, state);
      } finally {
        if (this.fetching[key]?.token === token) this.fetching[key] = null;
        cx.notify();
      }
    });
  }

  render_requests(cx) {
    const req = this.nextRequest();
    if (req) later(cx, (cx) => this.perform(req, cx));
  }

  perform(req, cx) {
    const key = req.key ?? "", c = context(key);
    if (req.op === "fetch") { if (key === activeKey()) this.check(cx, { fetch: true }); return; }
    if (req.op === "pickdir") {
      setIn(SETTINGS, key, { ...c.cfg, dir: String(req.dir ?? "") });
      setIn(STATE, key, null);
      setShared(BUMP, Date.now());
      return this.check(cx, { fetch: true });
    }
    if (!["herdrsync", "push", "switch"].includes(req.op)) return;
    if (!c.cfg.repo) { notify({ title: "Sync", body: "Choose the config repo first: open the Sync panel and set it under Settings.", level: "warning" }); return; }
    const busyText = { herdrsync: "Syncing Herdr…", push: "Pushing…", switch: "Switching branch…" }[req.op];
    if (!channel.claim(c.on, busyText)) { notify({ title: "Sync", body: "Another sync is running on this machine.", level: "warning" }); return; }
    cx.notify();
    return cx.spawn(async (cx) => {
      try {
        const io = repoIO(cx, c.on, { lock: c.on });
        let out;
        if (req.op === "herdrsync") out = await syncHerdr(io, c.rcfg);
        else if (req.op === "switch") out = await switchBranch(io, c.rcfg.repo, req.branch);
        else out = await push(io, c.rcfg, req.message || commitMessage(changedFiles(c.state).length, c.state?.host));
        const title = { herdrsync: "Sync", push: "Push", switch: "Switch" }[req.op];
        const ok = out.result === "ok";
        notify({ title: ok ? `${title} done` : `${title} failed`, body: out.message || (ok ? "Done" : "The script stopped."), level: ok ? "success" : "error" });
      } catch (e) {
        notify({ title: "Sync failed", body: String(e?.message ?? e), level: "error" });
      } finally {
        channel.release(c.on);
        setShared(BUMP, Date.now());
        cx.notify();
        this.check(cx, { fetch: req.op !== "herdrsync" });
      }
    });
  }

  renderButton(cx) {
    const t = theme(), key = activeKey(), on = shownHere();
    if (this.key !== key) { this.key = key; later(cx, (cx) => this.check(cx, { fetch: true })); }
    this.render_requests(cx);
    const c = context(key), b = badge(c.state);
    const tip = {
      unset: "Sync: set up the config repo", loading: "Sync: checking…", norepo: "Sync: the repo folder is not a git repository",
      error: `Sync: ${c.state?.error ?? "error"}`, busy: `Sync: ${c.busy}`,
      ok: b.text ? `Behind by ${plural(b.down, "commit")}, ${plural(b.up, "file")} changed in Herdr` : "Sync: up to date",
    }[c.kind];
    const tint = c.kind === "error" ? t.blocked : c.kind === "unset" || c.kind === "norepo" ? t.dim : on ? t.foreground : t.muted;
    const arrows = c.kind === "ok" ? b : { down: 0, up: 0 };
    const counted = arrows.down > 0 || arrows.up > 0;
    const glyph = icon("sync", 16, tint);
    const spinning = c.kind === "busy" ? glyph.spin(900) : glyph;
    return h_flex().size_full().pr(8).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("sync-button").tooltip(tip).h(30).w(34).flex_none().items_center().justify_center().rounded(6)
        .bg(on ? t.selected : t.chrome).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: PANEL });
          else { showPanel(); channel.request({ op: "fetch", key }); } // opening fetches
        })
        .child(div().relative().size_full().flex().items_center().justify_center()
          .child(div().size(16).flex_none().child(spinning))
          .when(counted, (e) => e.child(h_flex().absolute().top(1).right(1).gap(0)
            .when(arrows.down > 0, (x) => x.child(icon("arrow-down", 9, t.working)))
            .when(arrows.up > 0, (x) => x.child(icon("arrow-up", 9, t.working)))))));
  }

  // ================= The Details panel =================

  initDetails(cx) {
    this.where = {}; this.whereAt = {}; this.whereBump = null; this.reading = {}; this.rereadAt = Date.now();
    this.autoMessage = ""; this.edited = false; this.repoOpen = { files: false, where: false };
    this.msg = InputState.new({ placeholder: "Commit message" });
    this.msg.on("change", () => { this.edited = this.msg.value() !== this.autoMessage; });
    this.settingsOpen = false; this.settingsKey = null;
    this.repoInput = InputState.new({ placeholder: "/path/to/your/config-repo" });
    this.scriptInput = InputState.new({ placeholder: DEFAULTS.script });
    // A shown panel renders this often, which keeps the branch list fresh; a hidden panel reads nothing.
    cx.timer.every(WHERE_EVERY, (cx) => cx.notify());
  }

  // Reads the repo's worktrees and branches (from the repo as saved, so every worktree stays listed).
  readWhere(cx, key, repo) {
    if (this.reading[key] || !repo) return;
    this.reading[key] = true;
    return cx.spawn(async (cx) => {
      try { this.where[key] = await listTargets(repoIO(cx, key || null), repo); this.whereAt[key] = Date.now(); }
      catch { /* keep the last list */ }
      finally { this.reading[key] = false; cx.notify(); }
    });
  }

  saveSettings(key, cx) {
    const prev = settingsFor(shared(SETTINGS), key);
    const cfg = normalizeSettings({ repo: this.repoInput.value(), script: this.scriptInput.value(), dir: prev.repo === this.repoInput.value().trim() ? prev.dir : "" });
    setIn(SETTINGS, key, cfg);
    channel.request({ op: "fetch", key });
    this.settingsOpen = false;
    cx.notify();
  }

  renderDetailsTab(cx) {
    const t = theme(), key = activeKey(), c = context(key);
    if (this.key !== key) { this.key = key; later(cx, () => channel.request({ op: "fetch", key })); }
    const bump = shared(BUMP) ?? null;
    if (c.cfg.repo && !this.reading[key] && (bump !== this.whereBump || Date.now() - (this.whereAt[key] ?? 0) > WHERE_EVERY - 3000)) {
      this.whereBump = bump; later(cx, (cx) => this.readWhere(cx, key, c.cfg.repo));
    }
    // The settings fields start from the shown machine's settings, and again when the shown machine changes.
    if (this.settingsKey !== key) {
      this.settingsKey = key; this.settingsOpen = false;
      later(cx, (cx) => { this.repoInput.set_value(c.cfg.repo); this.scriptInput.set_value(c.cfg.script); cx.notify(); });
    }
    // The commit message for Push follows the file count until the person edits it.
    const st = c.state, auto = commitMessage(st?.repo ? changedFiles(st).length : 0, st?.host);
    if (auto !== this.autoMessage) {
      const wasAuto = !this.edited;
      this.autoMessage = auto;
      if (wasAuto) later(cx, (cx) => { this.msg.set_value(auto); this.edited = false; cx.notify(); });
    }
    return renderDetails({
      t, key, machine: machineName(key), on: c.on, cfg: c.cfg, state: c.state, busy: c.busy, kind: c.kind,
      request: (op) => channel.request({ key, ...op }),
      close: find(layout(), PANEL) ? () => run("layout.hide", { id: PANEL }) : null,
      msg: this.msg, auto, repoOpen: this.repoOpen, where: this.where[key] ?? null,
      toggleRepo: (name, cx) => { this.repoOpen = { ...this.repoOpen, [name]: !this.repoOpen[name] }; cx.notify(); },
      openSettings: (cx) => { this.settingsOpen = true; cx.notify(); },
      settings: {
        repo: this.repoInput, script: this.scriptInput, open: this.settingsOpen, forced: !c.cfg.repo,
        browse: (cx) => cx.spawn(async (cx) => { const dir = await pickFolder({ prompt: "Use this folder" }).catch(() => null); if (dir) this.repoInput.set_value(dir); cx.notify(); }),
        save: (cx) => this.saveSettings(key, cx),
        toggle: (cx) => { this.settingsOpen = !this.settingsOpen; cx.notify(); },
      },
    });
  }
}
