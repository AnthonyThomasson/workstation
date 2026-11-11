// What the Skill Artifacts panel lists, with no Herdr import: where the HTML and Markdown reports that
// agents write are looked for, how a scan's output turns into rows, and how rows are matched to a project,
// sorted, filtered and aged. main.js decides when to scan; the tests pass a fake machine.
//   io.sh(script, args, on) -> { code, stdout, stderr }: one exec of a shell script on the space's machine;
//   io.read(path, on) -> text or null: a small text file (used for an HTML report's <title>).

export const WINDOW_DAYS = 7;
export const MAX_ROWS = 200; // per tab, newest first
const TITLE_READS = 30; // HTML files whose <title> is read per scan

export const TABS = [["scratch", "Scratchpads"], ["tmpdir", "$TMPDIR"], ["tmp", "/tmp"], ["runs", "Runs"]];

// Files that Herdr writes into a run folder to brief its agents. They are instructions, not reports.
export const RUN_PROMPTS = ["worker.md", "orchestrator.md", "reviewer.md", "investigator.md", "brief-common.md"];

// ---- Files ----

const base = (path) => String(path).replace(/\/+$/, "").split("/").pop() ?? "";
const clean = (path) => String(path).replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");

// "html", "md", or null when the name is neither (the scans already filter; a stray line must not become a row).
export function kindOf(name) {
  const n = String(name).toLowerCase();
  if (n.endsWith(".html") || n.endsWith(".htm")) return "html";
  if (n.endsWith(".md")) return "md";
  return null;
}

// "mtime-seconds size path" per line, as the scans' stat prints it. Paths may hold spaces, so the path is the rest.
export function parseStat(stdout) {
  const seen = new Set(), out = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const m = /^(\d+) (\d+) (\/.+)$/.exec(line);
    if (!m) continue;
    const path = clean(m[3]), kind = kindOf(path);
    if (!kind || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, name: base(path), kind, mtime: Number(m[1]) * 1000, size: Number(m[2]) });
  }
  return out;
}

