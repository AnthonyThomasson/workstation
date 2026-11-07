#!/bin/sh
# Tests for mount.sh. Run with: sh tests/mount.test.sh
#
# Every test works on a scratch copy of the repo, a scratch Herdr config folder and a scratch
# Skillshare folder under $TMPDIR, and runs mount.sh with HOME pointed at a scratch folder too.
# Nothing in ~/.config/herdr-app or ~/.config/skillshare is ever read or written.

set -u

real_repo=$(cd "$(dirname "$0")/.." && pwd)
base=$(mktemp -d "${TMPDIR:-/tmp}/mount-test.XXXXXX")
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
  mkdir -p "$R" "$H" "$HOME_DIR"
  cp "$real_repo/mount.sh" "$R/"
  cp -R "$real_repo/herdr" "$real_repo/personal" "$real_repo/skillshare" "$R/"
  find "$R" -name .DS_Store -delete
}

# mount ARGS...: run the script from the scratch repo; sets $OUT (stdout+stderr) and $RC.
mount() {
  OUT=$(cd "$R" && HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mount.sh "$@" 2>&1)
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
  cd "$R/herdr"
  for dir in */mods/*/; do
    case "$dir" in tony/*) continue ;; esac
    find "${dir%/}" -type f | sed 's|^[^/]*/||'
  done
  (cd tony && find mods/tabs-icons -type f)
  echo layouts/Tony.json
  (cd ../personal/herdr-app && find themes workflows -type f)
) | sort > "$expected"
before=$(cd "$R" && find . -type f | sort | xargs cksum)
mount --dry-run
assert_status 0 "$RC"
printf '%s\n' "$OUT" | sed -n 's/^to Herdr (new): //p' | sort > "$T/listed"
assert_same_file "$expected" "$T/listed"
assert_lacks "keys.json"
assert_lacks "settings.json"
assert_lacks "to repo"
assert_has "would copy: $(wc -l < "$expected" | tr -d ' ') to Herdr, 0 to the repo; 0 already the same"
assert_eq "" "$(ls -A "$H")" "dry run left the Herdr folder empty"
after=$(cd "$R" && find . -type f | sort | xargs cksum)
assert_eq "$before" "$after" "dry run left the repo untouched"
assert_absent "$S/config.yaml"

# 2. A real run copies every mapping, and Tony's copies are exact copies of the entry folders.
new_world "run-copies-the-mappings"
mount
assert_status 0 "$RC"
for entry in usage status-bar skills github-workflows; do
  for mod in "$R/herdr/$entry/mods/"*/; do
    name=$(basename "$mod")
    assert_same_tree "$mod" "$H/mods/$name"
    assert_same_tree "$mod" "$R/herdr/tony/mods/$name"
  done
done
assert_same_tree "$R/herdr/tony/mods/tabs-icons" "$H/mods/tabs-icons"
assert_same_file "$R/herdr/tony/layouts/Tony.json" "$H/layouts/Tony.json"
assert_same_tree "$R/personal/herdr-app/themes" "$H/themes"
assert_same_tree "$R/personal/herdr-app/workflows" "$H/workflows"
assert_absent "$H/keys.json"
assert_absent "$H/settings.json"
assert_has "copied: "
assert_exists "$H/mods/status-bar/icons/both.svg"
mount
assert_status 0 "$RC"
assert_has "copied: 0 to Herdr, 0 to the repo;"
assert_lacks "to Herdr: "

# 3. Editing an entry's mod and running updates Tony's copy and Herdr.
new_world "entry-edit-reaches-tony"
mount
echo "// edited in the entry" >> "$R/herdr/usage/mods/usage/main.js"
bump "$R/herdr/usage/mods/usage/main.js"
mount
assert_status 0 "$RC"
assert_has "to Herdr: mods/usage/main.js"
assert_same_file "$R/herdr/usage/mods/usage/main.js" "$R/herdr/tony/mods/usage/main.js"
assert_same_file "$R/herdr/usage/mods/usage/main.js" "$H/mods/usage/main.js"
assert_has "refreshed Tony's copies: "

