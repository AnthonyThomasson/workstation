// What the sync mod knows, with no Herdr and no I/O: settings, the check script's output, the badge,
// the conflict brief. The tests (model.test.js) run under node.

export const DEFAULTS = { repo: "", script: "./mount.sh", agent: "claude" };

// One machine's settings from whatever is stored: trimmed, with the defaults filled in.
export function normalizeSettings(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  return { repo: text(o.repo), script: text(o.script) || DEFAULTS.script, agent: text(o.agent) || DEFAULTS.agent };
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
    else if (tag === "noscript") out.error = `The sync script ${a} was not found in the repo`;
    else if (tag === "scripterr") out.error = `The sync script failed: ${a}`;
    else if (tag === "fetcherr") out.fetchError = a || "git fetch failed";
    else if (tag === "remote") out.remote = a ?? "";
    else if (tag === "same") out.same = a === "1";
  }
  if (!any) out.error = "No answer from the repo";
  return out;
}

// What a pull or push printed: "@result\t<ok|conflict|error>", "@msg\t<text>", "@conflict\t<path>\t<remote>\t<local>",
// and other "@key\tvalue" lines in `extra`. Without a @result the last line is the error.
export function parseOutcome(text) {
  const out = { result: "error", message: "", files: [], extra: {} };
  const lines = String(text ?? "").split("\n");
  let found = false;
  for (const line of lines) {
    if (!line.startsWith("@")) continue;
    const [tag, a, b, c] = line.slice(1).split("\t");
    if (tag === "result") { out.result = a; found = true; }
    else if (tag === "msg") out.message = a ?? "";
    else if (tag === "conflict") out.files.push({ path: a, remote: b ?? "", local: c ?? "" });
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
export const PULL_FIRST = "Pull first: the repo has newer files than Herdr";

// Pull makes Herdr match the repo (the sync script's --push, repo wins), so the Herdr changes ↑ are what it replaces
// (the script backs them up). The Pull row says so before the person presses it.
export const pullReplaces = (state) => (state?.repo === false ? [] : state?.herdr ?? []);
export const replacesText = (n) => `Replaces ${plural(n, "Herdr change")} (backed up)`;

// What the Pull notification adds when the script replaced Herdr files: how many and where the backups went.
export function pullReplacedNote(extra) {
  const n = Number(extra?.replaced) || 0;
  if (!n) return "";
  return `Replaced ${plural(n, "Herdr file")}${extra?.backup ? `; backups are in ${extra.backup}` : " (backed up)"}.`;
}

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

// A conflict is over when nothing is half done, no file is unmerged and the remote's commits are in the
// repo. A copy conflict (Herdr's file against an uncommitted repo edit) is over when those files are
// no longer uncommitted: they were merged and committed.
export function resolved(state, conflict) {
  if (!state || state.inProgress || state.unmerged?.length || state.behind?.length) return false;
  if (conflict?.kind === "copy") return !state.uncommitted?.some((f) => (conflict.files ?? []).some((c) => c.path === f.path));
  return true;
}

// Where Herdr's copy of a conflicting file was saved (a copy conflict): per file, so the brief can name it.
export const withSaved = (files, saved) => (files ?? []).map((f) => (saved ? { ...f, saved: `${saved}/herdr/${f.path}` } : f));

// "just now", "5 min ago", "2 h ago"; "" when never.
export function ago(at, now = Date.now()) {
  if (!at) return "";
  const m = Math.floor((now - at) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

// What the button and the panel show: unset (no repo chosen), loading, norepo, error, conflict, busy, ok.
export function viewState({ settings, state, conflict, busy }) {
  if (!settings?.repo) return "unset";
  if (busy) return "busy";
  if (conflict) return "conflict";
  if (!state) return "loading";
  if (state.repo === false) return "norepo";
  if (state.error) return "error";
  return "ok";
}

// The default message for committing the skillshare source's own repo; the person can edit it.
export const sourceCommitMessage = (n, host) => `Update ${n ? plural(n, "file") : "skills"} in the skillshare source${host ? ` on ${host}` : ""}`;

export const commitMessage = (n, host) => `Sync${n ? ` ${plural(n, "file")}` : ""} from Herdr${host ? ` on ${host}` : ""}`;

// The agent's first message: what is in conflict and how to finish. kind: "rebase" (the remote and the
// repo changed the same files) or "copy" (copying Herdr's files would overwrite uncommitted repo edits).
export function conflictBrief({ repo, script, kind, files, target }) {
  const list = (files ?? []).map((f) => {
    const lines = [`- ${f.path}`];
    if (kind === "copy") {
      lines.push("  Herdr's copy and the repo's uncommitted edit both changed it.");
      if (f.saved) lines.push(`  Herdr's version is saved at ${f.saved}; the repo's version is in the working tree.`);
    } else {
      lines.push(`  remote changed: ${f.remote || "(see git log)"}`);
      lines.push(`  this machine changed: ${f.local || "(see git log)"}`);
    }
    return lines.join("\n");
  }).join("\n");
  if (target === "source") {
    return [
      `Pulling the skillshare source at ${repo} hit a conflict.`,
      "",
      "Conflicting files:",
      list || "- (none listed; run `git status`)",
      "",
      "The pull was stopped and undone, so nothing changed. Run `git pull`, resolve each conflicted file with me keeping what both sides meant, commit the merge, then run `skillshare sync --all -g` so the targets match.",
      "In .metadata.json merge entry by entry: an entry changed on one side takes that side; changed on both, keep the one with the later installed_at.",
      "Ask me whenever it is not clear which side should win.",
    ].join("\n");
  }
  const how = kind === "copy"
    ? `Nothing was committed or pushed. The files Herdr changed that did not clash were copied into the repo working tree and are uncommitted. For each file listed, the repo's version was kept. Compare the two versions with me and keep what we both want in the repo working tree, then run ${script} --pull again (Herdr to repo), commit, \`git pull --rebase\` and \`git push\`.`
    : `The push was stopped and the rebase undone, so nothing was pushed and the repo is as it was before. Run \`git pull --rebase\`, resolve each conflicted file with me keeping what both sides meant, \`git rebase --continue\`, then \`${script} --push\` so Herdr's config matches the repo, and \`git push\`.`;
  return [
    `Sync hit a conflict in the repo at ${repo}.`,
    "",
    "Conflicting files:",
    list || "- (none listed; run `git status`)",
    "",
    how,
    "Ask me whenever it is not clear which side should win.",
  ].join("\n");
}
