// What the sync mod runs in the repo: three shell scripts (check, sync, push) and the functions that
// run them through io.sh(script, args) and read what they print (model.js). No Herdr imports, so the
// tests (ops.test.js) run them against real git repositories.
//
//   args: $1 repo path, $2 sync script (default ./sync.sh, relative to the repo), $3 per script.
//   Every script ends with "@result\t<ok|error>" and "@msg\t<text>" (sync and push) or "@end" (check).
import { parseCheck, parseOutcome, parseTargets, PUSH_BRANCH } from "./model.js";

export const PATHS = 'PATH="$HOME/.local/bin:$HOME/go/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH';

// Shared start: git's environment, the repo's top folder, and the state of any half-done rebase or merge.
const PRELUDE = `${PATHS}
GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT
repo=$1; script=$2
case "$repo" in "~") repo=$HOME ;; "~/"*) repo=$HOME/\${repo#"~/"} ;; esac
cd "$repo" 2>/dev/null || { printf '@norepo\\n'; exit 0; }
top=$(git rev-parse --show-toplevel 2>/dev/null) || { printf '@norepo\\n'; exit 0; }
cd "$top"
gitdir=$(git rev-parse --git-dir)
inprog=""
if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; then inprog=rebase; fi
if [ -f "$gitdir/MERGE_HEAD" ]; then inprog=merge; fi
branch=$(git symbolic-ref --short -q HEAD || true)
up=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
tmp=$(mktemp -d "\${TMPDIR:-/tmp}/sync.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tab=$(printf '\\t')
# The sync script is a path: absolute, ~/..., or relative to the repo (./sync.sh and sync.sh are the same). It is
# always quoted, so a path with spaces works and the setting is never split into words.
case "$script" in
  "~/"*) sp=$HOME/\${script#"~/"} ;;
  /*|./*|../*) sp=$script ;;
  *) sp=./$script ;;
esac
script_missing=0
[ -f "$sp" ] || script_missing=1
# Paths git prints, one "XY<TAB>path" per line, unquoted (-z), without our own backups.
status_lines() {
  git status --porcelain=v1 -z --untracked-files=all -- . ':(exclude).sync-backup' 2>/dev/null | tr '\\0' '\\n' | awk '
    skip { skip = 0; next }
    length($0) < 4 { next }
    { xy = substr($0, 1, 2); if (xy ~ /[RC]/) skip = 1; printf "%s\\t%s\\n", xy, substr($0, 4) }'
}
# The sync script's two-way dry run: which files it would copy which way. Prints "@herdr <path>" for each file it
# would copy to the repo (Herdr changed it) and "@newer <path>" for each it would copy to Herdr (the repo is newer).
two_way() {
  "$sp" --dry-run >"$tmp/dry" 2>&1 || return 1
  awk '/^to repo( \\(new\\))?: /{ sub(/^to repo( \\(new\\))?: /, ""); printf "@herdr\\t%s\\n", $0 }
       /^to Herdr( \\(new\\))?: /{ sub(/^to Herdr( \\(new\\))?: /, ""); printf "@newer\\t%s\\n", $0 }' "$tmp/dry"
}
fail() { printf '@msg\\t%s\\n@result\\terror\\n' "$1"; exit 0; }
`;

// The repo's state and what the sync script would copy either way (its two-way dry run). $3 = 1: git fetch first.
// GIT_OPTIONAL_LOCKS=0: this runs every 20 s and must never take the index lock from the person's own git.
export const CHECK = `${PRELUDE}
GIT_OPTIONAL_LOCKS=0; export GIT_OPTIONAL_LOCKS
if [ "$3" = 1 ] && [ -n "$up" ]; then
  git fetch --quiet >"$tmp/fetch" 2>&1 || printf '@fetcherr\\t%s\\n' "$(tail -n 1 "$tmp/fetch")"
fi
printf '@top\\t%s\\n' "$top"
printf '@host\\t%s\\n' "$(hostname -s 2>/dev/null || hostname)"
printf '@branch\\t%s\\t%s\\n' "$branch" "$up"
if [ -n "$up" ]; then
  git log --format='@behind%x09%h%x09%s' -n 200 HEAD.."$up" 2>/dev/null || true
  git log --format='@ahead%x09%h%x09%s' -n 200 "$up"..HEAD 2>/dev/null || true
fi
[ -z "$inprog" ] || printf '@inprogress\\t%s\\n' "$inprog"
status_lines | while IFS="$tab" read -r xy f; do printf '@file\\t%s\\t%s\\n' "$xy" "$f"; done
[ -f RECIPE.md ] && printf '@recipe\\t1\\n' || printf '@recipe\\t0\\n'
if [ "$script_missing" = 1 ]; then printf '@noscript\\t%s\\n' "$script"
elif ! two_way; then printf '@scripterr\\t%s\\n' "$(tail -n 1 "$tmp/dry")"
fi
printf '@end\\n'
`;

