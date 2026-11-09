// What the sync mod knows, with no Herdr and no I/O: sync.json, the link check's output, what the panel and the
// button show, and small path helpers. The tests (model.test.js) run under node.

export const SCRIPT = "mods/sync/sync.sh"; // in the picked folder: what a sync runs
export const NO_REPO = "No repo linked. Run mods/sync/sync.sh from your clone.";

// The last non-empty line of a program's output.
export const shortError = (text) => String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

// sync.json, as sync.sh writes it: {"repo": "<clone>", "remote": "<origin url or empty>"}. null when it is missing or unusable.
export function parseSyncJson(text) {
  let o;
  try { o = JSON.parse(String(text ?? "")); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (typeof o.repo !== "string" || !o.repo.trim()) return null;
  return { repo: o.repo.trim(), remote: typeof o.remote === "string" ? o.remote.trim() : "" };
}

// What the link script printed: "@repo<TAB>path", "@dir<TAB>path", "@branch<TAB>name", or "@gone".
export function parseLinkInfo(text) {
  const out = { gone: true, repo: "", dir: "", branch: "" };
  for (const line of String(text ?? "").split("\n")) {
    if (!line.startsWith("@")) continue;
    const [tag, a] = line.slice(1).split("\t");
    if (tag === "repo") { out.repo = a ?? ""; out.gone = !out.repo; }
    else if (tag === "dir") out.dir = a ?? "";
    else if (tag === "branch") out.branch = a ?? "";
  }
  if (out.gone) return { gone: true, repo: "", dir: "", branch: "" };
  return out;
}

// The picked worktree is remembered for one linked repo; a different repo starts over at the repo itself ("").
export function nextPick(pick, repo) {
  const same = pick && typeof pick === "object" && pick.repo === repo;
  return { repo, dir: same && typeof pick.dir === "string" ? pick.dir : "" };
}

// "loading" before the first read of sync.json, "unlinked", then busy / error / ok from the last run.
export function viewState({ link, run }) {
  if (!link) return "loading";
  if (!link.linked) return "unlinked";
  if (run?.syncing) return "busy";
  if (run && run.ok === false) return "error";
  return "ok";
}

// "just now", "12s ago", "5 min ago", "2 h ago"; "" when never.
export function ago(at, now = Date.now()) {
  if (!at) return "";
  const s = Math.floor((now - at) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

// The panel's last line: "Synced 12s ago · watching for changes", "Syncing…" or the last error.
export function statusLine(run, now = Date.now()) {
  if (run?.syncing) return "Syncing…";
  if (run && run.ok === false) return run.message || "The last sync failed";
  const parts = [run?.at ? `Synced ${ago(run.at, now)}` : "Not synced yet"];
  if (run?.watching) parts.push("watching for changes");
  else if (run?.watchError) parts.push(`not watching (${run.watchError})`);
  return parts.join(" · ");
}

// What a sync printed: "@result<TAB><ok|error>", "@msg<TAB>text" and other "@key<TAB>value" lines in `extra`. Without a @result the last line is the error.
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

// A path the watcher reported, relative to the watched folder ("" for the folder itself); a path outside it comes back as it was.
export function relativeTo(dir, path) {
  const root = String(dir ?? "").replace(/\/+$/, ""), p = String(path ?? "");
  if (p === root) return "";
  return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
}

// /Users/me/projects/ws -> ~/projects/ws
export function tildePath(path, home) {
  const h = String(home ?? "").replace(/\/+$/, "");
  if (!h) return path;
  if (path === h) return "~";
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

// What the list script printed, raw (targets.js orders it):
//   "@worktree\t<path>\t<branch>\t<newest HEAD reflog time>"  "@branch\t<name>\t<committer date of the tip>"
//   "@checkout\t<time>\t<position in that reflog>\t<branch checked out>"
// A missing or unreadable time is null.
const time = (v) => { const n = Number.parseInt(v ?? "", 10); return Number.isFinite(n) ? n : null; };
export function parseTargets(text) {
  const out = { worktrees: [], branches: [], checkouts: [] };
  for (const line of String(text ?? "").split("\n")) {
    if (!line.startsWith("@")) continue;
    const [tag, a, b, c] = line.slice(1).split("\t");
    if (tag === "worktree") out.worktrees.push({ path: a, branch: b ?? "", at: time(c) });
    else if (tag === "branch") out.branches.push({ name: a, at: time(b) });
    else if (tag === "checkout" && c && time(a) !== null) out.checkouts.push({ at: time(a), idx: time(b) ?? 0, branch: c });
  }
  return out;
}
