// Sync: keeps Herdr's config folder and your config repo in step, from an icon in the tab bar.
// The icon is a circular arrow; when the repo is behind its remote, or files changed in Herdr (or uncommitted
// in the repo) would be committed by a push, small yellow counts ↓N ↑M sit at its top-right corner. It follows
// the shown space's machine and uses that machine's settings (repo path, sync script, conflict agent). Click it
// to open or close the Details panel in the layout's right-hand panel column: Repo (Pull, Push, skillshare
// sync), Targets, Source, Machines, Conflicts and Settings. Nothing about a particular repo is written in the code.
// Roles (props.role): the button (default), always mounted: it owns the timers, the checks and the work the other
// views ask for; "details" (the panel the button shows); "text" (a dialog showing one command's output), "upgrade"
// and "srcboth" (confirm dialogs). The panel and dialogs are separate views whose tasks end when they close or hide,
// so they hand work to the button through channel.js, which runs it; results come back as shared state.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import {
  exec, run, spaces, machines, layout, shared, setShared, theme, openOverlay, closeOverlay, knownAgents, pickFolder, notify, readTextFile, focused,
  props as blockProps,
} from "herdr";
import {
  settingsFor, normalizeSettings, badge, changedFiles, withSaved, viewState, resolved, commitMessage, conflictBrief,
  plural, DEFAULTS, sourceCommitMessage, pullReplacedNote, fetchBlocksCheck,
} from "./model.js";
import { checkRepo, pull, push, finishMerge, PATHS } from "./ops.js";
import { applyChoices } from "./conflicts.js";
import { settleRepoConflict } from "./repo-conflict.js";
import { checkSource, pullSource, pushSource, bothSource, resolveSource, stillStopped } from "./source.js";
import { loadMachine, upgradeCli, pullPlan, bareVersion } from "./machines.js";
import { createRunner } from "./jobs.js";
import { findProject, hasSkillshare, loadTargets, syncTargets, diffText } from "./targets-ops.js";
import { keepItems } from "./targets.js";
import { createChannel } from "./channel.js";
import { renderDetails } from "./details.js";
import { S, icon, stop, later, note, monoBox, dialogButton, dialogFrame } from "./ui.js";

const SETTINGS = "sync.settings.v1"; // { [machine]: { repo, script, agent } }; "" is this computer
const STATE = "sync.state.v1"; // { [machine]: what the last check read }
const CONFLICT = "sync.conflict.v1"; // { [machine]: { kind, files, saved, at } } until the repo is clean
const TARGETS = "sync.targets.v1"; // { [machine]: what the last skillshare read found; see readTargets }
const SOURCE = "sync.source.v1"; // { [machine]: the skillshare source's git state; see readSourceState }
const STOPPED = "sync.stopped.v1"; // { [machine]: a pull stopped on a conflict, waiting for a choice per file }
const BUMP = "sync.machines.bump.v1"; // changes when the Machines cards should be read again
const MACHINES_EVERY = 60 * 1000; // the Machines cards are read again when older than this (while the panel is shown)
const CHECK_EVERY = 20 * 1000, FETCH_EVERY = 5 * 60 * 1000, TARGETS_EVERY = 2 * 60 * 1000;
const DETAILS_EVERY = 20 * 1000; // the Details panel reads targets and source this often while it is shown

const channel = createChannel({ get: (k) => shared(k), set: (k, v) => setShared(k, v) });
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const activeSpace = () => spaces().find((s) => s.active) ?? null;
const activeKey = () => activeSpace()?.machine ?? "";
// The space whose folder tells which skillshare project to use on machine `key`: the shown one, else any.
const spaceOf = (key) => spaces().find((s) => (s.machine ?? "") === key && s.active) ?? spaces().find((s) => (s.machine ?? "") === key) ?? null;
const machineName = (key) => key || "This computer";
// The folders that tell which skillshare project to use on machine `key`: the focused terminal's folder when it
// is in that machine's shown space, then the space's own folder.
const projectFolders = (key) => {
  const space = spaceOf(key), f = focused();
  return [f?.space && f.space === space?.id && f.cwd ? f.cwd : "", space?.folder ?? ""];
};

// Everything that can be slow (git fetch, pull, push, skillshare sync) runs as a detached job that is
// polled (jobs.js), because Herdr stops an exec after 30 s. The runner adds the usual PATH.
const runner = createRunner({
  exec: (script, args, on) => exec("sh", ["-c", `${PATHS}\n${script}`, "sync", ...args], { on: on || null })
    .catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) })),
  readText: (path, on) => readTextFile(path, { on: on || null }),
});
// With lock, the caller holds that machine's lock (channel.js) and every command keeps it fresh.
const touching = (lock) => () => { if (lock !== undefined) channel.touch(lock); };

// What ops.js runs the repo scripts with: io.sh(script, args) short, io.job(script, args) detached.
const repoIO = (cx, on, { lock } = {}) => {
  const touch = touching(lock);
  return {
    sh: (script, args) => { touch(); return runner.sh(script, args, on || null); },
    job: (script, args) => { touch(); return runner.job(args, { on: on || null, script, sleep: (ms) => { touch(); return cx.sleep(ms); } }); },
  };
};