// Copy Herdr's changes into the repo, commit everything ($3 is the message), put our commits on top of
// the remote's and push to the upstream branch. If the rebase onto the remote cannot be done, it is undone and nothing is pushed. Push
// refuses while the repo has files newer than Herdr's copies: the copy would revert them.
export const PUSH = `${PRELUDE}
msg=$3
[ "$script_missing" = 0 ] || fail "The sync script $script was not found in the repo"
[ -z "$inprog" ] || fail "A rebase or merge is already in progress in the repo"
[ "$branch" = ${PUSH_BRANCH} ] || fail "Push is only allowed from ${PUSH_BRANCH} (this is \${branch:-a detached HEAD})"
[ -n "$up" ] || fail "This branch has no remote branch to push to"
two_way > "$tmp/two" || fail "The sync script failed: $(tail -n 1 "$tmp/dry")"
if grep -q '^@newer' "$tmp/two"; then
  fail "Pull first: the repo has newer files than Herdr ($(grep '^@newer' "$tmp/two" | cut -f2 | head -n 3 | paste -sd ',' - | sed 's/,/, /g'))"
fi
status_lines | while IFS="$tab" read -r xy f; do
  case "$xy" in D?|?D) continue ;; esac
  [ -f "$f" ] || continue
  mkdir -p "$tmp/pre/$(dirname "$f")"; cp -p "$f" "$tmp/pre/$f"
done
"$sp" --pull >"$tmp/script-out" 2>&1 || fail "The sync script failed: $(tail -n 1 "$tmp/script-out")"
# The copy must not overwrite an uncommitted edit made in the repo. Tony's copies are regenerated, so skip them.
if [ -d "$tmp/pre" ]; then
  (cd "$tmp/pre" && find . -type f | sed 's|^\\./||') | while IFS= read -r f; do
    grep -qxF "Tony copy (changed): $f" "$tmp/script-out" && continue
    grep -qxF "Tony copy (new): $f" "$tmp/script-out" && continue
    cmp -s "$tmp/pre/$f" "$f" || printf '%s\\n' "$f"
  done > "$tmp/clash"
  if [ -s "$tmp/clash" ]; then
    while IFS= read -r f; do cp -p "$tmp/pre/$f" "$f"; done < "$tmp/clash"
    fail "Nothing was pushed: Herdr and the repo both changed $(paste -sd ',' "$tmp/clash" | sed 's/,/, /g'). The repo's versions were kept."
  fi
fi
git add -A -- . ':(exclude).sync-backup'
if ! git diff --cached --quiet; then
  git commit -q -m "$msg" >"$tmp/out" 2>&1 || fail "git commit failed: $(tail -n 1 "$tmp/out")"
fi
git fetch --quiet >"$tmp/out" 2>&1 || fail "Could not reach the remote: $(tail -n 1 "$tmp/out")"
n=$(git rev-list --count HEAD.."$up")
mb=$(git merge-base HEAD "$up" 2>/dev/null || true)
tip=$(git rev-parse HEAD)
if [ "$n" -gt 0 ]; then
  if ! git pull --rebase --quiet >"$tmp/out" 2>&1; then
    git rebase --abort >/dev/null 2>&1 || true
    fail "Nothing was pushed: the remote has newer commits that do not apply cleanly ($(tail -n 1 "$tmp/out"))"
  fi
  "$sp" --push >"$tmp/script-out" 2>&1 || fail "The sync script failed: $(tail -n 1 "$tmp/script-out")"
fi
ahead=$(git rev-list --count "$up"..HEAD)
if [ "$ahead" -eq 0 ]; then printf '@pushed\\t0\\n@msg\\tNothing to push\\n@result\\tok\\n'; exit 0; fi
remote=\${up%%/*}; rbranch=\${up#*/}
git push --quiet "$remote" "HEAD:$rbranch" >"$tmp/out" 2>&1 || fail "Push was rejected: $(tail -n 1 "$tmp/out")"
printf '@pushed\\t%s\\n@pulled\\t%s\\n' "$ahead" "$n"
printf '@msg\\tPushed %s commit(s) to %s\\n@result\\tok\\n' "$ahead" "$up"
`;

