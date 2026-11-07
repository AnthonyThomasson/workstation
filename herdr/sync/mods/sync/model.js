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
// @file <XY> <path>, @inprogress <rebase|merge>, @herdr <path>, @noscript, @norepo, @end. Other lines (the sync
// script's own output) are ignored here.
export function parseCheck(text) {
  const out = { repo: true, top: null, host: "", branch: null, upstream: null, behind: [], unpushed: [], uncommitted: [], unmerged: [], inProgress: null, herdr: [], error: null };
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
    else if (tag === "noscript") out.error = `The sync script ${a} was not found in the repo`;
    else if (tag === "scripterr") out.error = `The sync script failed: ${a}`;
    else if (tag === "fetcherr") out.fetchError = a || "git fetch failed";
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

// Files the next push commits: what the sync script would copy from Herdr, plus what is already
// uncommitted in the repo (skills included), each file once.
export function changedFiles(state) {
  const files = [], herdr = state?.herdr ?? [];
  for (const path of herdr) files.push({ path, where: "herdr", code: "M" });
  for (const f of state?.uncommitted ?? []) {
    if (herdr.some((h) => sameFile(h, f.path))) continue;
    files.push({ path: f.path, where: "repo", code: f.code });
  }
  return files;
}

// { down, up, text }: ↓ commits the repo is behind its remote, ↑ files changed; no text at zero.
export function badge(state) {
  const down = state?.behind?.length ?? 0, up = state?.repo === false ? 0 : changedFiles(state).length;
  const parts = [];
  if (down) parts.push(`↓${down}`);
  if (up) parts.push(`↑${up}`);
  return { down, up, text: parts.join(" ") };
}

// A conflict is over when nothing is half done, no file is unmerged, and the remote's commits are in the repo.
export const resolved = (state) => Boolean(state) && !state.inProgress && !(state.unmerged?.length) && !(state.behind?.length);

// What the button and popover show: unset (no repo chosen), loading, norepo, error, conflict, busy, ok.
export function viewState({ settings, state, conflict, busy }) {
  if (!settings?.repo) return "unset";
  if (busy) return "busy";
  if (conflict) return "conflict";
  if (!state) return "loading";
  if (state.repo === false) return "norepo";
  if (state.error) return "error";
  return "ok";
}

export const commitMessage = (n, host) => `Sync${n ? ` ${plural(n, "file")}` : ""} from Herdr${host ? ` on ${host}` : ""}`;

// The agent's first message: what is in conflict and how to finish. kind: "rebase" (the remote and the
// repo changed the same files) or "copy" (copying Herdr's files would overwrite uncommitted repo edits).
export function conflictBrief({ repo, script, kind, files }) {
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
  const how = kind === "copy"
    ? `Nothing was copied or pushed. Compare the two versions of each file with me and keep what we both want in the repo working tree, then run ${script} --pull again (Herdr to repo), commit, \`git pull --rebase\` and \`git push\`.`
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
