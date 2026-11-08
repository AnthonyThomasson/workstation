#!/bin/sh
# Tests for scripts/sync/sync.sh. Run with: sh tests/sync.test.sh
#
# Every test works on a scratch copy of the repo, a scratch Herdr config folder and a scratch
# Skillshare folder under $TMPDIR, and runs sync.sh with HOME pointed at a scratch folder too.
# Nothing in ~/.config/herdr-app or ~/.config/skillshare is ever read or written.

set -u

real_repo=$(cd "$(dirname "$0")/.." && pwd)
base=$(mktemp -d "${TMPDIR:-/tmp}/sync-test.XXXXXX")
trap 'rm -rf "$base"' EXIT
base=$(cd "$base" && pwd)

# A macOS home path, built so the literal is not in this file (the repo must hold no such path).
U="/Use"rs

passed=0
failed=0
current=""

pass() { passed=$((passed + 1)); }
fail() { failed=$((failed + 1)); echo "FAIL: $current: $1"; }

assert_status() { # EXPECTED ACTUAL
  [ "$1" = "$2" ] && pass || fail "expected exit $1, got $2 (output: $OUT)"
}
assert_has() { # TEXT   (in $OUT)
  case "$OUT" in *"$1"*) pass ;; *) fail "output lacks: $1
--- output ---
$OUT" ;; esac
}
assert_lacks() { # TEXT  (in $OUT)
  case "$OUT" in *"$1"*) fail "output has unexpected: $1
--- output ---
$OUT" ;; *) pass ;; esac
}
assert_same_file() { # A B
  cmp -s "$1" "$2" && pass || fail "files differ: $1 and $2"
}
assert_exists() { [ -e "$1" ] && pass || fail "missing: $1"; }
assert_absent() { [ ! -e "$1" ] && [ ! -L "$1" ] && pass || fail "should not exist: $1"; }
assert_same_tree() { # A B
  d=$(diff -r -x .DS_Store "$1" "$2" 2>&1) && pass || fail "trees differ: $1 and $2
$d"
}
assert_eq() { # EXPECTED ACTUAL LABEL
  [ "$1" = "$2" ] && pass || fail "$3: expected [$1], got [$2]"
}

# new_world NAME: a repo copy ($R), an empty Herdr config folder ($H), a Skillshare folder ($S).
new_world() {
  current="$1"
  T="$base/$1"
  R="$T/repo"; H="$T/herdr"; S="$T/skillshare-home"; HOME_DIR="$T/home"
  rm -rf "$T"
  mkdir -p "$R/scripts/sync" "$H" "$HOME_DIR"
  cp "$real_repo/scripts/sync/sync.sh" "$R/scripts/sync/sync.sh"
  cp -R "$real_repo/mods" "$real_repo/layouts" "$real_repo/personal" "$real_repo/skillshare" "$R/"
  find "$R" -name .DS_Store -delete
}

# run_sync ARGS...: run the script from the scratch repo; sets $OUT (stdout+stderr) and $RC.
run_sync() {
  OUT=$(cd "$R" && HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./scripts/sync/sync.sh "$@" 2>&1)
  RC=$?
}

# lines OF-PREFIX: the output lines that start with PREFIX.
lines() { printf '%s\n' "$OUT" | grep "^$1" || true; }

# bump FILE: make FILE the newest file around.
bump() { touch -t 203001010000 "$1"; }
age() { touch -t 200001010000 "$1"; }

# ---------------------------------------------------------------------------------------------
# 1. A fresh --dry-run lists only the expected mappings and writes nothing.
new_world "dry-run-lists-only-the-mappings"
expected="$T/expected"
(
  cd "$R"
  find mods -type f ! -name RECIPE.md ! -name preview.png ! -path 'mods/workflows/starters/*'
  echo layouts/Tony.json
  (cd personal/herdr-app && find themes workflows -type f)
) | sort > "$expected"
before=$(cd "$R" && find . -type f | sort | xargs cksum)
run_sync --dry-run
assert_status 0 "$RC"
printf '%s\n' "$OUT" | sed -n 's/^to Herdr (new): //p' | sort > "$T/listed"
assert_same_file "$expected" "$T/listed"
assert_lacks "RECIPE.md"
assert_lacks "preview.png"
assert_lacks "starters/"
assert_lacks "Tony copy"
assert_lacks "Tony's copies"
assert_lacks "keys.json"
assert_lacks "settings.json"
assert_lacks "to repo"
assert_has "would copy: $(wc -l < "$expected" | tr -d ' ') to Herdr, 0 to the repo; 0 already the same"
assert_eq "" "$(ls -A "$H")" "dry run left the Herdr folder empty"
after=$(cd "$R" && find . -type f | sort | xargs cksum)
assert_eq "$before" "$after" "dry run left the repo untouched"
assert_absent "$S/config.yaml"

