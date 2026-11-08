// Sync: keeps Herdr's config folder in step with the repo you linked, from an icon in the tab bar. One way (the repo
// wins), automatic, no settings. Running mods/sync/sync.sh from a clone links that clone (it writes sync.json in Herdr's
// config folder); this mod reads that file on this computer and does the rest.
// The icon is a circular arrow: dim with no repo linked, muted normally, foreground while its panel is open, red
// (theme().blocked) when the last sync failed, spinning while it syncs. Click it to open or close the Details panel in
// the layout's right-hand panel column: the branch and folder being synced, the linked remote, when it last synced, and
// Force sync.
// A watcher on the picked folder syncs once nothing has changed for 3 s (queue.js decides when; a sync's own writes and
// anything git ignores are not changes). Force sync, and switching branch or worktree, sync right away.
// Roles (props.role): the button (default), always mounted: it owns the link, the watcher and every sync; "details"
// (the panel the button shows). The panel is a separate view whose tasks end when it hides, so it hands work to the
// button through channel.js; results come back as shared state (link, pick, run).
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, run, layout, shared, setShared, theme, notify, readTextFile, watchFolder, appHome, home, props as blockProps } from "herdr";
import { parseSyncJson, nextPick, viewState, statusLine, relativeTo } from "./model.js";
import { readLink, syncFolder, snapshot, unignored, listTargets, switchBranch, PATHS } from "./ops.js";
import { createRunner } from "./jobs.js";
import { createChannel } from "./channel.js";
import { createSyncQueue, isGitInternal } from "./queue.js";
import { renderDetails } from "./details.js";
import { icon, stop, later } from "./ui.js";

const LINK = "sync.link.v2"; // { linked, repo, remote, dir, branch }: what sync.json names, the picked folder and its branch
const PICK = "sync.pick.v2"; // { repo, dir }: the picked worktree ("" = the repo itself), forgotten when the linked repo changes
const RUN = "sync.run.v2"; // { syncing, ok, message, at, watching, watchError }: the last sync and the watcher
const REFRESH_EVERY = 5 * 1000, LABEL_EVERY = 2 * 1000, WHERE_EVERY = 20 * 1000, WATCH_RETRY = 15 * 1000, MAX_CHECKED = 2000;