# 4. The refresh adds, overwrites and removes files, and --dry-run only reports them.
new_world "refresh-add-change-remove"
mount
entry="$R/herdr/github-workflows/mods/workflows"
tony="$R/herdr/tony/mods/workflows"
echo new > "$entry/added.js"
echo changed >> "$entry/main.js"
rm "$entry/labels.js"
before=$(cd "$tony" && find . -type f | sort | xargs cksum)
# a two-way dry run sees Herdr's copy of labels.js coming back, so Tony keeps it
mount --dry-run
assert_has "to repo (new): mods/workflows/labels.js"
assert_lacks "Tony copy (removed)"
assert_has "would refresh Tony's copies: 1 added, 1 changed, 0 removed"
mount --push --dry-run
assert_status 0 "$RC"
assert_has "Tony copy (new): herdr/tony/mods/workflows/added.js"
assert_has "Tony copy (changed): herdr/tony/mods/workflows/main.js"
assert_has "Tony copy (removed): herdr/tony/mods/workflows/labels.js"
assert_has "would refresh Tony's copies: 1 added, 1 changed, 1 removed"
after=$(cd "$tony" && find . -type f | sort | xargs cksum)
assert_eq "$before" "$after" "dry run did not touch Tony's copy"
# (a two-way run would pull labels.js back from Herdr, which still has it; --push leaves it)
mount --push
assert_status 0 "$RC"
assert_same_tree "$entry" "$tony"
assert_absent "$tony/labels.js"
assert_exists "$tony/added.js"
mount
assert_exists "$entry/labels.js"
assert_same_tree "$entry" "$tony"

# 5. The refresh skips generated files.
new_world "refresh-skips-generated-files"
mount
echo x > "$R/herdr/usage/mods/usage/gpui-kit.d.ts"
echo x > "$R/herdr/usage/mods/usage/jsconfig.json"
echo x > "$R/herdr/usage/mods/usage/.DS_Store"
mount
assert_absent "$R/herdr/tony/mods/usage/gpui-kit.d.ts"
assert_absent "$R/herdr/tony/mods/usage/jsconfig.json"
assert_absent "$R/herdr/tony/mods/usage/.DS_Store"
assert_absent "$H/mods/usage/gpui-kit.d.ts"
mount --check
assert_status 0 "$RC"

# 6. --check passes when clean, names a hand-edited, missing or extra Tony file, and writes nothing.
new_world "check"
mount
mount --check
assert_status 0 "$RC"
assert_has "ok"
echo "// hand edit" >> "$R/herdr/tony/mods/usage/main.js"
rm "$R/herdr/tony/mods/status-bar/mod.json"
echo extra > "$R/herdr/tony/mods/skills/stray.txt"
before=$(cd "$R" && find . -type f | sort | xargs cksum)
mount --check
assert_status 1 "$RC"
assert_has "herdr/tony/mods/usage/main.js"
assert_has "herdr/tony/mods/status-bar/mod.json"
assert_has "herdr/tony/mods/skills/stray.txt"
assert_lacks "herdr/tony/mods/workflows"
after=$(cd "$R" && find . -type f | sort | xargs cksum)
assert_eq "$before" "$after" "--check wrote nothing"
mount
mount --check
assert_status 0 "$RC"

# 7. --check also fails, naming the file, on an absolute home path in skillshare/config.yaml,
#    and works without a Herdr config folder.
new_world "check-absolute-paths"
mount
printf 'sources:\n  skills: %s/someone/.config/skillshare/skills\n' "$U" >> "$R/skillshare/config.yaml"
mount --check
assert_status 1 "$RC"
assert_has "skillshare/config.yaml"
assert_has "$U/someone"
rm -rf "$H"
printf 'x: /home/someone/skills\n' > "$R/skillshare/config.yaml"
mount --check
assert_status 1 "$RC"
assert_has "skillshare/config.yaml"

# 8. --pull brings a Herdr-side edit back into the entry folder, and Tony's copy follows from there.
new_world "pull-goes-to-the-entry"
mount
echo "// edited in Herdr" >> "$H/mods/usage/main.js"
bump "$H/mods/usage/main.js"
mount --pull
assert_status 0 "$RC"
assert_has "to repo: mods/usage/main.js"
assert_same_file "$H/mods/usage/main.js" "$R/herdr/usage/mods/usage/main.js"
assert_same_file "$H/mods/usage/main.js" "$R/herdr/tony/mods/usage/main.js"
assert_exists "$R/.sync-backup"
# a new file in Herdr comes back into the owning entry, not into Tony
echo new > "$H/mods/skills/note.txt"
mount --pull
assert_has "to repo (new): mods/skills/note.txt"
assert_exists "$R/herdr/skills/mods/skills/note.txt"
mount --check
assert_status 0 "$RC"

