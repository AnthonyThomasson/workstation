// The bar under the workspace: this computer or machine, the branch, the agents that need you, and
// "Sync both ways" for the workstation repo. It is untethered from skillshare and its panel: the bar
// reads the repo's git state and syncs it itself (commit, pull, push), and reports the result as a
// notification. The button reads "Working…" meanwhile.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, exec, notify } from "herdr";

const POLL = 20000;
const REPO = "$HOME/Documents/projects.nosync/workstation"; // the workstation repo
const COMMIT = "Update workstation from Herdr";
const PATHS = 'PATH="$HOME/.local/bin:$HOME/go/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH; GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT';
// "norepo", or "top <path>" then the branch line and the changed files.
const GIT_STATUS = `cd "$REPO" 2>/dev/null || { echo norepo; exit 0; }
top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo norepo; exit 0; }
cd "$top"
echo "top $top"
git status --porcelain=v1 --branch --untracked-files=all`;
// Commit what changed, pull the remote's commits under ours, push. A conflict is undone, not left half done.
const SYNC = `cd "$REPO" || { echo "The workstation repo was not found"; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  git add -A && git commit -q -m "${COMMIT}" || exit 1
fi
if ! git pull --rebase --autostash -q; then git rebase --abort 2>/dev/null; echo "Pull stopped: both sides changed the same files. Nothing was pushed."; exit 2; fi
git push -q`;

// Machines currently syncing: "" is this computer.
const syncing = new Set();

const sh = (script, on) => exec("sh", ["-c", `${PATHS}\nREPO="${REPO}"\n${script}`, "status-bar"], { on })
  .catch((e) => ({ code: 127, stdout: "", stderr: String(e.message ?? e) }));

const parseJSON = (text) => { try { return JSON.parse(text); } catch { return null; } };

// The repo's git state: { repo, top, branch,
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

// The repo's git state on machine on (null: this computer).
const readGit = async (on) => parseGit((await sh(GIT_STATUS, on)).stdout);

// The repo's line: what is uncommitted and how far it is from
// its remote. warn when changes are uncommitted or a pull is due.
function sourceLine(git) {
  if (!git) return { text: "Workstation · checking…", warn: false };
  if (!git.repo) return { text: "Workstation · not a git repository", warn: false };
  const parts = [];
  if (git.files.length) parts.push(`${git.files.length} uncommitted`);
  if (git.ahead) parts.push(`↑${git.ahead}`);
  if (git.behind) parts.push(`↓${git.behind}`);
  if (!git.upstream) parts.push("no remote");
  return { text: `Workstation · ${parts.length ? parts.join(" · ") : "up to date"}`, warn: Boolean(git.files.length || git.behind) };
}

const busyAt = (on) => syncing.has(on ?? "");

const icon = (path, size, color) => svg(path).size(size).flex_none().text_color(color);
const label = (name, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${name}.svg`).size(13)).child(text);
// Work started from render runs after the render ends: cx.notify() throws while a view renders.
const later = (cx, fn) => cx.spawn(async (cx) => { await cx.sleep(0); return fn(cx); });

// The repo's line: plain text, nothing to click.
function sourceLink(t, git) {
  const line = sourceLine(git), color = line.warn ? t.blocked : t.muted;
  return h_flex().id("source").min_w(0).h(22).px(6).gap(6).flex_shrink_1().items_center().text_color(color)
    .child(icon("mods/status-bar/icons/git.svg", 13, color)).child(div().min_w(0).truncate().child(line.text));
}

// Enabled when the repo has a remote and nothing is running; otherwise it says so.
function syncButton(t, git, busy, onSync) {
  const base = h_flex().id("sync-both").h(22).px(8).gap(6).flex_none().items_center().rounded(6);
  if (busy) return base.text_color(t.working).child(icon("mods/status-bar/icons/ring.svg", 12, t.working).spin(900)).child("Working…");
  if (!git?.repo || !git.upstream) return base.text_color(t.dim).child(icon("mods/status-bar/icons/both.svg", 12, t.dim)).child("Sync both ways");
  return base.text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.selected).text_color(t.foreground))
    .on_click(onSync)
    .child(icon("mods/status-bar/icons/both.svg", 12, t.muted)).child("Sync both ways");
}

export default class StatusBar extends View {
  init(_props, cx) {
    this.key = null; this.git = null; this.token = 0;
    cx.timer.every(POLL, (cx) => { if (this.key !== null && !busyAt(this.key || null)) this.load(cx); });
  }

  // Commits, pulls and pushes the repo on the machine the bar is showing, then reads it again.
  sync(cx) {
    const on = this.key || null, k = on ?? "";
    if (syncing.has(k)) return;
    syncing.add(k);
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try { r = await sh(SYNC, on); } catch (e) { r = { code: 1, stdout: "", stderr: String(e?.message ?? e) }; }
      syncing.delete(k);
      try { cx.notify(); } catch {} // redraw first: the button leaves "Working…" whatever happens next
      try {
        const text = String(r.stderr || r.stdout || "").trim().split("\n").pop();
        if (r.code === 0) notify({ title: "Synced both ways", body: "The workstation repo is committed, pulled and pushed.", level: "success" });
        else notify({ title: "Sync failed", body: text || `git exited with ${r.code}`, level: "error" });
      } catch {}
      this.load(cx);
    });
  }

  // Reads the repo for the machine the bar is showing. A newer read wins over an older one.
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
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(sourceLink(t, this.git))
      .child(syncButton(t, this.git, busy, (_e, cx) => this.sync(cx)));
  }
}
