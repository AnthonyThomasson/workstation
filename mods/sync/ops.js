// What the sync mod runs: small shell scripts (link, sync, snapshot, ignore check, list, switch) and the functions that
// run them through io.sh(script, args) and read what they print (model.js). No Herdr imports, so the tests
// (ops.test.js) run them against real git repositories. There is no git network call anywhere in here.
import { parseLinkInfo, parseOutcome, parseTargets, SCRIPT } from "./model.js";

export const PATHS = 'PATH="$HOME/.local/bin:$HOME/go/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH';

// Which repo is linked, which folder of it is picked, and its branch.
//   $1 the repo sync.json names, $2 the repo the mod remembers, $3 the folder picked in the panel (all may be empty).
// The remembered repo wins when sync.json names it or one of its worktrees (running the script from a worktree rewrites
// sync.json to that worktree, which must not unlink the repo); otherwise sync.json's repo is the link. A repo whose
// folder is gone is not linked, unless the remembered repo still lists it as a worktree. The picked folder counts only
// while it is still a worktree of the repo.
// Prints "@repo<TAB>path", "@dir<TAB>path", "@branch<TAB>name" or "@gone".
export const LINK = `${PATHS}
GIT_OPTIONAL_LOCKS=0; export GIT_OPTIONAL_LOCKS
GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT
top_of() { [ -n "$1" ] && [ -d "$1" ] && (cd "$1" && git rev-parse --show-toplevel 2>/dev/null); }
is_worktree_of() { [ -n "$2" ] && (cd "$1" && git worktree list --porcelain 2>/dev/null) | awk -v want="$2" '/^worktree /{ if (substr($0, 10) == want) found = 1 } END { exit !found }'; }
raw=$1
file=$(top_of "$1") || file=""
stored=$(top_of "$2") || stored=""
repo=""
if [ -n "$stored" ] && { [ "$raw" = "$stored" ] || [ "$file" = "$stored" ] || is_worktree_of "$stored" "$raw" || is_worktree_of "$stored" "$file"; }; then repo=$stored
elif [ -n "$file" ]; then repo=$file
fi
[ -n "$repo" ] || { printf '@gone\\n'; exit 0; }
dir=$repo
if [ -n "$3" ]; then
  p=$(top_of "$3") || p=""
  if [ -n "$p" ] && { [ "$p" = "$repo" ] || is_worktree_of "$repo" "$p"; }; then dir=$p; fi
fi
printf '@repo\\t%s\\n@dir\\t%s\\n' "$repo" "$dir"
printf '@branch\\t%s\\n' "$(cd "$dir" && git symbolic-ref --short -q HEAD || true)"
`;