# 9. A hand edit to Tony's copy is never carried into Herdr or the entry; it is overwritten.
new_world "tony-edit-is-overwritten"
mount
echo "// hand edit" >> "$R/herdr/tony/mods/usage/main.js"
bump "$R/herdr/tony/mods/usage/main.js"
mount
assert_status 0 "$RC"
assert_lacks "hand edit"
case $(cat "$H/mods/usage/main.js") in *"hand edit"*) fail "hand edit reached Herdr" ;; *) pass ;; esac
case $(cat "$R/herdr/usage/mods/usage/main.js") in *"hand edit"*) fail "hand edit reached the entry" ;; *) pass ;; esac
assert_same_file "$R/herdr/usage/mods/usage/main.js" "$R/herdr/tony/mods/usage/main.js"

# 10. tabs-icons lives only in Tony: it syncs both ways with herdr/tony/mods/tabs-icons.
new_world "tabs-icons-two-way"
mount
echo "// from Herdr" >> "$H/mods/tabs-icons/note.txt"
bump "$H/mods/tabs-icons/note.txt"
mount --pull
assert_exists "$R/herdr/tony/mods/tabs-icons/note.txt"
mount --check
assert_status 0 "$RC"

# 11. --push and --pull only go one way; newer wins by default; overwrites are backed up.
new_world "directions"
mount
echo "// herdr side" > "$H/themes/only-in-herdr.json"
echo "// edit" >> "$H/layouts/Tony.json"
bump "$H/layouts/Tony.json"
mount --push --dry-run
assert_status 0 "$RC"
assert_has "to Herdr: layouts/Tony.json"
assert_lacks "to repo"
mount --push
assert_same_file "$R/herdr/tony/layouts/Tony.json" "$H/layouts/Tony.json"
assert_exists "$H/.workstation-backup"
assert_has "replaced Herdr files were saved to"
# only repo-tracked theme files are synced: a theme that exists only in Herdr stays there
mount --pull
assert_absent "$R/personal/herdr-app/themes/only-in-herdr.json"
# the two-way default: the newer side wins in either direction
echo "// newer in Herdr" >> "$H/themes/win98.json"
bump "$H/themes/win98.json"
mount
assert_has "to repo: themes/win98.json"
echo "// newer in repo" >> "$R/personal/herdr-app/workflows/bug.yaml"
bump "$R/personal/herdr-app/workflows/bug.yaml"
age "$H/workflows/bug.yaml"
mount
assert_has "to Herdr: workflows/bug.yaml"
mount --push --pull
assert_status 2 "$RC"
mount --bogus
assert_status 2 "$RC"

# 12. Skillshare links are created, idempotent, and back up what is in the way.
new_world "skillshare-links"
mount --dry-run
assert_has "link: $S/config.yaml"
assert_absent "$S/config.yaml"
mount
assert_status 0 "$RC"
for name in config.yaml agents skills; do
  [ -L "$S/$name" ] && pass || fail "$name is not a link"
  assert_eq "$R/skillshare/$name" "$(readlink "$S/$name")" "$name link target"
done
mount
assert_status 0 "$RC"
assert_lacks "backed up"
assert_lacks "link: "
assert_has "link ok: $S/skills"
# a real file and a real folder in the way are moved to backups, not deleted
new_world "skillshare-links-in-the-way"
mkdir -p "$S/skills/theirs" "$S/agents"
echo mine > "$S/config.yaml"
echo agent > "$S/agents/a.md"
mount --dry-run
assert_has "would back up: $S/config.yaml"
[ -f "$S/config.yaml" ] && [ ! -L "$S/config.yaml" ] && pass || fail "dry run replaced the real config"
mount
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
mount
assert_eq "$R/skillshare/skills" "$(readlink "$S/skills")" "wrong link repointed"
assert_exists "$T/elsewhere"

