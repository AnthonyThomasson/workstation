// What the Skill Artifacts panel lists, with no Herdr import: where the HTML reports that agents write are
// looked for, how a scan's output turns into rows (skipping HTML that sits in a cloned repo or test output), and
// how scratchpads are matched to a project, sorted, filtered and aged. main.js decides when to scan; the tests pass a fake machine.
//   io.sh(script, args, on) -> { code, stdout, stderr }: one exec of a shell script on the space's machine;
//   io.read(path, on) -> text or null: the top of a text file (used for an HTML report's <title>).

export const WINDOW_DAYS = 7;
export const MAX_ROWS = 200; // newest first, all sources together
const TITLE_READS = 60; // HTML files whose <title> is read per scan (the newest)

// ---- Files ----

const base = (path) => String(path).replace(/\/+$/, "").split("/").pop() ?? "";
const clean = (path) => String(path).replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");

// Is this an HTML report's file name? (the scans already filter; a stray line must not become a row)
export function isHtml(name) {
  const n = String(name).toLowerCase();
  return n.endsWith(".html") || n.endsWith(".htm");
}

// "mtime-seconds size path" per line, as the scans' stat prints it. Paths may hold spaces, so the path is the rest.
export function parseStat(stdout) {
  const seen = new Set(), out = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const m = /^(\d+) (\d+) (\/.+)$/.exec(line);
    if (!m) continue;
    const path = clean(m[3]);
    if (!isHtml(path) || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, name: base(path), mtime: Number(m[1]) * 1000, size: Number(m[2]) });
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