// Sync: run the picked folder's own mods/sync/sync.sh from that folder (repo to Herdr, one way, with prune; it also writes
// sync.json), then ask the running Herdr whether it loaded the result: every mod the folder owns is loaded once with
// herdr-app check, and herdr-app status must list no errors. Herdr picks up changed files by itself. $1 is the folder.
export const SYNC = `${PATHS}
GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT
fail() { printf '@msg\\t%s\\n@result\\terror\\n' "$1"; exit 0; }
cd "$1" 2>/dev/null || fail "Not a folder: $1"
[ -f ${SCRIPT} ] || fail "${SCRIPT} was not found in $1"
tmp=$(mktemp -d "\${TMPDIR:-/tmp}/sync.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
sh ${SCRIPT} >"$tmp/script-out" 2>&1 || fail "The sync script failed: $(grep -v '^[[:space:]]*$' "$tmp/script-out" | tail -n 1)"
printf '@copied\\t%s\\n' "$(grep '^copied:' "$tmp/script-out" | tail -n 1 || true)"
home=\${HERDR_APP_HOME:-$HOME/.config/herdr-app}
if ! command -v herdr-app >/dev/null 2>&1; then
  printf '@msg\\tSynced; herdr-app was not found, so the running Herdr was not checked\\n@result\\tok\\n'; exit 0
fi
bad=""; n=0
for d in mods/*/; do
  m=$(basename "$d")
  [ -d "$home/mods/$m" ] || continue
  n=$((n+1))
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

// A fingerprint of the folder's content: every file git would not ignore (tracked or new), by content and size, not by
// time. Equal fingerprints mean nothing changed, whatever touched the files in between. skillshare/ is left out: the
// sync script writes there (it rewrites config.yaml, and Skillshare reinstalls into it) and never copies it to Herdr,
// so nothing in it is content to sync. Prints one line; fails outside a repo.
export const SNAPSHOT = `${PATHS}
cd "$1" 2>/dev/null && git rev-parse --git-dir >/dev/null 2>&1 || exit 1
git ls-files -z -co --exclude-standard -- . ':(exclude)skillshare' 2>/dev/null | xargs -0 cksum -- 2>/dev/null | cksum
`;

// Which of the paths ($2…, relative to the folder $1) git does not ignore. Prints "@keep<TAB>path".
export const UNIGNORED = `${PATHS}
dir=$1; shift
if ! { cd "$dir" 2>/dev/null && git rev-parse --git-dir >/dev/null 2>&1; }; then
  for p in "$@"; do printf '@keep\\t%s\\n' "$p"; done
  exit 0
fi
for p in "$@"; do
  q=$p; [ -d "$p" ] && q=$p/
  git check-ignore -q -- "$q" 2>/dev/null || printf '@keep\\t%s\\n' "$p"
done
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

// Check out branch $2 in the folder $1. Uncommitted edits come along when they do not clash; otherwise git says no.
export const SWITCH = `${PATHS}
cd "$1" 2>/dev/null || { printf '@msg\\tNot a folder: %s\\n@result\\terror\\n' "$1"; exit 0; }
if out=$(git switch "$2" 2>&1); then printf '@msg\\tSwitched to %s\\n@result\\tok\\n' "$2"
else printf '@msg\\t%s\\n@result\\terror\\n' "$(printf '%s' "$out" | tail -n 1)"; fi
`;

// io.sh(script, args): one short exec (Herdr stops an exec after 30 s). io.job(script, args): the same script detached and polled (jobs.js).
const settle = async (io, script, args, { long = false } = {}) => {
  const r = long && io.job ? await io.job(script, args) : await io.sh(script, args);
  return { ...r, text: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
};

// { gone, repo, dir, branch }: see LINK.
export async function readLink(io, { file, stored = "", pick = "" }) {
  return parseLinkInfo((await settle(io, LINK, [file, stored, pick])).stdout);
}

// Sync the folder; resolves to { result: "ok" | "error", message }.
export async function syncFolder(io, dir) {
  return parseOutcome((await settle(io, SYNC, [dir], { long: true })).text);
}

// The folder's content fingerprint, or "" when it cannot be read.
export async function snapshot(io, dir) {
  const r = await settle(io, SNAPSHOT, [dir]);
  return r.code === 0 ? r.stdout.trim() : "";
}

// The paths git does not ignore, in the order given. Without an answer from git, all of them.
export async function unignored(io, dir, paths) {
  const kept = [];
  for (let i = 0; i < paths.length; i += 200) {
    const slice = paths.slice(i, i + 200);
    try {
      const r = await settle(io, UNIGNORED, [dir, ...slice]);
      if (r.code !== 0) throw new Error("no answer");
      const keep = new Set(r.stdout.split("\n").filter((l) => l.startsWith("@keep\t")).map((l) => l.slice(6)));
      kept.push(...slice.filter((p) => keep.has(p)));
    } catch { kept.push(...slice); }
  }
  return kept;
}

export async function listTargets(io, repo) {
  return parseTargets((await settle(io, LIST, [repo])).stdout);
}

export async function switchBranch(io, dir, branch) {
  return parseOutcome((await settle(io, SWITCH, [dir, branch])).text);
}