// What targets-ops.js runs skillshare with.
const skillshareIO = (cx, { lock } = {}) => {
  const touch = touching(lock);
  return {
    sh: (script, args, on) => { touch(); return runner.sh(script, args, on); },
    run: (args, o) => { touch(); return runner.run(args, o); },
    job: (args, o) => { touch(); return runner.job(args, { ...o, sleep: (ms) => { touch(); return cx.sleep(ms); } }); },
  };
};

const sameState = (a, b) => JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });
const setIn = (key, name, value) => setShared(key, { ...obj(shared(key)), [name]: value });
const dropIn = (key, name) => { const o = { ...obj(shared(key)) }; delete o[name]; setShared(key, o); };

// What every view needs to draw a machine: its settings, last check, conflict and lock.
const context = (key) => {
  const cfg = settingsFor(shared(SETTINGS), key), state = obj(shared(STATE))[key] ?? null, conflict = obj(shared(CONFLICT))[key] ?? null;
  const busy = channel.busyAt(key || null) ? channel.busyText() : null;
  return { key, on: key || null, cfg, state, conflict, busy, kind: viewState({ settings: cfg, state, conflict, busy }) };
};

// The side panel is the layout's shared "panel" column, whose "panel-body" stack holds this mod's Details view
// (child "sync") beside the other panels. Like them, it is open only while the column is shown on it.
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
    if (this.role === "text" || this.role === "upgrade" || this.role === "srcboth") return this.handle.focus();
    if (this.role === "details") return this.initDetails(cx);
  }

  render(cx) {
    if (this.role === "button") return this.renderButton(cx);
    if (this.role === "text") return this.renderText(cx);
    if (this.role === "upgrade") return this.renderUpgrade(cx);
    if (this.role === "srcboth") return this.renderSrcBoth(cx);
    return this.renderDetailsTab(cx);
  }

  // ================= The button: polls, runs the work the other views ask for =================

  initButton(cx) {
    this.key = null; this.tokens = {}; this.fetching = {}; this.nextRequest = channel.listen();
    cx.timer.every(CHECK_EVERY, (cx) => this.check(cx));
    cx.timer.every(FETCH_EVERY, (cx) => this.check(cx, { fetch: true }));
    cx.timer.every(TARGETS_EVERY, (cx) => this.readTargets(cx, activeKey()));
    this.reading = {}; this.readingSource = {};
    cx.timer.every(TARGETS_EVERY, (cx) => this.readSourceState(cx, activeKey()));
  }

  // Reads skillshare on machine `key` (both scopes when the shown space's folder is a skillshare project)
  // and keeps what needs a sync in shared: { installed, project, at, error, ok, off, items }. Items that
  // are in sync are only counted, so the value stays small.
  readTargets(cx, key) {
    const on = key || null;
    if (this.reading[key] || channel.busyAt(on)) return Promise.resolve();
    this.reading[key] = true;
    return cx.spawn(async (cx) => {
      try {
        const io = skillshareIO(cx);
        const prev = obj(shared(TARGETS))[key];
        if (!(await hasSkillshare(io, on))) { if (prev?.installed !== false) setIn(TARGETS, key, { installed: false, at: Date.now() }); return; }
        const project = await findProject(io, on, projectFolders(key));
        const res = await loadTargets(io, on, project);
        const items = keepItems(res.items);
        const next = { installed: true, project, at: Date.now(), error: res.error, ok: res.items.filter((i) => !i.notice && i.state === "ok").length,
          off: res.items.filter((i) => !i.notice && i.state === "off").length, items };
        if (!sameState(prev, next)) setIn(TARGETS, key, next);
        else setIn(TARGETS, key, { ...prev, at: next.at });
      } catch (e) {
        setIn(TARGETS, key, { installed: true, project: null, at: Date.now(), error: String(e?.message ?? e), ok: 0, off: 0, items: [] });
      } finally { this.reading[key] = false; cx.notify(); }
    });
  }

  // Reads the skillshare source's git state on machine `key` into shared (see source.js). With fetch, after a
  // git fetch. The source inside the config repo is only marked (same): the repo's own check covers it.
  readSourceState(cx, key, { fetch = false } = {}) {
    const on = key || null;
    if (this.readingSource[key] || channel.busyAt(on)) return Promise.resolve();
    this.readingSource[key] = true;
    return cx.spawn(async (cx) => {
      try {
        const io = skillshareIO(cx), at = Date.now(), prev = obj(shared(SOURCE))[key];
        const g = (await hasSkillshare(io, on)) ? await checkSource(io, { on, configRepo: settingsFor(shared(SETTINGS), key).repo, fetch }) : null;
        const next = g ? { ...g, uncommitted: (g.uncommitted ?? []).slice(0, 300), at, fetchedAt: fetch && !g.fetchError ? at : prev?.fetchedAt ?? null } : { none: true, at };
        if (!sameState(prev, next)) setIn(SOURCE, key, next); else setIn(SOURCE, key, { ...prev, at });
        // A stopped source pull that was settled elsewhere (a terminal, the dashboard) is no longer a question.
        const stopped = obj(shared(STOPPED))[key];
        if (stopped?.target === "source" && !stillStopped(stopped, next)) dropIn(STOPPED, key);
      } catch (e) {
        setIn(SOURCE, key, { path: null, error: String(e?.message ?? e), at: Date.now() });
      } finally { this.readingSource[key] = false; cx.notify(); }
    });
  }

  // Reads the shown machine's repo (with a git fetch when asked). A newer read wins over an older one, but a
  // plain 20 s check never replaces a fetch that is still running: it waits for the next tick instead.
  check(cx, { fetch = false } = {}) {
    const key = activeKey(), c = context(key);
    if (!c.cfg.repo || channel.busyAt(c.on)) return Promise.resolve();
    if (!fetch && fetchBlocksCheck(this.fetching[key]?.at)) return Promise.resolve();
    const token = this.tokens[key] = (this.tokens[key] ?? 0) + 1;
    if (fetch) this.fetching[key] = { token, at: Date.now() };
    return cx.spawn(async (cx) => {
      try {
        const prev = c.state, at = Date.now();
        const state = await checkRepo(repoIO(cx, c.on), c.cfg, { fetch });
        if (token !== this.tokens[key] || channel.busyAt(c.on)) return;
        state.fetchedAt = fetch && !state.fetchError ? at : obj(shared(STATE))[key]?.fetchedAt ?? prev?.fetchedAt ?? null;
        if (!sameState(prev, state)) setIn(STATE, key, state);
        const conflict = obj(shared(CONFLICT))[key];
        if (conflict && state.repo && !state.error && resolved(state, conflict)) { dropIn(CONFLICT, key); if (obj(shared(STOPPED))[key]?.target === "repo") dropIn(STOPPED, key); }
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
    if (req.op === "fetch") { if (key === activeKey()) { this.check(cx, { fetch: true }); this.readSourceState(cx, key, { fetch: true }); return this.readTargets(cx, key); } return; }
    if (req.op === "reread") { if (key === activeKey()) { this.readSourceState(cx, key); return this.readTargets(cx, key); } return; }
    if (["srcpull", "srcpush", "srcboth"].includes(req.op)) return this.sourceOp(req, key, c, cx);
    if (req.op === "resolve") return this.resolveOp(req, key, c, cx);
    if (req.op === "dismiss") { dropIn(STOPPED, key); cx.notify(); return; }
    if (req.op === "pullsync") return this.pullSyncOp(req, key, c, cx);
    if (req.op === "upgrade") return this.upgradeOp(req, key, c, cx);
    if (req.op === "sync") return this.syncOp(req, key, c, cx);
    if (req.op === "diff") return this.diffOp(req, key, c, cx);
    if (req.op === "agent") return this.openAgent(key, c, cx);
    if (!["pull", "push"].includes(req.op)) return;
    if (!c.cfg.repo) { notify({ title: "Sync", body: "Choose the config repo first: open the Sync panel and set it under Settings.", level: "warning" }); return; }
    if (!channel.claim(c.on, req.op === "pull" ? "Pulling…" : "Pushing…")) { notify({ title: "Sync", body: "Another sync is running on this machine.", level: "warning" }); return; }
    cx.notify();
    return cx.spawn(async (cx) => {
      try {
        const io = repoIO(cx, c.on, { lock: c.on });
        const out = req.op === "pull" ? await pull(io, c.cfg) : await push(io, c.cfg, req.message || commitMessage(changedFiles(c.state).length, c.state?.host));
        await this.finish(req.op, out, key, c, cx);
        // "Pull and sync" on a machine with a config repo and a separate source repo pulls the source too (a stopped repo pull does not).
        if (req.alsoSource && out.result === "ok") {
          const step = (text) => { channel.step(c.on, text); cx.notify(); };
          const r = await pullSource(skillshareIO(cx, { lock: c.on }), { on: c.on, repo: req.alsoSource, step });
          await this.settle(key, c, cx, { ...r, relink: true }, "Source pull");
        }
      } catch (e) {
        notify({ title: req.op === "pull" ? "Pull failed" : "Push failed", body: String(e?.message ?? e), level: "error" });
      } finally {
        channel.release(c.on);
        setShared(BUMP, Date.now()); // the Machines cards read again
        cx.notify();
        this.check(cx, { fetch: false });
        this.readTargets(cx, key);
        this.readSourceState(cx, key);
      }
    });
  }

  // Runs `work(io, step, cx)` under machine `c.on`'s lock. work resolves to { kind, text, stopped?, relink? }
  // (a source operation's result), which is shown as a notification; a stopped pull is kept for the
  // Conflicts section, and `relink` links the targets again when the work went well.
  locked(key, c, cx, busyText, title, work) {
    if (!channel.claim(c.on, busyText)) { notify({ title: "Sync", body: "Another sync is running on this machine.", level: "warning" }); return; }
    cx.notify();
    return cx.spawn(async (cx) => {
      try {
        const step = (text) => { channel.step(c.on, text); cx.notify(); };
        await this.settle(key, c, cx, await work(skillshareIO(cx, { lock: c.on }), step, cx), title);
      } catch (e) {
        notify({ title: `${title} failed`, body: String(e?.message ?? e), level: "error" });
      } finally {
        channel.release(c.on);
        setShared(BUMP, Date.now());
        cx.notify();
        this.check(cx, { fetch: false });
        this.readTargets(cx, key);
        this.readSourceState(cx, key);
      }
    });
  }

  // Shows what a source operation resolved to (see locked): a stopped pull is kept for the Conflicts section.
  async settle(key, c, cx, r, title) {
    if (r.stopped) {
      setIn(STOPPED, key, { target: r.target ?? "source", ...r.stopped, at: Date.now() });
      notify({ title: "Conflict, resolving", body: `${r.text} Open the Sync panel, Conflicts to choose a side per file.`, level: "warning" });
      return;
    }
    if (r.kind === "done") dropIn(STOPPED, key);
    const relinked = r.kind === "done" && r.relink ? await this.relink(key, c, cx).catch((e) => ({ kind: "error", text: String(e?.message ?? e) })) : null;
    const extra = relinked?.kind === "done" ? " Skillshare targets linked again." : relinked ? ` Skillshare sync failed: ${relinked.text}` : "";
    const level = r.kind === "done" ? (relinked && relinked.kind !== "done" ? "warning" : "success") : r.kind === "warn" ? "warning" : "error";
    notify({ title: r.kind === "done" ? `${title} done` : r.kind === "warn" ? `${title} stopped` : `${title} failed`, body: `${r.text}${extra}`, level });
  }

  // Commit/push/pull the skillshare source when it is its own git repo (source.js).
  sourceOp(req, key, c, cx) {
    const g = obj(shared(SOURCE))[key], repo = req.repo ?? g?.top;
    if (!repo) { notify({ title: "Sync", body: "The skillshare source is not in a git repository.", level: "warning" }); return; }
    const message = req.message || sourceCommitMessage(g?.uncommitted?.length ?? 0, g?.host);
    const label = { srcpull: ["Pulling the source…", "Source pull"], srcpush: ["Pushing the source…", "Source push"], srcboth: ["Syncing the source…", "Source sync"] }[req.op];
    return this.locked(key, c, cx, label[0], label[1], async (io, step) => {
      const r = req.op === "srcpull" ? await pullSource(io, { on: c.on, repo, step })
        : req.op === "srcpush" ? await pushSource(io, { on: c.on, message, step })
        : await bothSource(io, { on: c.on, repo, message, step });
      return { ...r, relink: req.op !== "srcpush" };
    });
  }

  // The person's choice for each file of a stopped pull. The source goes through skillshare; the config
  // repo through git, then the sync script (repo to Herdr) and, when a push stopped, the push.
  resolveOp(req, key, c, cx) {
    const st = obj(shared(STOPPED))[key];
    if (!st) return;
    const title = st.target === "repo" ? (st.push ? "Push" : "Pull") : "Source pull";
    return this.locked(key, c, cx, "Applying your choices…", title, async (io, step, cx) => {
      if (st.target !== "repo") return { ...(await resolveSource(io, { on: c.on, stopped: st, choices: req.choices ?? {}, step })), relink: true };
      const git = repoIO(cx, c.on, { lock: c.on });
      const r = await applyChoices(git, { repo: st.repo, choices: req.choices ?? {}, upHash: st.upHash, step });
      if (r.kind === "again") return { kind: "warn", text: "The remote changed since you chose. Pick again.", target: "repo", stopped: { ...r.stopped, push: st.push } };
      if (r.kind === "error") return { kind: "error", text: r.text };
      if (r.kind === "none") return { kind: "warn", text: "Nothing conflicts any more. Pull or push again." };
      step("Updating Herdr…");
      const out = await finishMerge(git, c.cfg, { push: Boolean(st.push) });
      if (out.result !== "ok") return { kind: "error", text: out.message || "The sync script stopped." };
      dropIn(CONFLICT, key);
      return { kind: "done", text: out.message, relink: true };
    });
  }

  // "Pull and sync" on a Machines card: the config repo (pull, then the sync script) and/or the source's own
  // repo (skillshare pull), else only link the targets (machines.js pullPlan). With both, one lock covers the two.
  pullSyncOp(req, key, c, cx) {
    const plan = pullPlan({ cfg: c.cfg, card: req.card });
    if (plan === "repo") return this.perform({ op: "pull", key }, cx);
    if (plan === "both") return this.perform({ op: "pull", key, alsoSource: req.card?.git?.top ?? req.card?.git?.path }, cx);
    if (plan === "source") return this.sourceOp({ op: "srcpull", repo: req.card?.git?.top }, key, c, cx);
    return this.locked(key, c, cx, "Syncing targets…", "Sync", async () => ({ kind: "done", text: "Nothing to pull on this machine.", relink: true }));
  }

  // "Update to <version>": skillshare upgrade --cli --force on that machine (the person confirmed in a dialog).
  upgradeOp(req, key, c, cx) {
    return this.locked(key, c, cx, `Updating skillshare on ${req.label}…`, "Update", (io, step) => upgradeCli(io, { on: c.on, label: req.label, step }));
  }

  // Links the targets again with what the repo now holds. Runs under the caller's lock.
  async relink(key, c, cx) {
    const io = skillshareIO(cx, { lock: c.on });
    if (!(await hasSkillshare(io, c.on))) return null;
    const project = await findProject(io, c.on, projectFolders(key));
    return syncTargets(io, {
      on: c.on, project, scopes: project ? ["project", "global"] : ["global"],
      step: (text) => { channel.step(c.on, text); cx.notify(); },
    });
  }

  // Sync targets: skillshare sync --all and sync plugins, for the scopes the Targets section named.
  syncOp(req, key, c, cx) {
    if (!channel.claim(c.on, "Syncing targets…")) { notify({ title: "Sync", body: "Another sync is running on this machine.", level: "warning" }); return; }
    cx.notify();
    return cx.spawn(async (cx) => {
      try {
        const project = obj(shared(TARGETS))[key]?.project ?? null;
        const scopes = (req.scopes ?? []).filter((s) => s === "global" || (s === "project" && project));
        const r = await syncTargets(skillshareIO(cx, { lock: c.on }), {
          on: c.on, project, scopes: scopes.length ? scopes : ["global"],
          step: (text) => { channel.step(c.on, text); cx.notify(); },
        });
        notify({ title: r.kind === "done" ? "Targets synced" : "Skillshare sync failed", body: r.text, level: r.kind === "done" ? "success" : "error" });
      } catch (e) {
        notify({ title: "Skillshare sync failed", body: String(e?.message ?? e), level: "error" });
      } finally {
        channel.release(c.on);
        setShared(BUMP, Date.now()); // the Machines cards read again
        cx.notify();
        this.readTargets(cx, key);
      }
    });
  }

  // Diff on one item: what the next sync would change, in a text dialog.
  diffOp(req, key, c, cx) {
    return cx.spawn(async (cx) => {
      try {
        const project = obj(shared(TARGETS))[key]?.project ?? null;
        const r = await diffText(skillshareIO(cx), req.item, { on: c.on, project });
        openOverlay({ mod: "sync", kind: "dialog", width: 620, height: 520, props: { role: "text", title: r.title, text: r.text } });
      } catch (e) {
        notify({ title: "Diff failed", body: String(e?.message ?? e), level: "error" });
      }
    });
  }

  async finish(op, out, key, c, cx) {
    const title = op === "pull" ? "Pull" : "Push";
    if (out.result === "ok") {
      const bits = [out.message];
      if (op === "pull") bits.push(pullReplacedNote(out.extra));
      let level = "success";
      // Pulled commits take effect once the targets are linked again (a push that took the remote's commits too).
      if (op === "pull" || Number(out.extra.pulled) > 0) {
        const r = await this.relink(key, c, cx).catch((e) => ({ kind: "error", text: String(e?.message ?? e) }));
        if (r?.kind === "done") bits.push("Skillshare targets linked again.");
        else if (r) { bits.push(`Skillshare sync failed: ${r.text}`); level = "warning"; }
      }
      notify({ title: `${title} done`, body: bits.filter(Boolean).join(" "), level });
      dropIn(CONFLICT, key);
      return;
    }
    if (out.result === "conflict") {
      const kind = out.extra.kind ?? "rebase";
      // A copy conflict names where Herdr's version of each file was saved, for the agent's brief (each file carries it).
      const conflict = { kind, files: kind === "copy" ? withSaved(out.files, out.extra.saved) : out.files, saved: out.extra.saved ?? null, op, at: Date.now() };
      setIn(CONFLICT, key, conflict);
      let openAgent = op === "push";
      if (conflict.kind === "rebase" && conflict.files.length) {
        // Replay the merge: .metadata.json is merged entry by entry without asking (and a push that only
        // clashed there finishes); other files go to the picker in Details, with both sides of each.
        const step = (text) => { channel.step(c.on, text); cx.notify(); };
        const r = await settleRepoConflict(repoIO(cx, c.on, { lock: c.on }), c.cfg, { repo: c.state?.top ?? c.cfg.repo, push: op === "push", step })
          .catch((e) => ({ kind: "error", text: String(e?.message ?? e) }));
        if (r.kind === "done") {
          dropIn(CONFLICT, key);
          const linked = await this.relink(key, c, cx).catch((e) => ({ kind: "error", text: String(e?.message ?? e) }));
          notify({ title: `${title} done`, body: `${r.text}${linked?.kind === "done" ? " Skillshare targets linked again." : linked ? ` Skillshare sync failed: ${linked.text}` : ""}`, level: linked && linked.kind !== "done" ? "warning" : "success" });
          return;
        }
        if (r.kind === "error") { dropIn(CONFLICT, key); notify({ title: `${title} failed`, body: r.text, level: "error" }); return; }
        if (r.kind === "stopped") setIn(STOPPED, key, { ...r.stopped, at: Date.now() });
        openAgent = r.openAgent;
      }
      const hint = openAgent ? "" : " Open the Sync panel, Conflicts to choose a side per file, or ask the agent.";
      notify({ title: "Conflict, resolving", body: `${out.message} ${plural(out.files.length, "file")}: ${out.files.map((f) => f.path).join(", ")}.${hint}`, level: "warning" });
      if (openAgent) await this.openAgent(key, { ...c, conflict }, cx);
      return;
    }
    notify({ title: `${title} failed`, body: out.message || "The sync script stopped.", level: "error" });
  }

  // The configured agent, in a new tab in the repo folder, with a brief naming each conflicting file.
  async openAgent(key, c, cx) {
    const stopped = obj(shared(STOPPED))[key];
    const fromSource = stopped?.target === "source" && !(c.conflict ?? obj(shared(CONFLICT))[key]);
    const conflict = fromSource ? { kind: "rebase", files: stopped.files.map((path) => ({ path })) } : c.conflict ?? obj(shared(CONFLICT))[key];
    if (!conflict) return;
    const wanted = c.cfg.agent || DEFAULTS.agent;
    const list = await knownAgents({ on: c.on }).catch(() => []);
    const agent = list.find((a) => a.key === wanted && a.installed) ?? list.find((a) => a.key === wanted) ?? null;
    const repo = fromSource ? stopped.repo : c.state?.top ?? c.cfg.repo;
    const task = conflictBrief({ repo, script: c.cfg.script, kind: conflict.kind, files: conflict.files, target: fromSource ? "source" : "repo" });
    const space = spaces().find((s) => (s.machine ?? "") === key && s.active) ?? spaces().find((s) => (s.machine ?? "") === key);
    run("tab.new", { name: "Sync conflict", space: space?.id, folder: repo, argv: agent?.run ?? [wanted], task });
  }

  renderButton(cx) {
    const t = theme(), key = activeKey(), on = shownHere();
    if (this.key !== key) { this.key = key; later(cx, (cx) => { this.check(cx, { fetch: true }); this.readTargets(cx, key); this.readSourceState(cx, key, { fetch: true }); }); }
    this.render_requests(cx);
    const c = context(key), b = badge(c.state);
    const tip = {
      unset: "Sync: set up the config repo", loading: "Sync: checking…", norepo: "Sync: the repo folder is not a git repository",
      error: `Sync: ${c.state?.error ?? "error"}`, conflict: "Sync: conflict, resolving", busy: `Sync: ${c.busy}`,
      ok: b.text ? `Behind by ${plural(b.down, "commit")}, ${plural(b.up, "file")} changed in Herdr` : "Sync: up to date",
    }[c.kind];
    const tint = c.kind === "conflict" || c.kind === "error" ? t.blocked : c.kind === "unset" || c.kind === "norepo" ? t.dim : on ? t.foreground : t.muted;
    const arrows = c.kind === "ok" ? b : { down: 0, up: 0 };
    const counted = arrows.down > 0 || arrows.up > 0;
    // With counts the icon shrinks to 12 px and sits bottom-left of the 34x30 hit area (x 3..15, y 15..27); the counts sit
    // top-right (y 2..14, at most ~26 px wide even for "↓3 ↑5"), so the two never share a row of pixels.
    const glyph = icon("sync", counted ? 12 : 16, tint);
    const spinning = c.kind === "busy" ? glyph.spin(900) : glyph;
    return h_flex().size_full().pr(8).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("sync-button").tooltip(tip).h(30).w(34).flex_none().items_center().justify_center().rounded(6)
        .bg(on ? t.selected : t.chrome).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: PANEL });
          else { showPanel(); channel.request({ op: "fetch", key }); } // opening fetches
        })
        .child(counted
          ? div().relative().size_full()
            .child(div().absolute().left(3).bottom(3).size(12).flex_none().child(spinning))
            .child(h_flex().absolute().top(2).right(2).gap(2).text_size(9.5).font_semibold().text_color(t.working)
              .when(arrows.down > 0, (e) => e.child(div().child(`↓${arrows.down}`)))
              .when(arrows.up > 0, (e) => e.child(div().child(`↑${arrows.up}`))))
          : div().size(16).flex_none().child(spinning)));
  }

  // ================= A text dialog: one command's output (a Diff) =================

  renderText(cx) {
    const t = theme(), p = blockProps() ?? {}, close = () => closeOverlay(p.overlay);
    return dialogFrame(t, "sync-text", this.handle, p.title ?? "Output", [monoBox(t, "sync-text-body", p.text || "No output").flex_1().min_h(0)],
      [dialogButton("close", "Close", t, close, "primary")], close, close);
  }

  // ================= A confirm dialog: update the skillshare CLI on a machine =================

  renderUpgrade(cx) {
    const t = theme(), p = blockProps() ?? {}, close = () => closeOverlay(p.overlay);
    const go = () => { channel.request({ op: "upgrade", key: p.key ?? "", label: p.label }); close(); };
    return dialogFrame(t, "sync-upgrade", this.handle, `Update skillshare on ${p.label}?`,
      [note(t, `Replaces skillshare v${bareVersion(p.from ?? "?")} with v${bareVersion(p.to)} on ${p.label} (skillshare upgrade --cli --force).`, t.foreground)],
      [dialogButton("cancel", "Cancel", t, close), dialogButton("go", "Update", t, go, "primary")], close, go);
  }

  // ================= A confirm dialog: sync the skillshare source both ways =================

  renderSrcBoth(cx) {
    const t = theme(), p = blockProps() ?? {}, close = () => closeOverlay(p.overlay);
    const go = () => { channel.request({ op: "srcboth", key: p.key ?? "", message: p.message }); close(); };
    const steps = ["Commit your local changes", "Pull and merge changes from the remote", "Push the result", "Sync every target"];
    return dialogFrame(t, "sync-srcboth", this.handle, "Sync both ways?",
      [note(t, "This will:", t.foreground),
        v_flex().gap(4).children(steps.map((s, i) => h_flex().gap(8).text_size(S().secondary).child(div().w(14).text_color(t.muted).child(`${i + 1}.`)).child(s))),
        note(t, "If a file conflicts, nothing is pushed until you pick a version for each file; applying your choices then pushes.")],
      [dialogButton("cancel", "Cancel", t, close), dialogButton("go", "Sync both ways", t, go, "primary")], close, go);
  }

  // ================= The Details panel =================

  initDetails(cx) {
    this.cards = {}; this.cardsAt = 0; this.cardsLoading = false; this.bump = null; this.rereadAt = Date.now(); this.agentLists = {};
    this.choices = {}; this.stoppedAt = null; this.autoSrc = ""; this.srcEdited = false;
    this.srcMsg = InputState.new({ placeholder: "Commit message" });
    this.srcMsg.on("change", () => { this.srcEdited = this.srcMsg.value() !== this.autoSrc; });
    this.autoMessage = ""; this.edited = false; this.repoOpen = { commits: false, files: false };
    this.msg = InputState.new({ placeholder: "Commit message" });
    this.msg.on("change", () => { this.edited = this.msg.value() !== this.autoMessage; });
    this.settingsOpen = false; this.settingsKey = null; this.agent = DEFAULTS.agent;
    this.repoInput = InputState.new({ placeholder: "/path/to/your/config-repo" });
    this.scriptInput = InputState.new({ placeholder: DEFAULTS.script });
    // Renders keep things fresh while the panel is shown: cards older than a minute are read again, and targets and
    // source every 20 s (the button itself reads them every 2 minutes). This tick makes a shown panel render that
    // often. A panel that is not shown does not render, so it reads nothing.
    cx.timer.every(DETAILS_EVERY, (cx) => cx.notify());
  }

  // The name of machine `key`'s conflict agent, for the "Ask <agent>" button; the key until the list is read.
  agentName(key, cfg) {
    const wanted = cfg.agent || DEFAULTS.agent;
    return (this.agentLists[key] ?? []).find((a) => a.key === wanted)?.name ?? wanted;
  }

  // Reads every machine's card: this computer and each Herdr machine (an unreachable one still gets a card).
  loadMachines(cx) {
    if (this.cardsLoading) return;
    this.cardsLoading = true;
    return cx.spawn(async (cx) => {
      try {
        const names = new Set([...machines().map((m) => m.name), ...spaces().map((sp) => sp.machine)].filter(Boolean));
        for (const k of Object.keys(this.cards)) if (k && !names.has(k)) delete this.cards[k];
        const io = skillshareIO(cx);
        await Promise.all(["", ...names].map(async (key) => {
          const on = key || null, label = on ?? "this computer";
          if (!this.cards[key]) this.cards[key] = { on, label, here: !on, checking: true };
          if (on && machines().find((m) => m.name === on)?.layout === "unavailable") { this.cards[key] = { on, label, error: "Herdr can't reach this machine right now" }; cx.notify(); return; }
          try { this.cards[key] = await loadMachine(io, on, { configRepo: settingsFor(shared(SETTINGS), key).repo }); } catch (e) { this.cards[key] = { on, label, here: !on, error: String(e?.message ?? e) }; }
          cx.notify();
        }));
        this.cardsAt = Date.now();
      } finally { this.cardsLoading = false; cx.notify(); }
    });
  }

  saveSettings(key, cx) {
    const cfg = normalizeSettings({ repo: this.repoInput.value(), script: this.scriptInput.value(), agent: this.agent });
    setIn(SETTINGS, key, cfg);
    channel.request({ op: "fetch", key });
    this.settingsOpen = false;
    cx.notify();
  }

  renderDetailsTab(cx) {
    const t = theme(), key = activeKey(), c = context(key);
    if (this.key !== key) { this.key = key; later(cx, () => channel.request({ op: "fetch", key })); }
    if (Date.now() - this.rereadAt > DETAILS_EVERY - 3000) { this.rereadAt = Date.now(); later(cx, () => channel.request({ op: "reread", key })); }
    if (!this.agentLists[key]) {
      this.agentLists[key] = [];
      later(cx, (cx) => cx.spawn(async (cx) => { this.agentLists[key] = await knownAgents({ on: key || null }).catch(() => []); this.agentsReady = { ...this.agentsReady, [key]: true }; cx.notify(); }));
    }
    // The settings fields start from the shown machine's settings, and again when the shown machine changes.
    if (this.settingsKey !== key) {
      this.settingsKey = key; this.agent = c.cfg.agent; this.settingsOpen = false;
      later(cx, (cx) => { this.repoInput.set_value(c.cfg.repo); this.scriptInput.set_value(c.cfg.script); cx.notify(); });
    }
    const bump = shared(BUMP) ?? null;
    if (!this.cardsLoading && (Date.now() - this.cardsAt > MACHINES_EVERY - 15 * 1000 || bump !== this.bump)) { this.bump = bump; later(cx, (cx) => this.loadMachines(cx)); }
    const source = obj(shared(SOURCE))[key] ?? null, stopped = obj(shared(STOPPED))[key] ?? null;
    if (stopped?.at !== this.stoppedAt) { this.stoppedAt = stopped?.at ?? null; this.choices = {}; }
    // The commit message for the source follows the changed-file count until the person edits it.
    const auto = sourceCommitMessage(source?.uncommitted?.length ?? 0, source?.host);
    if (auto !== this.autoSrc) {
      const wasAuto = !this.srcEdited;
      this.autoSrc = auto;
      if (wasAuto) later(cx, (cx) => { this.srcMsg.set_value(auto); this.srcEdited = false; cx.notify(); });
    }
    // The commit message for the repo's Push follows the file count the same way.
    const st = c.state, repoAuto = commitMessage(st?.repo ? changedFiles(st).length : 0, st?.host);
    if (repoAuto !== this.autoMessage) {
      const wasAuto = !this.edited;
      this.autoMessage = repoAuto;
      if (wasAuto) later(cx, (cx) => { this.msg.set_value(repoAuto); this.edited = false; cx.notify(); });
    }
    const forced = !c.cfg.repo;
    return renderDetails({
      t, key, machine: machineName(key), on: c.on, cfg: c.cfg, state: c.state, conflict: c.conflict, busy: c.busy, kind: c.kind,
      targets: obj(shared(TARGETS))[key] ?? null, open: this.open ?? null,
      toggle: (rowKey, cx) => { this.open = this.open === rowKey ? null : rowKey; cx.notify(); },
      request: (op) => channel.request({ key, ...op }),
      close: find(layout(), PANEL) ? () => run("layout.hide", { id: PANEL }) : null,
      msg: this.msg, auto: repoAuto, repoOpen: this.repoOpen,
      toggleRepo: (name, cx) => { this.repoOpen = { ...this.repoOpen, [name]: !this.repoOpen[name] }; cx.notify(); },
      openSettings: (cx) => { this.settingsOpen = true; cx.notify(); },
      settings: {
        repo: this.repoInput, script: this.scriptInput, agent: this.agent, forced, open: this.settingsOpen,
        agents: this.agentsReady?.[key] ? (this.agentLists[key] ?? []).filter((a) => a.installed) : null,
        toggle: (cx) => { this.settingsOpen = !this.settingsOpen; cx.notify(); },
        pickAgent: (k, cx) => { this.agent = k; cx.notify(); },
        browse: (cx) => cx.spawn(async (cx) => { const dir = await pickFolder({ prompt: "Use this folder" }).catch(() => null); if (dir) this.repoInput.set_value(dir); cx.notify(); }),
        save: (cx) => this.saveSettings(key, cx),
      },
      source, srcMsg: this.srcMsg,
      machines: { cards: Object.values(this.cards), at: this.cardsAt, loading: this.cardsLoading },
      busyFor: (k) => channel.busyAt(k || null),
      confirmUpgrade: (m, to) => openOverlay({ mod: "sync", kind: "dialog", width: 440, height: 220, props: { role: "upgrade", key: m.on ?? "", label: m.label, from: m.version, to } }),
      agentName: this.agentName(key, c.cfg),
      confirmBoth: (message) => openOverlay({ mod: "sync", kind: "dialog", width: 440, height: 300, props: { role: "srcboth", key, message } }),
      stopped, choices: this.choices,
      pick: (file, side, cx) => { this.choices[file] = side; cx.notify(); },
      pickAll: (side, cx) => { for (const f of stopped?.files ?? []) this.choices[f] = side; cx.notify(); },
    });
  }
}
