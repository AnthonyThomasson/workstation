// What the sync mod knows, with no Herdr and no I/O: settings, the check script's output, the badge,
// the badge. The tests (model.test.js) run under node.

// The script is not a setting: it is always sync.sh at the top of the repo, generated from RECIPE.md when missing.
export const SCRIPT = "./sync.sh";
export const DEFAULTS = { repo: "", script: SCRIPT };
export const PUSH_BRANCH = "main"; // the only branch Push is allowed from

// One machine's settings from whatever is stored: trimmed, with the defaults filled in.
export function normalizeSettings(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  // dir: the worktree picked in the panel ("" = the repo itself); it is not a typed setting.
  return { repo: text(o.repo), script: SCRIPT, dir: text(o.dir) };
}

// Settings are kept per machine: this computer under "", every other machine under its name.
export const settingsFor = (all, key) => normalizeSettings(all && typeof all === "object" ? all[key ?? ""] : null);

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The last non-empty line of a program's output.
export const shortError = (text) => String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

// ---- What the check script prints ----
// Lines starting with @ are ours: @top, @host, @branch <name> <upstream>, @behind/@ahead <hash> <subject>,
// @file <XY> <path>, @inprogress <rebase|merge>, @herdr <path> (the sync script would copy it to the repo), @newer <path> (it would copy it to Herdr: the repo is
// newer), @noscript, @norepo, @end. Other lines (the sync
// script's own output) are ignored here.
export function parseCheck(text) {
  const out = { repo: true, top: null, host: "", branch: null, upstream: null, behind: [], unpushed: [], uncommitted: [], unmerged: [], inProgress: null, herdr: [], repoNewer: [], error: null };
  let any = false;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.startsWith("@")) continue;
    const [tag, a, b] = line.slice(1).split("\t");
    any = true;
    if (tag === "norepo") return { repo: false, error: null };
    else if (tag === "top") out.top = a;
    else if (tag === "host") out.host = a ?? "";
    else if (tag === "branch") { out.branch = a || null; out.upstream = b || null; }
    else if (tag === "behind") out.behind.push({ hash: a, subject: b ?? "" });
    else if (tag === "ahead") out.unpushed.push({ hash: a, subject: b ?? "" });
    else if (tag === "file") {
      const code = a.trim() || "?";
      out.uncommitted.push({ code, path: b });
      if (/^(DD|AU|UD|UA|DU|AA|UU)$/.test(a)) out.unmerged.push(b);
    } else if (tag === "inprogress") out.inProgress = a || "rebase";
    else if (tag === "herdr") out.herdr.push(a);
    else if (tag === "newer") out.repoNewer.push(a);
    else if (tag === "noscript") { out.error = `${a} was not found in the repo`; out.noScript = true; }
    else if (tag === "recipe") out.recipe = a === "1";
    else if (tag === "scripterr") out.error = `The sync script failed: ${a}`;
    else if (tag === "fetcherr") out.fetchError = a || "git fetch failed";
    else if (tag === "remote") out.remote = a ?? "";
    else if (tag === "same") out.same = a === "1";
  }
  if (!any) out.error = "No answer from the repo";
  return out;
}

// What sync or push printed: "@result\t<ok|error>", "@msg\t<text>" and other "@key\tvalue" lines in `extra`. Without a @result the last line is the error.
export function parseOutcome(text) {
  const out = { result: "error", message: "", extra: {} };
  const lines = String(text ?? "").split("\n");
  let found = false;
  for (const line of lines) {
    if (!line.startsWith("@")) continue;
    const [tag, a] = line.slice(1).split("\t");
    if (tag === "result") { out.result = a; found = true; }
    else if (tag === "msg") out.message = a ?? "";
    else if (a !== undefined) out.extra[tag] = a;
  }
  if (!found) out.message = shortError(lines.filter((l) => !l.startsWith("@")).join("\n"));
  return out;
}

// ---- The badge ----

// A Herdr-relative path (mods/x/main.js) and the repo path it is copied to (herdr/entry/mods/x/main.js)
// are the same file when the repo's path ends with the Herdr one.
const sameFile = (herdrPath, repoPath) => repoPath === herdrPath || repoPath.endsWith(`/${herdrPath}`);

// Files the next push commits: what the sync script's two-way run would copy from Herdr to the repo, plus
// what is already uncommitted in the repo (skills included), each file once. Files the repo has newer than
// Herdr are not Herdr changes and are only counted when they are uncommitted.
export function changedFiles(state) {
  const files = [], herdr = state?.herdr ?? [];
  for (const path of herdr) files.push({ path, where: "herdr", code: "M" });
  for (const f of state?.uncommitted ?? []) {
    if (herdr.some((h) => sameFile(h, f.path))) continue;
    files.push({ path: f.path, where: "repo", code: f.code });
  }
  return files;
}

// Push is blocked while the repo has files newer than Herdr's copies: copying Herdr over them would revert them.
export const pushBlocked = (state) => (state?.repoNewer?.length ?? 0) > 0;
export const canPush = (state) => state?.branch === PUSH_BRANCH;
export const NOT_MAIN = `Push is only allowed from ${PUSH_BRANCH}`;
export const SYNC_FIRST = "Sync first: the repo has newer files than Herdr";

// A plain 20 s check waits while a fetch is running, but only for so long: a hung fetch must not freeze the badge.
export const FETCH_GUARD_MS = 60000;
export const fetchBlocksCheck = (startedAt, now = Date.now()) => Boolean(startedAt) && now - startedAt < FETCH_GUARD_MS;

// { down, up, text }: ↓ commits the repo is behind its remote, ↑ files changed; no text at zero.
export function badge(state) {
  const down = state?.behind?.length ?? 0, up = state?.repo === false ? 0 : changedFiles(state).length;
  const parts = [];
  if (down) parts.push(`↓${down}`);
  if (up) parts.push(`↑${up}`);
  return { down, up, text: parts.join(" ") };
}

// "just now", "5 min ago", "2 h ago"; "" when never.
export function ago(at, now = Date.now()) {
  if (!at) return "";
  const m = Math.floor((now - at) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

// What the button and the panel show: unset (no repo chosen), loading, norepo, error, busy, ok.
export function viewState({ settings, state, busy }) {
  if (!settings?.repo) return "unset";
  if (busy) return "busy";
  if (!state) return "loading";
  if (state.repo === false) return "norepo";
  if (state.error) return "error";
  return "ok";
}

export const commitMessage = (n, host) => `Sync${n ? ` ${plural(n, "file")}` : ""} from Herdr${host ? ` on ${host}` : ""}`;

// What the list script printed: "@worktree\t<path>\t<branch>" and "@branch\t<name>\t<path where it is checked out>".
export function parseTargets(text) {
  const out = { worktrees: [], branches: [] };
  for (const line of String(text ?? "").split("\n")) {
    if (!line.startsWith("@")) continue;
    const [tag, a, b] = line.slice(1).split("\t");
    if (tag === "worktree") out.worktrees.push({ path: a, branch: b ?? "" });
    else if (tag === "branch") out.branches.push({ name: a, path: b ?? "" });
  }
  return out;
}