// A filter box: every word must appear in the title, the file name or where it came from (any case).
export function filterRows(rows, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = `${r.title ?? ""} ${r.name} ${r.base ?? ""} ${r.context ?? ""}`.toLowerCase();
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

// ---- Which project a scratchpad belongs to ----

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


// ---- Cloned sources and test output are not reports ----

// A folder name that is test or build output, or hidden: GdUnit's report_<n>, test-report, test-results, coverage,
// htmlcov, playwright-report, allure-report, lcov-report, junit, build, dist, target, node_modules, ".git" and the like.
export const NOISE_DIR = /^(report_\d+|test[-_ ]?(reports?|results?|output)|(playwright|allure|lcov|junit)[-_ ]?(reports?|results?)?|coverage|htmlcov|build|dist|target|node_modules|\..*)$/i;
// Files whose presence in a folder says it is a checkout (or an installed project): a sibling of the HTML file.
export const CHECKOUT_MARKERS = [".git", "package.json", "node_modules"];

// "M <path of a marker>" lines the scans print for markers found one folder below a source's top. The folders they sit in.
export function parseMarkers(stdout) {
  const out = new Set();
  for (const line of String(stdout ?? "").split("\n")) {
    const m = /^M (\/.+)$/.exec(line);
    if (m) out.add(clean(m[1]).replace(/\/[^/]*$/, ""));
  }
  return out;
}

// An HTML file in a subfolder (rel, its path below the source's top, has a "/") is skipped when a folder on the way is
// noise by name, or holds a marker. Files at the top of a source are never skipped.
export function skipReport(path, rel, markers) {
  const dirs = String(rel).split("/").slice(0, -1);
  if (!dirs.length) return false;
  let dir = path.slice(0, path.length - rel.length - 1);
  for (const d of dirs) {
    dir = `${dir}/${d}`;
    if (NOISE_DIR.test(d) || markers.has(dir)) return true;
  }
  return false;
}

// ---- Scans: the scripts, and what they print ----

const KINDS_FIND = "\\( -iname '*.html' -o -iname '*.htm' \\)";
const STAT = `-exec sh -c 'stat -c "%Y %s %n" "$@" 2>/dev/null || stat -f "%m %z %N" "$@"' sh {} +`;
const WINDOW = `-mtime -${WINDOW_DAYS}`;
// One level below a source's top: a .git, package.json or node_modules there marks that folder a checkout.
const MARKERS = (top) => `find ${top} -mindepth 2 -maxdepth 2 \\( -name .git -o -name package.json -o -name node_modules \\) -exec printf 'M %s\\n' {} +`;
const CLAUDE_BASE = 'u=$(id -u); b="/private/tmp/claude-$u"; [ -d "$b" ] || b="/tmp/claude-$u"';

// Step 1 of the scratchpads: the machine's home folder, then every project folder Claude Code keeps scratchpads for.
export const SCRATCH_PROJECTS = `printf '%s\\n' "$HOME"; ${CLAUDE_BASE}; ls -1 "$b" 2>/dev/null; true`;
// Step 2: the HTML in the scratchpads of the chosen project folders ($@): the top level and one folder below.
export const SCRATCH_FILES = `${CLAUDE_BASE}
for p in "$@"; do for s in "$b/$p"/*/scratchpad; do [ -d "$s" ] || continue
find "$s" -maxdepth 2 \\( -name node_modules -o -name .git \\) -prune -o -type f ${KINDS_FIND} ${WINDOW} ${STAT}
${MARKERS('"$s"')}; done; done; true`;
// $TMPDIR: its top level only. It holds tens of thousands of entries, so it is never walked or globbed.
export const TMPDIR_FILES = `d="\${TMPDIR:-/tmp}"; d="\${d%/}"; find "$d" -maxdepth 1 -type f ${KINDS_FIND} ${WINDOW} ${STAT}; true`;
// /tmp: two levels, without Claude Code's own folder (the scratchpads are listed on their own).
export const TMP_FILES = `t=/private/tmp; [ -d "$t" ] || t=/tmp; u=$(id -u)
find "$t" -maxdepth 2 \\( -path "$t/claude-$u" -o -name node_modules -o -name .git \\) -prune -o -type f ${KINDS_FIND} ${WINDOW} ${STAT}
find "$t" -mindepth 2 -maxdepth 2 -path "$t/claude-$u" -prune -o \\( -name .git -o -name package.json -o -name node_modules \\) -exec printf 'M %s\\n' {} +; true`;

// The first line is $HOME; the rest are the script's lines.
export function splitHome(stdout) {
  const lines = String(stdout ?? "").split("\n");
  return { home: (lines.shift() ?? "").trim(), lines: lines.filter(Boolean) };
}

// /private/tmp/claude-501/<project>/<session>/scratchpad/<rel> -> { project, session, rel } or null.
export function parseScratchPath(path) {
  const m = /^\/(?:private\/)?tmp\/claude-\d+\/([^/]+)\/([^/]+)\/scratchpad\/(.+)$/.exec(path);
  return m ? { project: m[1], session: m[2], rel: m[3] } : null;
}

const ran = (r, what) => (r && r.code === 0 ? null : `${what} failed${r?.stderr ? `: ${String(r.stderr).trim().split("\n").pop()}` : ""}`);

// Titles by machine|path|mtime|size: a scan every 20 seconds reads a file again only when it changed.
const titles = new Map();
const TITLE_CACHE = 1000;
async function withTitles(io, on, rows) {
  await Promise.all(rows.slice(0, TITLE_READS).map(async (r) => {
    const key = `${on ?? ""}|${r.path}|${r.mtime}|${r.size}`;
    if (!titles.has(key)) {
      let text = null;
      try { text = await io.read(r.path, on); } catch { /* unreadable: no title, and try again next scan */ }
      if (text == null) { r.title = ""; return; }
      if (titles.size >= TITLE_CACHE) titles.clear();
      titles.set(key, htmlTitle(text));
    }
    r.title = titles.get(key);
  }));
  return rows;
}

// Each source: { rows, error } before titles; rows already skip cloned sources and test output.
async function scanScratch(io, { on, folders }) {
  const first = await io.sh(SCRATCH_PROJECTS, [], on);
  const err = ran(first, "Listing scratchpads");
  if (err) return { rows: [], error: err };
  const { home, lines } = splitHome(first.stdout);
  const wanted = lines.map((dir) => ({ dir, label: matchProject(dir, folders, home) })).filter((p) => p.label);
  if (!wanted.length) return { rows: [], error: null };
  const labels = new Map(wanted.map((p) => [p.dir, p.label]));
  const r = await io.sh(SCRATCH_FILES, wanted.map((p) => p.dir), on);
  const markers = parseMarkers(r.stdout);
  const rows = parseStat(r.stdout).flatMap((f) => {
    const s = parseScratchPath(f.path);
    if (!s || !labels.has(s.project) || skipReport(f.path, s.rel, markers)) return [];
    return [{ ...f, name: s.rel, base: f.name, context: `${labels.get(s.project)} · ${s.session.slice(0, 8)}` }];
  });
  return { rows, error: ran(r, "Reading scratchpads") };
}

async function scanTmpdir(io, { on }) {
  const r = await io.sh(TMPDIR_FILES, [], on);
  return { rows: parseStat(r.stdout).map((f) => ({ ...f, base: f.name, context: "$TMPDIR" })), error: ran(r, "Reading $TMPDIR") };
}

async function scanTmp(io, { on }) {
  const r = await io.sh(TMP_FILES, [], on);
  const markers = parseMarkers(r.stdout);
  const rows = parseStat(r.stdout).flatMap((f) => {
    const m = /^((?:\/private)?\/tmp)\/(.+)$/.exec(f.path);
    if (m && skipReport(f.path, m[2], markers)) return [];
    const dir = f.path.replace(/^\/private/, "").replace(/\/[^/]*$/, "");
    return [{ ...f, base: f.name, context: dir || "/tmp" }];
  });
  return { rows, error: ran(r, "Reading /tmp") };
}

// The list: scratchpads of the active project, $TMPDIR's top level and /tmp, newest first, each with its HTML title.
// `folders` are the focused terminal's folder and the space's folder. A source that fails does not hide the others;
// its error comes back beside the rows.
export async function scan(io, { on = null, folders = [], now = Date.now() } = {}) {
  const parts = await Promise.all([scanScratch, scanTmpdir, scanTmp].map((f) => f(io, { on, folders }).catch((e) => ({ rows: [], error: String(e?.message ?? e) }))));
  const seen = new Set(), all = [];
  for (const r of parts.flatMap((p) => p.rows)) { // $TMPDIR can be /tmp itself, and /tmp is /private/tmp
    const key = r.path.replace(/^\/private/, "");
    if (!seen.has(key)) { seen.add(key); all.push(r); }
  }
  const rows = sortRows(recent(all, now)).slice(0, MAX_ROWS);
  const errors = parts.map((p) => p.error).filter(Boolean);
  return { rows: await withTitles(io, on, rows), error: errors.length ? errors.join("; ") : null };
}

// The folders a scan is matched against: the focused terminal's folder first, then the space's, no repeats.
export function scanFolders(cwd, spaceFolder) {
  return [...new Set([cwd, spaceFolder].filter((f) => typeof f === "string" && f.startsWith("/")).map(trim))];
}