# 2. A real run copies every real mod, layout, theme and workflow file, and is idempotent.
new_world "run-copies-the-mappings"
run_sync
assert_status 0 "$RC"
for mod in "$R/mods/"*/; do
  name=$(basename "$mod")
  assert_exists "$H/mods/$name/mod.json"
done
assert_same_file "$R/mods/usage/main.js" "$H/mods/usage/main.js"
assert_same_file "$R/mods/status-bar/icons/branch.svg" "$H/mods/status-bar/icons/branch.svg"
assert_same_file "$R/layouts/Tony.json" "$H/layouts/Tony.json"
assert_same_tree "$R/personal/herdr-app/themes" "$H/themes"
assert_same_tree "$R/personal/herdr-app/workflows" "$H/workflows"
assert_absent "$H/mods/usage/RECIPE.md"
assert_absent "$H/mods/usage/preview.png"
assert_absent "$H/mods/workflows/starters"
assert_absent "$H/keys.json"
assert_absent "$H/settings.json"
assert_has "copied: "
assert_lacks "Tony copy"
assert_lacks "Tony's copies"
run_sync
assert_status 0 "$RC"
assert_has "copied: 0 to Herdr, 0 to the repo;"
assert_lacks "to Herdr: "

# 3. Recipes, previews and starters stay out of Herdr and are never pulled or pruned.
new_world "repository-metadata-is-not-synced"
run_sync
mkdir -p "$H/mods/workflows/starters"
echo herdr-recipe > "$H/mods/usage/RECIPE.md"
echo herdr-preview > "$H/mods/usage/preview.png"
echo herdr-starter > "$H/mods/workflows/starters/herdr-only.yaml"
before=$(cd "$R" && find mods -type f | sort | xargs cksum)
run_sync --pull
assert_status 0 "$RC"
assert_lacks "RECIPE.md"
assert_lacks "preview.png"
assert_lacks "starters/"
assert_eq "herdr-recipe" "$(cat "$H/mods/usage/RECIPE.md")" "pull left Herdr recipe alone"
assert_absent "$R/mods/workflows/starters/herdr-only.yaml"
run_sync --push --prune --dry-run
assert_status 0 "$RC"
assert_lacks "RECIPE.md"
assert_lacks "preview.png"
assert_lacks "starters/"
run_sync --push --prune
assert_status 0 "$RC"
assert_exists "$H/mods/usage/RECIPE.md"
assert_exists "$H/mods/usage/preview.png"
assert_exists "$H/mods/workflows/starters/herdr-only.yaml"
after=$(cd "$R" && find mods -type f | sort | xargs cksum)
assert_eq "$before" "$after" "pull and prune left repo metadata and starters untouched"

# 4. Generated files are skipped and --check only checks Skillshare's absolute home paths.
new_world "generated-files-and-check"
run_sync
echo x > "$R/mods/usage/gpui-kit.d.ts"
echo x > "$R/mods/usage/jsconfig.json"
echo x > "$R/mods/usage/.DS_Store"
run_sync
assert_absent "$H/mods/usage/gpui-kit.d.ts"
assert_absent "$H/mods/usage/jsconfig.json"
assert_absent "$H/mods/usage/.DS_Store"
run_sync --check
assert_status 0 "$RC"
assert_has "ok: skillshare/config.yaml has no absolute home paths"
assert_lacks "Tony copy"
printf 'sources:\n  skills: %s/someone/.config/skillshare/skills\n' "$U" >> "$R/skillshare/config.yaml"
before=$(cd "$R" && find . -type f | sort | xargs cksum)
run_sync --check
assert_status 1 "$RC"
assert_has "skillshare/config.yaml"
assert_has "$U/someone"
after=$(cd "$R" && find . -type f | sort | xargs cksum)
assert_eq "$before" "$after" "--check wrote nothing"
rm -rf "$H"
printf 'x: /home/someone/skills\n' > "$R/skillshare/config.yaml"
run_sync --check
assert_status 1 "$RC"
assert_has "skillshare/config.yaml"

