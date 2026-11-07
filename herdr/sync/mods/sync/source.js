// The skillshare source's own git repo: where it is, what state it is in, and pull / push / both ways
// through the skillshare CLI (which also links the targets). When the source lies inside the config
// repo, the main Pull and Push cover it and none of this is shown. No Herdr imports and no view state:
// main.js takes the lock and shows the result; the tests (source.test.js) pass a fake machine.
//   io.run(args, { on, cwd }): one short skillshare exec; io.sh(script, args, on): a short script;
//   io.job(args, { on, cwd, script }): a long one, detached.
import { parseCheck, plural } from "./model.js";
import { parseJSON, failure } from "./targets.js";
import { prepare, applyChoices, looksLikeConflict } from "./conflicts.js";

// sh -c SOURCE_CHECK <name> <source folder> <config repo folder or ""> [fetch]: the git repo holding the
// source (its top folder, branch, upstream, remote url, commits behind/ahead, changed files), and
// "@same 1" when that repo is the config repo. Prints "@norepo" when the source is not in a git repo.
export const SOURCE_CHECK = `GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT
cd "$1" 2>/dev/null || { printf '@norepo\\n'; exit 0; }
top=$(git rev-parse --show-toplevel 2>/dev/null) || { printf '@norepo\\n'; exit 0; }
real=$(cd "$top" && pwd -P)
cfg=""
case "$2" in "~") cfg=$HOME ;; "~/"*) cfg=$HOME/\${2#"~/"} ;; *) cfg=$2 ;; esac
cfgtop=""
[ -n "$cfg" ] && cfgtop=$(cd "$cfg" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null && true)
[ -z "$cfgtop" ] || cfgtop=$(cd "$cfgtop" && pwd -P)
cd "$top"
gitdir=$(git rev-parse --git-dir)
if [ "$3" = fetch ] && git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then git fetch --quiet >/dev/null 2>&1 || printf '@fetcherr\\tgit fetch failed\\n'; fi
branch=$(git symbolic-ref --short -q HEAD || true)
up=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
printf '@top\\t%s\\n@host\\t%s\\n@branch\\t%s\\t%s\\n' "$top" "$(hostname -s 2>/dev/null || hostname)" "$branch" "$up"
printf '@remote\\t%s\\n' "$(git remote get-url origin 2>/dev/null || true)"
[ -n "$cfgtop" ] && [ "$cfgtop" = "$real" ] && printf '@same\\t1\\n'
if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; then printf '@inprogress\\trebase\\n'; fi
if [ -f "$gitdir/MERGE_HEAD" ]; then printf '@inprogress\\tmerge\\n'; fi
if [ -n "$up" ]; then
  git log --format='@behind%x09%h%x09%s' -n 200 HEAD.."$up" 2>/dev/null || true
  git log --format='@ahead%x09%h%x09%s' -n 200 "$up"..HEAD 2>/dev/null || true
fi
git status --porcelain=v1 --untracked-files=all 2>/dev/null | while IFS= read -r l; do
  printf '@file\\t%s\\t%s\\n' "$(printf %s "$l" | cut -c1-2)" "$(printf %s "$l" | cut -c4-)"
done
printf '@end\\n'`;

// The source folder skillshare uses: `skillshare status --json -g` → source.path, or null.
export async function sourcePath(io, on) {
  const r = await io.run(["status", "--json", "-g"], { on });
  return parseJSON(r.stdout)?.source?.path ?? null;
}

// The git state of the source folder `path`: { path, same, repo: false } when it is not in git, else
// parseCheck's fields plus path and same (the repo is the config repo). fetch: git fetch first.
export async function readSource(io, { on = null, path, configRepo = "", fetch = false }) {
  const r = fetch ? await io.job([path, configRepo, "fetch"], { on, script: SOURCE_CHECK }) : await io.sh(SOURCE_CHECK, [path, configRepo, ""], on);
  const git = parseCheck(r.stdout);
  return { ...git, path, same: Boolean(git.same) };
}

// The source's git state, or null when skillshare has no source.
export async function checkSource(io, { on = null, configRepo = "", fetch = false }) {
  const path = await sourcePath(io, on);
  return path ? readSource(io, { on, path, configRepo, fetch }) : null;
}

// A source worth showing its own section for: its own git repo, not the config repo.
export const standalone = (source) => Boolean(source && source.path && !source.same);

// What the source section says about pulling and pushing, from its state.
export function sourceGuidance(g) {
  const dirty = g?.uncommitted?.length ?? 0, behind = g?.behind?.length ?? 0, ahead = g?.unpushed?.length ?? 0;
  return {
    dirty, behind, ahead,
    canPull: Boolean(g?.upstream) && !dirty && behind > 0 && !g.inProgress,
    pullBlocked: dirty > 0 && behind > 0 ? "Pull blocked while uncommitted changes. Commit them first, or sync both ways." : null,
    pushRejected: behind > 0 && (dirty > 0 || ahead > 0) ? "Push rejected, origin has newer commits. Use both ways, which pulls first." : null,
    needsMerge: ahead > 0 && behind > 0 ? `${plural(ahead, "local commit")} and ${plural(behind, "remote commit")} need merging. Pull keeps both histories.` : null,
    canPush: Boolean(g?.upstream) && (dirty > 0 || ahead > 0) && behind === 0,
    canBoth: Boolean(g?.upstream) && !g.inProgress,
  };
}