// Newest first; the same time sorts by name so the list does not shuffle between scans.
export function sortRows(rows) {
  return [...rows].sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Only rows modified within the window.
export function recent(rows, now, days = WINDOW_DAYS) {
  return rows.filter((r) => now - r.mtime < days * 86400000);
}

// A filter box: every word must appear in the file name or where it came from (any case).
export function filterRows(rows, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = `${r.name} ${r.context ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// "now", "5m", "3h", "2d".
export function age(mtime, now) {
  const s = Math.max(0, Math.round((now - mtime) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// The <title> of an HTML report, or "".
export function htmlTitle(text) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(text ?? "").slice(0, 8192));
  if (!m) return "";
  const t = m[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

// ---- Which project a scratchpad or a run belongs to ----

// Claude Code names a project's folder under /private/tmp/claude-<uid>/ after the project's absolute path
// with every "/" and "." written as "-": /Users/a/.herdr/x -> -Users-a--herdr-x.
export function encodeProject(path) {
  return String(path).replace(/[/.]/g, "-");
}

const trim = (p) => clean(p ?? "");
const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);

// The repo name when path is a Herdr worktree: <home>/.herdr/worktrees/<repo>/<branch folder>.
export function worktreeRepo(path, home) {
  const m = new RegExp(`^${escapeRe(trim(home))}/\\.herdr/worktrees/([^/]+)(?:/|$)`).exec(trim(path));
  return m ? m[1] : null;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Does a Claude project folder (dirName) belong to the active project? folders are the focused terminal's
// folder and the space's folder (either may be empty). It does when the folder:
//   - is the project, or is inside it (the project is an ancestor deeper than the home folder; the home
//     folder itself and above are too broad to count),
//   - contains the project (a repo folder holds its worktrees' scratchpads: dirName starts with the folder's
//     name and "-"; "-" can also be part of a name, so /x/app also matches /x/app-two: a known fuzziness),
//   - or has worktrees under <home>/.herdr/worktrees/<repo>, which is where Herdr puts a repo's worktrees.
// Returns a short label for the row (the project's folder name), or null.
export function matchProject(dirName, folders, home) {
  const h = trim(home), homeEnc = h ? encodeProject(h) : "";
  for (const f0 of folders) {
    const f = trim(f0);
    if (!f.startsWith("/")) continue;
    const enc = encodeProject(f);
    if (dirName === enc) return base(f) || "/";
    if (dirName.startsWith(`${enc}-`)) return dirName.slice(enc.length + 1);
    if (enc.startsWith(`${dirName}-`) && dirName.length > homeEnc.length) return dirName.split("-").pop() || dirName;
    const repo = worktreeRepo(f, h) ?? base(f);
    if (h && repo) {
      const wt = encodeProject(`${h}/.herdr/worktrees/${repo}`);
      if (dirName === wt) return repo;
      if (dirName.startsWith(`${wt}-`)) return dirName.slice(wt.length + 1);
    }
  }
  return null;
}

// Does a workflow run (the pane.json Herdr writes in its folder: { folder, repoRoot, ... }) belong to the active
// project? It does when a folder is the run's worktree or inside it, inside the run's repo, or a sibling worktree
// of the same repo (<home>/.herdr/worktrees/<repo>/<any>).
export function runMatches(run, folders, home) {
  if (!run || typeof run !== "object") return false;
  const rf = typeof run.folder === "string" ? trim(run.folder) : "", rr = typeof run.repoRoot === "string" ? trim(run.repoRoot) : "";
  if (!rf && !rr) return false;
  const rfRepo = rf ? worktreeRepo(rf, home) : null, rrName = rr ? base(rr) : null;
  return folders.some((f0) => {
    const f = trim(f0);
    if (!f.startsWith("/")) return false;
    if (rf && inside(f, rf)) return true;
    if (rr && inside(f, rr)) return true;
    const fRepo = worktreeRepo(f, home);
    if (fRepo && fRepo === rfRepo) return true; // a sibling worktree
    if (fRepo && rrName && fRepo === rrName && rr) return true; // a worktree of the run's repo
    return false;
  });
}

// ---- Scans: the scripts, and what they print ----

const KINDS_FIND = "\\( -iname '*.md' -o -iname '*.html' -o -iname '*.htm' \\)";
const STAT = `-exec sh -c 'stat -f "%m %z %N" "$@" 2>/dev/null || stat -c "%Y %s %n" "$@"' sh {} +`;
const WINDOW = `-mtime -${WINDOW_DAYS}`;
const CLAUDE_BASE = 'u=$(id -u); b="/private/tmp/claude-$u"; [ -d "$b" ] || b="/tmp/claude-$u"';

// Step 1 of Scratchpads: the machine's home folder, then every project folder Claude Code keeps scratchpads for.
export const SCRATCH_PROJECTS = `printf '%s\\n' "$HOME"; ${CLAUDE_BASE}; ls -1 "$b" 2>/dev/null; true`;
// Step 2: the reports in the scratchpads of the chosen project folders ($@): the top level and one folder below.
export const SCRATCH_FILES = `${CLAUDE_BASE}
for p in "$@"; do for s in "$b/$p"/*/scratchpad; do [ -d "$s" ] || continue
find "$s" -maxdepth 2 \\( -name node_modules -o -name .git \\) -prune -o -type f ${KINDS_FIND} ${WINDOW} ${STAT}; done; done; true`;
// $TMPDIR: its top level only. It holds tens of thousands of entries, so it is never walked or globbed.
export const TMPDIR_FILES = `d="\${TMPDIR:-/tmp}"; d="\${d%/}"; find "$d" -maxdepth 1 -type f ${KINDS_FIND} ${WINDOW} ${STAT}; true`;
// /tmp: two levels, without Claude Code's own folder (the scratchpads have their own tab).
export const TMP_FILES = `t=/private/tmp; [ -d "$t" ] || t=/tmp; u=$(id -u)
find "$t" -maxdepth 2 \\( -path "$t/claude-$u" -o -name node_modules -o -name .git \\) -prune -o -type f ${KINDS_FIND} ${WINDOW} ${STAT}; true`;
// Step 1 of Runs: the home folder, then each run folder and its pane.json on one line.
export const RUN_LIST = `printf '%s\\n' "$HOME"
for d in "$HOME"/.herdr/workflow-runs/*/; do d="\${d%/}"; [ -f "$d/pane.json" ] || continue; printf '%s\\t' "$d"; tr -d '\\n' < "$d/pane.json"; printf '\\n'; done; true`;
// Step 2: the .md files in the chosen run folders ($@).
export const RUN_FILES = `for d in "$@"; do find "$d" -maxdepth 1 -type f -iname '*.md' ${WINDOW} ${STAT}; done; true`;

// The first line is $HOME; the rest are the script's lines.
export function splitHome(stdout) {
  const lines = String(stdout ?? "").split("\n");
  return { home: (lines.shift() ?? "").trim(), lines: lines.filter(Boolean) };
}

// { run id: { id, dir, folder, repoRoot, title } } for pane.json lines "dir<TAB>json".
export function parseRuns(lines) {
  const out = [];
  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const dir = line.slice(0, tab);
    let j;
    try { j = JSON.parse(line.slice(tab + 1)); } catch { continue; }
    if (!j || typeof j !== "object" || Array.isArray(j)) continue;
    out.push({ dir, id: base(dir), folder: j.folder, repoRoot: j.repoRoot, title: typeof j.title === "string" ? j.title : "" });
  }
  return out;
}

// /private/tmp/claude-501/<project>/<session>/scratchpad/<rel> -> { project, session, rel } or null.
export function parseScratchPath(path) {
  const m = /^\/(?:private\/)?tmp\/claude-\d+\/([^/]+)\/([^/]+)\/scratchpad\/(.+)$/.exec(path);
  return m ? { project: m[1], session: m[2], rel: m[3] } : null;
}

const ran = (r, what) => (r && r.code === 0 ? null : `${what} failed${r?.stderr ? `: ${String(r.stderr).trim().split("\n").pop()}` : ""}`);

async function withTitles(io, on, rows) {
  const html = rows.filter((r) => r.kind === "html").slice(0, TITLE_READS);
  await Promise.all(html.map(async (r) => {
    try { r.subtitle = htmlTitle(await io.read(r.path, on)); } catch { r.subtitle = ""; }
  }));
  return rows;
}

function finish(rows, now) {
  return sortRows(recent(rows, now)).slice(0, MAX_ROWS);
}

// One tab's rows: { rows, error }. `folders` are the focused terminal's folder and the space's folder.
export async function scan(io, tab, { on = null, folders = [], now = Date.now() } = {}) {
  if (tab === "scratch") {
    const first = await io.sh(SCRATCH_PROJECTS, [], on);
    const err = ran(first, "Listing scratchpads");
    if (err) return { rows: [], error: err };
    const { home, lines } = splitHome(first.stdout);
    const wanted = lines.map((dir) => ({ dir, label: matchProject(dir, folders, home) })).filter((p) => p.label);
    if (!wanted.length) return { rows: [], error: null };
    const labels = new Map(wanted.map((p) => [p.dir, p.label]));
    const r = await io.sh(SCRATCH_FILES, wanted.map((p) => p.dir), on);
    const rows = parseStat(r.stdout).flatMap((f) => {
      const s = parseScratchPath(f.path);
      if (!s || !labels.has(s.project)) return [];
      return [{ ...f, name: s.rel, base: f.name, tab, context: `${labels.get(s.project)} · ${s.session.slice(0, 8)}` }];
    });
    return { rows: await withTitles(io, on, finish(rows, now)), error: ran(r, "Reading scratchpads") };
  }
  if (tab === "tmpdir") {
    const r = await io.sh(TMPDIR_FILES, [], on);
    const rows = parseStat(r.stdout).map((f) => ({ ...f, base: f.name, tab, context: "$TMPDIR" }));
    return { rows: await withTitles(io, on, finish(rows, now)), error: ran(r, "Reading $TMPDIR") };
  }
  if (tab === "tmp") {
    const r = await io.sh(TMP_FILES, [], on);
    const rows = parseStat(r.stdout).map((f) => {
      const dir = f.path.replace(/^\/private/, "").replace(/\/[^/]*$/, "");
      return { ...f, base: f.name, tab, context: dir || "/tmp" };
    });
    return { rows: await withTitles(io, on, finish(rows, now)), error: ran(r, "Reading /tmp") };
  }
  if (tab === "runs") {
    const first = await io.sh(RUN_LIST, [], on);
    const err = ran(first, "Listing runs");
    if (err) return { rows: [], error: err };
    const { home, lines } = splitHome(first.stdout);
    const mine = parseRuns(lines).filter((run) => runMatches(run, folders, home));
    if (!mine.length) return { rows: [], error: null };
    const byDir = new Map(mine.map((run) => [run.dir, run]));
    const r = await io.sh(RUN_FILES, mine.map((run) => run.dir), on);
    const rows = parseStat(r.stdout).flatMap((f) => {
      if (RUN_PROMPTS.includes(f.name)) return [];
      const run = byDir.get(f.path.replace(/\/[^/]*$/, ""));
      return run ? [{ ...f, base: f.name, tab, context: run.title || run.id }] : [];
    });
    return { rows: finish(rows, now), error: ran(r, "Reading runs") };
  }
  return { rows: [], error: null };
}

// The folders a scan is matched against: the focused terminal's folder first, then the space's, no repeats.
export function scanFolders(cwd, spaceFolder) {
  return [...new Set([cwd, spaceFolder].filter((f) => typeof f === "string" && f.startsWith("/")).map(trim))];
}
