// What the sync mod runs in the repo: three shell scripts (check, pull, push) and the functions that
// run them through io.sh(script, args) and read what they print (model.js). No Herdr imports, so the
// tests (ops.test.js) run them against real git repositories.
//
//   args: $1 repo path, $2 sync script (default ./mount.sh, relative to the repo), $3 per script.
//   Every script ends with "@result\t<ok|conflict|error>" and "@msg\t<text>" (pull and push) or "@end" (check).
import { parseCheck, parseOutcome } from "./model.js";

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
# The sync script is a path: absolute, ~/..., or relative to the repo (./mount.sh and mount.sh are the same). It is
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
# The unmerged files, one per line (-z, so spaces and non-ASCII names come out as they are).
unmerged() { git diff --name-only -z --diff-filter=U 2>/dev/null | tr '\\0' '\\n'; }
# The sync script's two-way dry run: which files it would copy which way. Prints "@herdr <path>" for each file it
# would copy to the repo (Herdr changed it) and "@newer <path>" for each it would copy to Herdr (the repo is newer).
two_way() {
  "$sp" --dry-run >"$tmp/dry" 2>&1 || return 1
  awk '/^to repo( \\(new\\))?: /{ sub(/^to repo( \\(new\\))?: /, ""); printf "@herdr\\t%s\\n", $0 }
       /^to Herdr( \\(new\\))?: /{ sub(/^to Herdr( \\(new\\))?: /, ""); printf "@newer\\t%s\\n", $0 }' "$tmp/dry"
}
fail() { printf '@msg\\t%s\\n@result\\terror\\n' "$1"; exit 0; }
# The files both sides changed, then undo the half-done rebase so nothing is left behind.
# Needs $mb (merge base), $up and $tip (our tip before the rebase).
conflict_report() {
  printf '@result\\tconflict\\n'
  unmerged | while IFS= read -r f; do
    r=$(git log --format=%s "$mb".."$up" -- "$f" 2>/dev/null | paste -sd ';' - || true)
    l=$(git log --format=%s "$mb".."$tip" -- "$f" 2>/dev/null | paste -sd ';' - || true)
    printf '@conflict\\t%s\\t%s\\t%s\\n' "$f" "$r" "$l"
  done
  git rebase --abort >/dev/null 2>&1 || true
  printf '@msg\\tBoth sides changed the same files. Nothing was pushed.\\n'
}
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
if [ "$script_missing" = 1 ]; then printf '@noscript\\t%s\\n' "$script"
elif ! two_way; then printf '@scripterr\\t%s\\n' "$(tail -n 1 "$tmp/dry")"
fi
printf '@end\\n'
`;

// Pull the remote's commits, then make Herdr match the repo (the repo wins; the script backs up what it
// overwrites). Linking skillshare's targets again is a separate step (targets-ops.js), done by main.js.
// A pull that stops (a clash with an uncommitted edit, a failed git command) leaves the repo as it was.
export const PULL = `${PRELUDE}
[ "$script_missing" = 0 ] || fail "The sync script $script was not found in the repo"
[ -z "$inprog" ] || fail "A rebase or merge is already in progress in the repo"
[ -n "$up" ] || fail "This branch has no remote branch to pull from"
git fetch --quiet >"$tmp/out" 2>&1 || fail "Could not reach the remote: $(tail -n 1 "$tmp/out")"
n=$(git rev-list --count HEAD.."$up")
mb=$(git merge-base HEAD "$up" 2>/dev/null || true)
tip=$(git rev-parse HEAD)
if [ "$n" -gt 0 ]; then
  stash0=$(git rev-parse -q --verify refs/stash || true)
  if ! git pull --rebase --autostash --quiet >"$tmp/out" 2>&1; then
    # Only a rebase that stopped on conflicting files is a conflict; anything else is an error.
    if [ -n "$(unmerged)" ]; then conflict_report; exit 0; fi
    git rebase --abort >/dev/null 2>&1 || true
    fail "git pull failed: $(tail -n 1 "$tmp/out")"
  fi
  stash1=$(git rev-parse -q --verify refs/stash || true)
  if [ -n "$(unmerged)" ] || [ "$stash0" != "$stash1" ]; then
    # The rebase finished but putting the uncommitted edits back clashed with the pulled commits. The edits are in
    # the stash entry git kept. Go back to where we were, bring the edits back cleanly, drop the entry.
    unmerged > "$tmp/clash"
    git reset -q --hard "$tip" >/dev/null 2>&1
    if git stash apply --index --quiet >/dev/null 2>&1 || git stash apply --quiet >/dev/null 2>&1; then
      git stash drop -q >/dev/null 2>&1
      printf '@msg\\tPull stopped: an uncommitted edit clashes with the remote (%s). Nothing changed.\\n@result\\terror\\n' "$(paste -sd ',' "$tmp/clash" | sed 's/,/, /g')"
    else
      printf '@msg\\tPull stopped: an uncommitted edit clashes with the remote, and git could not put it back. It is saved in the stash (git stash list).\\n@result\\terror\\n'
    fi
    exit 0
  fi