# 5. --pull brings Herdr-side edits and new files back into root-level mod folders.
new_world "pull-goes-to-root-mods"
run_sync
echo "// edited in Herdr" >> "$H/mods/usage/main.js"
bump "$H/mods/usage/main.js"
run_sync --pull
assert_status 0 "$RC"
assert_has "to repo: mods/usage/main.js"
assert_same_file "$H/mods/usage/main.js" "$R/mods/usage/main.js"
assert_exists "$R/.sync-backup"
echo new > "$H/mods/skills/note.txt"
run_sync --pull
assert_has "to repo (new): mods/skills/note.txt"
assert_exists "$R/mods/skills/note.txt"
run_sync --check
assert_status 0 "$RC"

# 6. --push and --pull only go one way; newer wins by default; overwrites are backed up.
new_world "directions"
run_sync
echo "// herdr side" > "$H/themes/only-in-herdr.json"
echo "// edit" >> "$H/layouts/Tony.json"
bump "$H/layouts/Tony.json"
run_sync --push --dry-run
assert_status 0 "$RC"
assert_has "to Herdr: layouts/Tony.json"
assert_lacks "to repo"
run_sync --push
assert_same_file "$R/layouts/Tony.json" "$H/layouts/Tony.json"
assert_exists "$H/.workstation-backup"
assert_has "replaced Herdr files were saved to"
# only repo-tracked theme files are synced: a theme that exists only in Herdr stays there
run_sync --pull
assert_absent "$R/personal/herdr-app/themes/only-in-herdr.json"
# the two-way default: the newer side wins in either direction
echo "// newer in Herdr" >> "$H/themes/win98.json"
bump "$H/themes/win98.json"
run_sync
assert_has "to repo: themes/win98.json"
echo "// newer in repo" >> "$R/personal/herdr-app/workflows/bug.yaml"
bump "$R/personal/herdr-app/workflows/bug.yaml"
age "$H/workflows/bug.yaml"
run_sync
assert_has "to Herdr: workflows/bug.yaml"
run_sync --push --pull
assert_status 2 "$RC"
run_sync --bogus
assert_status 2 "$RC"
run_sync --prune
assert_status 2 "$RC"
run_sync --check --dry-run
assert_status 2 "$RC"

# 7. --prune removes only extra files in repo-owned mod folders and keeps backups.
new_world "prune"
run_sync
echo stale > "$H/mods/usage/old.js"
mkdir -p "$H/mods/shipped"
echo untouched > "$H/mods/shipped/main.js"
echo untouched > "$H/themes/local.json"
run_sync --push --prune
assert_status 0 "$RC"
assert_has "removed from Herdr: mods/usage/old.js"
assert_absent "$H/mods/usage/old.js"
assert_exists "$H/mods/shipped/main.js"
assert_exists "$H/themes/local.json"
assert_exists "$H/.workstation-backup"
assert_absent "$R/mods/usage/old.js"

# 8. Skillshare links are created, idempotent, and back up what is in the way.
new_world "skillshare-links"
run_sync --dry-run
assert_has "link: $S/config.yaml"
assert_absent "$S/config.yaml"
run_sync
assert_status 0 "$RC"
for name in config.yaml agents skills; do
  [ -L "$S/$name" ] && pass || fail "$name is not a link"
  assert_eq "$R/skillshare/$name" "$(readlink "$S/$name")" "$name link target"
