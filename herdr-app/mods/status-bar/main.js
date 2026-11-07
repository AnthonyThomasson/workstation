// The bar under the workspace: this computer or machine, the branch, the agents that need you, and
// "Sync both ways" for the skillshare source, which stays here whatever panel is shown. The bar reads
// the source's git state itself, because the skillshare panel only looks while it is shown. Clicking
// opens skillshare's sync dialog; confirming it shows the panel, where the sync's progress and any
// conflict appear.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, exec, openOverlay, shared } from "herdr";

const POLL = 20000;
const BUSY = "skillshare.busy.v1"; // skillshare's per-machine locks (its channel.js); "" is this computer
const BUSY_MS = 60 * 1000; // a lock untouched this long is gone
// The PATH skillshare's panel runs its commands with.
const PATHS = 'PATH="$HOME/.local/bin:$HOME/go/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH';
// The repo holding the source: "norepo", or "top <path>" then the branch line and the changed files.
// The same script as skillshare's panel (its GIT_STATUS), without a fetch.
const GIT_STATUS = `cd "$1" 2>/dev/null || { echo norepo; exit 0; }
top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo norepo; exit 0; }
cd "$top"
echo "top $top"
git status --porcelain=v1 --branch --untracked-files=all`;

const sh = (script, args, on) => exec("sh", ["-c", `${PATHS}\n${script}`, "status-bar", ...args], { on })
  .catch((e) => ({ code: 127, stdout: "", stderr: String(e.message ?? e) }));

const parseJSON = (text) => { try { return JSON.parse(text); } catch { return null; } };

// The source's git state, in the shape skillshare's Source dialog reads: { repo, top, branch,
// upstream, ahead, behind, files: [{ code, path }] }; null when the read failed.
function parseGit(text) {
  const lines = String(text ?? "").split("\n");
  if (lines[0]?.trim() === "norepo") return { repo: false };
  const out = { repo: true, top: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  for (const line of lines) {
    if (line.startsWith("top ")) out.top = line.slice(4);
    else if (line.startsWith("## ")) {
      const m = line.slice(3).match(/^(?:No commits yet on )?(\S+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
      if (m) {
        out.branch = m[1]; out.upstream = m[2] ?? null;
        out.ahead = Number(m[3]?.match(/ahead (\d+)/)?.[1] ?? 0); out.behind = Number(m[3]?.match(/behind (\d+)/)?.[1] ?? 0);
      }
    } else if (line.length > 3) out.files.push({ code: line.slice(0, 2).trim() || "?", path: line.slice(3) });
  }
  return out.top ? out : null;
}

// The source's git state on machine on (null: this computer).
async function readGit(on) {
  const st = parseJSON((await sh("skillshare status --json -g", [], on)).stdout);
  const path = st?.source?.path;
  return path ? parseGit((await sh(GIT_STATUS, [path], on)).stdout) : { repo: false };
}

// The source's line, as the skillshare panel wrote it: what is uncommitted and how far it is from
// its remote. warn when changes are uncommitted or a pull is due.
function sourceLine(git) {
  if (!git) return { text: "Source · checking…", warn: false };
  if (!git.repo) return { text: "Source · not a git repository", warn: false };
  const parts = [];
  if (git.files.length) parts.push(`${git.files.length} uncommitted`);
  if (git.ahead) parts.push(`↑${git.ahead}`);
  if (git.behind) parts.push(`↓${git.behind}`);
  if (!git.upstream) parts.push("no remote");
  return { text: `Source · ${parts.length ? parts.join(" · ") : "up to date"}`, warn: Boolean(git.files.length || git.behind) };
}

// Whether skillshare holds machine on's lock: a sync, install or update is running there.
function busyAt(on) {
  const b = shared(BUSY), lock = b && typeof b === "object" && !Array.isArray(b) ? b[on ?? ""] : null;
  return Boolean(lock && Date.now() - lock.at < BUSY_MS);
}

const icon = (path, size, color) => svg(path).size(size).flex_none().text_color(color);
const label = (name, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${name}.svg`).size(13)).child(text);
// Work started from render runs after the render ends: cx.notify() throws while a view renders.
const later = (cx, fn) => cx.spawn(async (cx) => { await cx.sleep(0); return fn(cx); });

// The source's line. A click opens skillshare's Source dialog (commit, pull, push); nothing opens while it is checked.
function sourceLink(t, on, git) {
  const line = sourceLine(git), color = line.warn ? t.blocked : t.muted;
  return h_flex().id("source").min_w(0).h(22).px(6).gap(6).flex_shrink_1().items_center().rounded(6).text_color(color)
    .when(Boolean(git), (el) => el.cursor_pointer().hover((s) => s.bg(t.selected))
      .on_click(() => openOverlay({ mod: "skillshare", kind: "dialog", width: 480, height: 520, props: { role: "source", on, git } })))
    .child(icon("mods/skillshare/icons/git.svg", 13, color)).child(div().min_w(0).truncate().child(line.text));
}

// Enabled when the source is a git repo with a remote and nothing is running; otherwise it says so.
function syncButton(t, on, git, busy) {
  const base = h_flex().id("sync-both").h(22).px(8).gap(6).flex_none().items_center().rounded(6);
  if (busy) return base.text_color(t.working).child(icon("mods/skillshare/icons/ring.svg", 12, t.working).spin(900)).child("Working…");
  if (!git?.repo || !git.upstream) return base.text_color(t.dim).child(icon("mods/skillshare/icons/both.svg", 12, t.dim)).child("Sync both ways");
  return base.text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.selected).text_color(t.foreground))
    .on_click(() => openOverlay({ mod: "skillshare", kind: "dialog", width: 460, height: 360, props: { role: "syncboth", on, repo: git.top } }))
    .child(icon("mods/skillshare/icons/both.svg", 12, t.muted)).child("Sync both ways");
}

export default class StatusBar extends View {
  init(_props, cx) {
    this.key = null; this.git = null; this.token = 0; this.wasBusy = false;
    cx.timer.every(POLL, (cx) => { if (this.key !== null && !busyAt(this.key || null)) this.load(cx); });
  }

  // Reads the source for the machine the bar is showing. A newer read wins over an older one.
  load(cx) {
    const on = this.key || null, token = ++this.token;
    cx.spawn(async (cx) => {
      const git = await readGit(on).catch(() => null);
      if (token !== this.token) return;
      this.git = git; cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents(), needs = list.filter((a) => a.status === "blocked").length;
    const key = space?.machine ?? "";
    if (this.key !== key) { this.key = key; this.git = null; later(cx, (cx) => this.load(cx)); }
    const busy = busyAt(key || null);
    if (this.wasBusy && !busy) later(cx, (cx) => this.load(cx)); // a sync just ended: read the source again
    this.wasBusy = busy;
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(sourceLink(t, key || null, this.git))
      .child(syncButton(t, key || null, this.git, busy));
  }
}