const channel = createChannel({ get: (k) => shared(k), set: (k, v) => setShared(k, v) });
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const setRun = (patch) => setShared(RUN, { ...obj(shared(RUN)), ...patch });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Everything that can be slow (the sync script) runs as a detached job that is polled (jobs.js), because Herdr stops an
// exec after 30 s. The runner adds the usual PATH.
const runner = createRunner({
  exec: (script, args) => exec("sh", ["-c", `${PATHS}\n${script}`, "sync", ...args]).catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) })),
  readText: (path) => readTextFile(path),
});
const shortIO = { sh: (script, args) => runner.sh(script, args) };
const jobIO = (cx) => ({ sh: shortIO.sh, job: (script, args) => runner.job(args, { script, sleep: (ms) => cx.sleep(ms) }) });

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

  // ================= The button: the link, the watcher, every sync =================

  initButton(cx) {
    this.cx = cx; this.nextRequest = channel.listen();
    this.dir = null; this.baseline = null; this.epoch = 0; this.watchGen = 0; this.forced = false;
    this.incoming = []; this.draining = false; this.timers = new Set(); this.timerId = 0;
    this.queue = createSyncQueue({
      sync: () => this.syncNow(),
      changed: async () => { const s = await snapshot(shortIO, this.dir); return !s || s !== this.baseline; },
      // Herdr views have cx.sleep, not setTimeout.
      setTimer: (fn, ms) => {
        const id = ++this.timerId; this.timers.add(id);
        this.cx.spawn(async (cx) => { await cx.sleep(ms); if (this.timers.delete(id)) fn(); });
        return id;
      },
      clearTimer: (id) => this.timers.delete(id),
    });
    // A sync that copies this mod's own files makes Herdr reload the mod mid-sync; the new instance cannot see that sync's
    // result, so it must not show "Syncing…" for ever.
    if (obj(shared(RUN)).syncing) setRun({ syncing: false });
    later(cx, (cx) => this.refresh(cx));
    cx.timer.every(REFRESH_EVERY, (cx) => { this.cx = cx; this.refresh(cx); });
  }

  // Reads sync.json and the repo it names (this computer only). Newer reads win over older ones. The linked repo is the
  // one remembered, as long as sync.json names it or one of its worktrees: running the script from a worktree rewrites
  // sync.json to that worktree and must not unlink the repo or reset the pick (ops.js LINK).
  refresh(cx) {
    const mine = ++this.epoch;
    return cx.spawn(async () => {
      let link = { linked: false };
      try {
        const file = parseSyncJson(await readTextFile(`${appHome()}/sync.json`).catch(() => null));
        if (file) {
          const prev = obj(shared(LINK)), stored = prev.linked ? prev.repo : "";
          const pick = obj(shared(PICK));
          const info = await readLink(shortIO, { file: file.repo, stored, pick: pick.repo === stored ? pick.dir ?? "" : "" });
          if (!info.gone) {
            link = { linked: true, repo: info.repo, remote: file.remote, dir: info.dir, branch: info.branch };
            const next = nextPick(pick, info.repo);
            next.dir = info.dir === info.repo ? "" : info.dir;
            if (!same(next, pick)) setShared(PICK, next);
          }
        }
      } catch { return; } // keep what we knew
      if (mine !== this.epoch) return;
      if (!same(link, shared(LINK))) setShared(LINK, link);
      this.useDir(link.linked ? link.dir : null);
    });
  }

  // The folder being synced and watched changed (or went away).
  useDir(dir) {
    if (dir === this.dir) return;
    this.dir = dir; this.baseline = null; this.incoming = [];
    this.queue.stop();
    const gen = ++this.watchGen;
    if (!dir) { setRun({ watching: false, watchError: "" }); return; }
    setRun({ watching: true, watchError: "" });
    this.cx.spawn(async (cx) => {
      this.baseline = await snapshot(shortIO, dir).catch(() => null) || null;
      while (gen === this.watchGen) {
        try {
          const batch = await watchFolder(dir);
          if (gen !== this.watchGen) return;
          if (!obj(shared(RUN)).watching) setRun({ watching: true, watchError: "" });
          this.incoming.push(...batch);
          this.drain(dir);
        } catch (e) {
          if (gen !== this.watchGen) return;
          setRun({ watching: false, watchError: String(e?.message ?? e).split("\n")[0].slice(0, 80) });
          await cx.sleep(WATCH_RETRY);
        }
      }
    });
  }

  // Watcher batches: drop .git/ and git-ignored paths (one git call at a time, later batches wait in `incoming`), hand the rest to the queue.
  async drain(dir) {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.incoming.length) {
        const rels = [...new Set(this.incoming.splice(0).map((p) => relativeTo(dir, p)))].filter((p) => !isGitInternal(p));
        if (!rels.length || dir !== this.dir) continue;
        const keep = rels.includes("") || rels.length > MAX_CHECKED ? rels : await unignored(shortIO, dir, rels);
        if (dir === this.dir && keep.length) this.queue.change(keep);
      }
    } finally { this.draining = false; }
  }

  // One sync of the picked folder, run by the queue (never two at once). The folder's content right afterwards is the
  // baseline the next quiet-period check compares with, so the script's own writes into the repo are not changes.
  syncNow() {
    return new Promise((resolve) => this.cx.spawn(async (cx) => {
      const dir = this.dir, forced = this.forced; this.forced = false;
      try {
        if (!dir) return;
        setRun({ syncing: true });
        let out;
        try { out = await syncFolder(jobIO(cx), dir); }
        catch (e) { out = { result: "error", message: String(e?.message ?? e) }; }
        this.baseline = dir === this.dir ? await snapshot(shortIO, dir).catch(() => null) || null : null;
        const ok = out.result === "ok", prev = obj(shared(RUN));
        setRun({ syncing: false, ok, message: ok ? "" : out.message || "The sync script stopped.", at: ok ? Date.now() : prev.at ?? null });
        if (!ok) notify({ title: "Sync failed", body: out.message || "The script stopped.", level: "error" });
        else if (forced) notify({ title: "Sync done", body: out.message || "Done", level: "success" });
      } finally { setRun({ syncing: false }); cx.notify(); resolve(); }
    }));
  }

  render_requests(cx) {
    const req = this.nextRequest();
    if (req) later(cx, (cx) => this.perform(req, cx));
  }

  perform(req, cx) {
    this.cx = cx;
    const link = obj(shared(LINK));
    if (!link.linked) return;
    if (req.op === "force") { this.forced = true; this.queue.force(); return; }
    if (req.op === "pick") {
      const dir = String(req.dir ?? "");
      if (!dir || dir === this.dir) return;
      setShared(PICK, { repo: link.repo, dir: dir === link.repo ? "" : dir });
      setShared(LINK, { ...link, dir, branch: "" });
      this.useDir(dir);
      this.refresh(cx);
      this.queue.force();
      return;
    }
    if (req.op === "switch") {
      return cx.spawn(async () => {
        const out = await switchBranch(shortIO, link.dir, String(req.branch ?? ""));
        if (out.result !== "ok") { notify({ title: "Switch failed", body: out.message || "git said no.", level: "error" }); return; }
        this.refresh(cx);
        this.queue.force();
      });
    }
  }

  renderButton(cx) {
    this.cx = cx;
    const t = theme(), on = shownHere();
    this.render_requests(cx);
    const link = shared(LINK), runState = shared(RUN), kind = viewState({ link, run: runState });
    const tip = {
      loading: "Sync: checking…", unlinked: "Sync: no repo linked. Run mods/sync/sync.sh from your clone.",
      busy: "Sync: syncing…", error: `Sync: ${runState?.message || "the last sync failed"}`, ok: `Sync: ${statusLine(runState)}`,
    }[kind];
    const tint = kind === "error" ? t.blocked : kind === "unlinked" || kind === "loading" ? t.dim : on ? t.foreground : t.muted;
    const glyph = icon("sync", 16, tint);
    const spinning = kind === "busy" ? glyph.spin(900) : glyph;
    return h_flex().size_full().pr(8).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("sync-button").tooltip(tip).h(30).w(34).flex_none().items_center().justify_center().rounded(6)
        .bg(on ? t.selected : t.chrome).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          if (on) run("layout.hide", { id: PANEL });
          else { showPanel(); this.refresh(cx); }
        })
        .child(div().relative().size_full().flex().items_center().justify_center()
          .child(div().size(16).flex_none().child(spinning))));
  }

  // ================= The Details panel =================

  initDetails(cx) {
    this.where = null; this.whereAt = 0; this.whereKey = ""; this.reading = false; this.open = false;
    // A shown panel renders this often, which keeps "Synced 12s ago" and the branch list fresh; a hidden panel reads nothing.
    cx.timer.every(LABEL_EVERY, (cx) => cx.notify());
  }

  // Reads the repo's worktrees and branches (from the linked repo, so every worktree stays listed).
  readWhere(cx, repo) {
    if (this.reading || !repo) return;
    this.reading = true;
    return cx.spawn(async (cx) => {
      try { this.where = await listTargets(shortIO, repo); this.whereAt = Date.now(); }
      catch { /* keep the last list */ }
      finally { this.reading = false; cx.notify(); }
    });
  }

  renderDetailsTab(cx) {
    const t = theme(), link = shared(LINK), runState = shared(RUN), kind = viewState({ link, run: runState });
    if (link?.linked) {
      const key = `${link.repo}|${link.dir}|${link.branch}`;
      if (!this.reading && (key !== this.whereKey || Date.now() - this.whereAt > WHERE_EVERY - 3000)) {
        this.whereKey = key; later(cx, (cx) => this.readWhere(cx, link.repo));
      }
    }
    return renderDetails({
      t, kind, link, run: runState, now: Date.now(), home: home(), where: this.where, open: this.open,
      toggle: (cx) => { this.open = !this.open; cx.notify(); },
      request: (op) => channel.request(op),
      close: find(layout(), PANEL) ? () => run("layout.hide", { id: PANEL }) : null,
    });
  }
}