done
run_sync
assert_status 0 "$RC"
assert_lacks "backed up"
assert_lacks "link: "
assert_has "link ok: $S/skills"
# a real file and a real folder in the way are moved to backups, not deleted
new_world "skillshare-links-in-the-way"
mkdir -p "$S/skills/theirs" "$S/agents"
echo mine > "$S/config.yaml"
echo agent > "$S/agents/a.md"
run_sync --dry-run
assert_has "would back up: $S/config.yaml"
[ -f "$S/config.yaml" ] && [ ! -L "$S/config.yaml" ] && pass || fail "dry run replaced the real config"
run_sync
assert_status 0 "$RC"
assert_eq "$R/skillshare/config.yaml" "$(readlink "$S/config.yaml")" "config link"
assert_eq "$R/skillshare/skills" "$(readlink "$S/skills")" "skills link"
backups=$(ls -d "$S"/config.yaml.backup-* "$S"/skills.backup-* "$S"/agents.backup-* 2>/dev/null | wc -l | tr -d ' ')
assert_eq 3 "$backups" "three backups"
assert_eq mine "$(cat "$S"/config.yaml.backup-*)" "backup keeps the old config"
assert_exists "$S"/skills.backup-*/theirs
assert_exists "$S"/agents.backup-*/a.md
# a link that points somewhere else is repointed
new_world "skillshare-links-wrong-target"
mkdir -p "$S" "$T/elsewhere"
ln -s "$T/elsewhere" "$S/skills"
run_sync
assert_eq "$R/skillshare/skills" "$(readlink "$S/skills")" "wrong link repointed"
assert_exists "$T/elsewhere"

# 9. Absolute home paths in skillshare/config.yaml are rewritten to ~/ on a real run only.
new_world "skillshare-absolute-paths"
cat > "$R/skillshare/config.yaml" <<EOF
sources:
  skills: $U/tester/.config/skillshare/skills
targets:
  claude:
    skills:
      path: $U/tester/.claude/skills
  other:
    skills:
      path: /elsewhere/skills
EOF
OUT=$(cd "$R" && HOME=$U/tester HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./scripts/sync/sync.sh --dry-run 2>&1); RC=$?
assert_status 0 "$RC"
assert_has "would normalise paths: skillshare/config.yaml"
case $(cat "$R/skillshare/config.yaml") in *"$U/tester"*) pass ;; *) fail "dry run rewrote the config" ;; esac
OUT=$(cd "$R" && HOME=$U/tester HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./scripts/sync/sync.sh 2>&1); RC=$?
assert_status 0 "$RC"
assert_has "normalised paths: skillshare/config.yaml"
assert_eq "  skills: ~/.config/skillshare/skills" "$(sed -n 2p "$R/skillshare/config.yaml")" "sources line"
assert_eq "      path: ~/.claude/skills" "$(sed -n 6p "$R/skillshare/config.yaml")" "target line"
assert_eq "      path: /elsewhere/skills" "$(sed -n 9p "$R/skillshare/config.yaml")" "other paths untouched"
OUT=$(cd "$R" && HOME=$U/tester HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./scripts/sync/sync.sh 2>&1); RC=$?
assert_lacks "normalised"
run_sync --check
assert_status 0 "$RC"

# 10. The repo's own skillshare/config.yaml keeps Skillshare from re-expanding ~ when it saves.
current="repo-config-keeps-tilde"
grep -q '^preserve_tilde_on_save: true' "$real_repo/skillshare/config.yaml" && pass || fail "config.yaml lacks preserve_tilde_on_save: true"
! grep -qE '(/Use[r]s/|/home/)' "$real_repo/skillshare/config.yaml" && pass || fail "config.yaml has an absolute home path"

# 11. Guards: script location, missing Herdr folder, and a Herdr folder inside the repo.
new_world "guards"
rm -rf "$H"
run_sync
assert_status 1 "$RC"
assert_has "no Herdr config folder"
mkdir -p "$R/inside"
OUT=$(cd "$R" && HERDR_APP_HOME="$R/inside" SKILLSHARE_HOME="$S" HOME="$HOME_DIR" sh ./scripts/sync/sync.sh 2>&1); RC=$?
assert_status 1 "$RC"
assert_has "inside this repo"
rm -rf "$R/mods"
run_sync --check
assert_status 1 "$RC"
assert_has "no mods/ or layouts/ folder at the repo root"
mkdir -p "$R/mods"
rm -rf "$R/layouts"
run_sync --check
assert_status 1 "$RC"
assert_has "no mods/ or layouts/ folder at the repo root"

# 12. The script finds the repo two folders above itself, regardless of the caller's directory.
new_world "script-location"
OUT=$(cd "$T" && HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh "$R/scripts/sync/sync.sh" --push --dry-run 2>&1); RC=$?
assert_status 0 "$RC"
assert_has "to Herdr (new): layouts/Tony.json"
assert_eq "" "$(ls -A "$H")" "dry run from another directory left Herdr empty"

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