fi
"$sp" --push >"$tmp/mount" 2>&1 || fail "The sync script failed: $(tail -n 1 "$tmp/mount")"
copied=$(grep '^copied:' "$tmp/mount" | tail -n 1 || true)
printf '@pulled\\t%s\\n@copied\\t%s\\n' "$n" "$copied"
if [ "$n" -gt 0 ]; then printf '@msg\\tPulled %s commit(s) and updated Herdr\\n@result\\tok\\n' "$n"
else printf '@msg\\tUpdated Herdr from the repo\\n@result\\tok\\n'; fi
`;

// Copy Herdr's changes into the repo, commit everything ($3 is the message), put our commits on top of
// the remote's and push to the upstream branch. A conflict undoes the rebase and pushes nothing. Push
// refuses while the repo has files newer than Herdr's copies: the copy would revert them.
export const PUSH = `${PRELUDE}
msg=$3
[ "$script_missing" = 0 ] || fail "The sync script $script was not found in the repo"
[ -z "$inprog" ] || fail "A rebase or merge is already in progress in the repo"
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
"$sp" --pull >"$tmp/mount" 2>&1 || fail "The sync script failed: $(tail -n 1 "$tmp/mount")"
# The copy must not overwrite an uncommitted edit made in the repo. Tony's copies are regenerated, so skip them.
if [ -d "$tmp/pre" ]; then
  (cd "$tmp/pre" && find . -type f | sed 's|^\\./||') | while IFS= read -r f; do
    grep -qxF "Tony copy (changed): $f" "$tmp/mount" && continue
    grep -qxF "Tony copy (new): $f" "$tmp/mount" && continue
    cmp -s "$tmp/pre/$f" "$f" || printf '%s\\n' "$f"
  done > "$tmp/clash"
  if [ -s "$tmp/clash" ]; then
    stamp=$(date +%Y%m%d-%H%M%S)
    saved=".sync-backup/conflict-$stamp"
    printf '@result\\tconflict\\n'
    while IFS= read -r f; do
      mkdir -p "$saved/herdr/$(dirname "$f")"
      cp -p "$f" "$saved/herdr/$f"
      cp -p "$tmp/pre/$f" "$f"
      printf '@conflict\\t%s\\t\\t\\n' "$f"
    done < "$tmp/clash"
    printf '@saved\\t%s\\n@kind\\tcopy\\n' "$saved"
    printf '@msg\\tHerdr and the repo both changed the same files. The repo versions were kept and Herdr versions saved; nothing was committed or pushed.\\n'
    exit 0
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
    # Only a rebase that stopped on conflicting files is a conflict; anything else is an error.
    if [ -n "$(unmerged)" ]; then
      conflict_report
      printf '@kind\\trebase\\n'
      exit 0
    fi
    git rebase --abort >/dev/null 2>&1 || true
    fail "git pull failed: $(tail -n 1 "$tmp/out")"
  fi
  "$sp" --push >"$tmp/mount" 2>&1 || fail "The sync script failed: $(tail -n 1 "$tmp/mount")"
fi
ahead=$(git rev-list --count "$up"..HEAD)
if [ "$ahead" -eq 0 ]; then printf '@pushed\\t0\\n@msg\\tNothing to push\\n@result\\tok\\n'; exit 0; fi
remote=\${up%%/*}; rbranch=\${up#*/}
git push --quiet "$remote" "HEAD:$rbranch" >"$tmp/out" 2>&1 || fail "Push was rejected: $(tail -n 1 "$tmp/out")"
printf '@pushed\\t%s\\n@pulled\\t%s\\n' "$ahead" "$n"
printf '@msg\\tPushed %s commit(s) to %s\\n@result\\tok\\n' "$ahead" "$up"
`;

// After the person chose a side for each conflicting file (conflicts.js) and the merge was committed:
// make Herdr match the repo (the sync script with --push; the repo wins and the script backs up what it
// replaces) and, with $3 = 1, push the merge to the upstream branch.
export const FINISH = `${PRELUDE}
[ "$script_missing" = 0 ] || fail "The sync script $script was not found in the repo"
[ -z "$inprog" ] || fail "A rebase or merge is still in progress in the repo"
"$sp" --push >"$tmp/mount" 2>&1 || fail "The sync script failed: $(tail -n 1 "$tmp/mount")"
if [ "$3" = 1 ]; then
  [ -n "$up" ] || fail "This branch has no remote branch to push to"
  remote=\${up%%/*}; rbranch=\${up#*/}
  git push --quiet "$remote" "HEAD:$rbranch" >"$tmp/out" 2>&1 || fail "Push was rejected: $(tail -n 1 "$tmp/out")"
  printf '@msg\\tMerged, updated Herdr and pushed\\n@result\\tok\\n'
else printf '@msg\\tMerged and updated Herdr\\n@result\\tok\\n'; fi
`;

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

// Pull and push return an outcome: { result: "ok" | "conflict" | "error", message, files, extra }.
export async function pull(io, cfg) {
  return parseOutcome((await settle(io, PULL, [cfg.repo, cfg.script], { long: true })).text);
}

export async function push(io, cfg, message) {
  return parseOutcome((await settle(io, PUSH, [cfg.repo, cfg.script, message], { long: true })).text);
}

// After a conflict was resolved by choosing sides: Herdr matches the repo, and with push the merge goes up.
export async function finishMerge(io, cfg, { push: andPush = false } = {}) {
  return parseOutcome((await settle(io, FINISH, [cfg.repo, cfg.script, andPush ? "1" : "0"], { long: true })).text);
}