// Sync: Herdr always follows the repo. Fast-forward the repo to its remote when it is behind (uncommitted edits are
// kept), run the sync script with --push --prune (the repo wins; the script backs up each Herdr file it replaces or removes), then ask
// the running Herdr whether it loaded the result: every mod the repo owns is loaded once with herdr-app check, and
// herdr-app status must list no errors. Herdr picks up changed files by itself. Nothing is committed or pushed.
export const HERDR_SYNC = `${PRELUDE}
[ "$script_missing" = 0 ] || fail "The sync script $script was not found in the repo"
[ -z "$inprog" ] || fail "A rebase or merge is in progress in the repo"
if [ -n "$up" ]; then
  git fetch --quiet >"$tmp/out" 2>&1 || fail "Could not reach the remote: $(tail -n 1 "$tmp/out")"
  if [ "$(git rev-list --count HEAD.."$up")" -gt 0 ]; then
    git pull --ff-only --autostash --quiet >"$tmp/out" 2>&1 || fail "Could not bring the repo up to date: $(tail -n 1 "$tmp/out")"
  fi
fi
"$sp" --push --prune >"$tmp/script-out" 2>&1 || fail "The sync script failed: $(tail -n 1 "$tmp/script-out")"
copied=$(grep '^copied:' "$tmp/script-out" | tail -n 1 || true)
replaced=$(grep -c '^to Herdr: ' "$tmp/script-out" || true)
backup=$(sed -n 's/^replaced Herdr files were saved to //p' "$tmp/script-out" | tail -n 1)
printf '@copied\\t%s\\n@replaced\\t%s\\n@backup\\t%s\\n' "$copied" "\${replaced:-0}" "$backup"
home=\${HERDR_APP_HOME:-$HOME/.config/herdr-app}
if ! command -v herdr-app >/dev/null 2>&1; then
  printf '@msg\\tSynced; herdr-app was not found, so the running Herdr was not checked\\n@result\\tok\\n'; exit 0
fi
bad=""; n=0; seen=""
for d in herdr/*/mods/*/; do
  m=$(basename "$d")
  [ -d "$home/mods/$m" ] || continue
  case " $seen " in *" $m "*) continue ;; esac
  seen="$seen $m"; n=$((n+1))
  (cd "$home" && herdr-app check "mods/$m" >"$tmp/check" 2>&1) || bad="$bad $m"
done
status=$(herdr-app status 2>&1 || true)
[ -z "$bad" ] || fail "Synced, but Herdr could not load:$bad"
if printf '%s' "$status" | grep -q '"errors": \\[\\]'; then
  printf '@msg\\tSynced; the running Herdr loaded %s mods with no errors\\n@result\\tok\\n' "$n"
elif printf '%s' "$status" | grep -q '"errors"'; then
  fail "Synced, but the running Herdr reports errors (herdr-app status)"
else
  printf '@msg\\tSynced; the running Herdr is not answering, so it was not checked\\n@result\\tok\\n'
fi
`;

// The worktrees and local branches of the repo ($1), for the picker.
export const LIST = `${PATHS}
cd "$1" 2>/dev/null && git rev-parse --git-dir >/dev/null 2>&1 || exit 0
git worktree list --porcelain 2>/dev/null | awk '
  /^worktree /{ if (p != "") printf "@worktree\\t%s\\t%s\\n", p, b; p = substr($0, 10); b = "" }
  /^branch /{ b = $2; sub(/^refs\\/heads\\//, "", b) }
  END { if (p != "") printf "@worktree\\t%s\\t%s\\n", p, b }'
git for-each-ref refs/heads --format='%(refname:short)' | while IFS= read -r b; do
  w=$(git worktree list --porcelain | awk -v want="refs/heads/$b" '/^worktree /{ p = substr($0, 10) } $1 == "branch" && $2 == want { print p; exit }')
  printf '@branch\\t%s\\t%s\\n' "$b" "$w"
done
`;

// Check out branch $3 in the repo $1. Uncommitted edits come along when they do not clash; otherwise git says no.
export const SWITCH = `${PATHS}
cd "$1" 2>/dev/null || { printf '@msg\\tNot a folder: %s\\n@result\\terror\\n' "$1"; exit 0; }
if out=$(git switch "$2" 2>&1); then printf '@msg\\tSwitched to %s\\n@result\\tok\\n' "$2"
else printf '@msg\\t%s\\n@result\\terror\\n' "$(printf '%s' "$out" | tail -n 1)"; fi
`;

export async function listTargets(io, repo) {
  return parseTargets((await settle(io, LIST, [repo])).stdout);
}

export async function switchBranch(io, repo, branch) {
  return parseOutcome((await settle(io, SWITCH, [repo, branch])).text);
}

export async function syncHerdr(io, cfg) {
  return parseOutcome((await settle(io, HERDR_SYNC, [cfg.repo, cfg.script], { long: true })).text);
}

// io.sh(script, args): one short exec (Herdr stops an exec after 30 s). io.job(script, args): the same
// script detached and polled (jobs.js); used for everything that can touch the network.
const settle = async (io, script, args, { long = false } = {}) => {
  const r = long && io.job ? await io.job(script, args) : await io.sh(script, args);
  return { ...r, text: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
};

// The repo's state; with fetch, after a git fetch. See parseCheck.
export async function checkRepo(io, cfg, { fetch = false } = {}) {
  const r = await settle(io, CHECK, [cfg.repo, cfg.script, fetch ? "1" : "0"], { long: fetch });
  const state = parseCheck(r.stdout);
  return r.code !== 0 && !r.stdout.trim() ? { ...state, error: r.stderr.trim().split("\n").pop() || "Could not run git" } : state;
}

// Sync and push return an outcome: { result: "ok" | "error", message, extra }.
export async function push(io, cfg, message) {
  return parseOutcome((await settle(io, PUSH, [cfg.repo, cfg.script, message], { long: true })).text);
}