# 13. Absolute home paths in skillshare/config.yaml are rewritten to ~/ on a real run only.
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
OUT=$(cd "$R" && HOME=$U/tester HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mount.sh --dry-run 2>&1); RC=$?
assert_status 0 "$RC"
assert_has "would normalise paths: skillshare/config.yaml"
case $(cat "$R/skillshare/config.yaml") in *"$U/tester"*) pass ;; *) fail "dry run rewrote the config" ;; esac
OUT=$(cd "$R" && HOME=$U/tester HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mount.sh 2>&1); RC=$?
assert_status 0 "$RC"
assert_has "normalised paths: skillshare/config.yaml"
assert_eq "  skills: ~/.config/skillshare/skills" "$(sed -n 2p "$R/skillshare/config.yaml")" "sources line"
assert_eq "      path: ~/.claude/skills" "$(sed -n 6p "$R/skillshare/config.yaml")" "target line"
assert_eq "      path: /elsewhere/skills" "$(sed -n 9p "$R/skillshare/config.yaml")" "other paths untouched"
OUT=$(cd "$R" && HOME=$U/tester HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mount.sh 2>&1); RC=$?
assert_lacks "normalised"
mount --check
assert_status 0 "$RC"

# 14. The repo's own skillshare/config.yaml keeps Skillshare from re-expanding ~ when it saves.
current="repo-config-keeps-tilde"
grep -q '^preserve_tilde_on_save: true' "$real_repo/skillshare/config.yaml" && pass || fail "config.yaml lacks preserve_tilde_on_save: true"
! grep -qE '(/Use[r]s/|/home/)' "$real_repo/skillshare/config.yaml" && pass || fail "config.yaml has an absolute home path"

# 15. Guards: missing Herdr folder, and a Herdr folder inside the repo.
new_world "guards"
rm -rf "$H"
mount
assert_status 1 "$RC"
assert_has "no Herdr config folder"
mkdir -p "$R/inside"
OUT=$(cd "$R" && HERDR_APP_HOME="$R/inside" SKILLSHARE_HOME="$S" HOME="$HOME_DIR" sh ./mount.sh 2>&1); RC=$?
assert_status 1 "$RC"

# 16. A mod folder in herdr/tony/mods/ that no entry owns is reported by --check and removed by a run.
new_world "tony-extra-mod-folder"
mount
mkdir -p "$R/herdr/tony/mods/stray/icons"
echo x > "$R/herdr/tony/mods/stray/main.js"
echo x > "$R/herdr/tony/mods/stray/icons/a.svg"
mount --check
assert_status 1 "$RC"
assert_has "Tony copy extra: herdr/tony/mods/stray"
assert_lacks "herdr/tony/mods/tabs-icons"
mount --dry-run
assert_status 0 "$RC"
assert_has "Tony copy (extra): herdr/tony/mods/stray"
assert_has "1 extra mod folders removed"
assert_exists "$R/herdr/tony/mods/stray/main.js"
mount
assert_status 0 "$RC"
assert_has "Tony copy (extra): herdr/tony/mods/stray"
assert_absent "$R/herdr/tony/mods/stray"
assert_exists "$R/herdr/tony/mods/tabs-icons"
assert_absent "$H/mods/stray"
mount --check
assert_status 0 "$RC"

# 17. --dry-run accounts for the files the sync would pull from Herdr into an entry folder.
new_world "dry-run-counts-pulled-files"
mount
echo "// edited in Herdr" >> "$H/mods/usage/main.js"
bump "$H/mods/usage/main.js"
echo new > "$H/mods/usage/note.txt"
before=$(cd "$R" && find . -type f | sort | xargs cksum)
mount --dry-run
assert_status 0 "$RC"
assert_has "to repo: mods/usage/main.js"
assert_has "Tony copy (changed): herdr/tony/mods/usage/main.js"
assert_has "Tony copy (new): herdr/tony/mods/usage/note.txt"
assert_has "would refresh Tony's copies: 1 added, 1 changed, 0 removed"
after=$(cd "$R" && find . -type f | sort | xargs cksum)
assert_eq "$before" "$after" "dry run left the repo untouched"
# a real run does what the dry run said
mount
assert_has "refreshed Tony's copies: 1 added, 1 changed, 0 removed"
assert_same_file "$H/mods/usage/main.js" "$R/herdr/tony/mods/usage/main.js"
assert_exists "$R/herdr/tony/mods/usage/note.txt"

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