// Whether a stored stopped pull of the source is still stopped, judged on a fresh read of the source: the
// repo is still the one it was, still its own repo, and still has commits to pull. A pull resolved
// elsewhere (in a terminal, on the dashboard) leaves nothing to pull, so the stored question is dropped.
// With no read yet it stays.
export function stillStopped(stopped, git) {
  if (!git) return true;
  if (git.none || git.error || git.same || git.repo === false) return false;
  if (git.top && stopped?.repo && git.top !== stopped.repo) return false;
  return (git.behind?.length ?? 0) > 0;
}

const done = (text) => ({ kind: "done", text });
const warn = (text) => ({ kind: "warn", text });
const error = (text) => ({ kind: "error", text });

// What happened to a pull that skillshare stopped, once read: the result for the notice and, when
// there are files to ask about, `stopped`.
async function afterStop(r, repo, on, io, { step, push, message }) {
  const git = { sh: (s, a) => io.sh(s, a, on), job: (s, a) => io.job(a, { on, script: s }) };
  const p = await prepare(git, { repo, step });
  if (p.kind === "stopped") return { ...warn("Pull stopped: both sides changed the same files. Nothing changed yet."), stopped: { ...p.stopped, push, message: message ?? "" } };
  if (p.kind === "error") return error(p.text);
  if (p.kind === "merged") return { merged: true };
  return null;
}

// Pull: skillshare pull (git pull in the source, then sync the targets). A conflict stops with nothing
// changed. Resolves to { kind, text, stopped? }; kind "done" means the targets were linked by skillshare.
export async function pullSource(io, { on = null, repo, step = () => {} }) {
  step("Pulling the source…");
  const r = await io.job(["pull"], { on });
  if (r.code === 0) return done("Pulled the skillshare source");
  if (looksLikeConflict(r)) {
    const s = await afterStop(r, repo, on, io, { step, push: false });
    if (s?.merged) return { ...done("Pulled, merged the skill records from both sides"), merged: true };
    if (s) return s;
  }
  return error(failure(r, "skillshare pull"));
}

// Push: commit what changed with `message` and push. Rejected when origin has newer commits (git says so).
export async function pushSource(io, { on = null, message, step = () => {} }) {
  step("Committing and pushing the source…");
  const r = await io.job(["push", "-m", message], { on });
  return r.code === 0 ? done("Pushed the skillshare source") : error(failure(r, "skillshare push"));
}

// Both ways: commit, pull and merge what the remote has, push, sync the targets (skillshare push --pull).
export async function bothSource(io, { on = null, repo, message, step = () => {} }) {
  step("Syncing the source both ways…");
  const args = ["push", "--pull", "-m", message];
  const r = await io.job(args, { on });
  if (r.code === 0) return done("Synced the source both ways");
  if (looksLikeConflict(r)) {
    const s = await afterStop(r, repo, on, io, { step, push: true, message });
    if (s?.merged) {
      step("Pushing the source…");
      const p = await io.job(args, { on });
      return p.code === 0 ? { ...done("Merged the skill records from both sides and synced both ways"), merged: true } : error(failure(p, "skillshare push"));
    }
    if (s) return { ...s, text: "Pull stopped: both sides changed the same files. Nothing was pushed." };
  }
  return error(failure(r, "skillshare push --pull"));
}

// The person's choices for a stopped pull of the source: commit the merge, then (when the stop came from
// both ways) push it, otherwise leave the push to the person. Resolves like the pulls do; { kind: "again" }
// carries a fresh `stopped` to ask about.
export async function resolveSource(io, { on = null, stopped, choices, step = () => {} }) {
  const git = { sh: (s, a) => io.sh(s, a, on), job: (s, a) => io.job(a, { on, script: s }) };
  const r = await applyChoices(git, { repo: stopped.repo, choices, upHash: stopped.upHash, step });
  if (r.kind === "again") return { ...warn("The remote changed since you chose. Pick again."), stopped: { ...r.stopped, push: stopped.push, message: stopped.message } };
  if (r.kind === "error") return error(r.text);
  if (r.kind === "none") return warn("Nothing conflicts any more. Pull again.");
  if (!stopped.push) {
    step("Syncing targets…");
    const sy = await io.job(["sync", "--all", "--json", "-g"], { on });
    return sy.code === 0 ? done("Merged your choices and synced targets. Push when you are ready.") : error(failure(sy, "skillshare sync"));
  }
  step("Pushing the source…");
  const p = await io.job(["push", "--pull", "-m", stopped.message || "Merge"], { on });
  return p.code === 0 ? done("Resolved and synced both ways") : error(failure(p, "skillshare push"));
}
