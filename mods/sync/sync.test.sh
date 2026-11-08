#!/bin/sh
# Tests for mods/sync/sync.sh. Run with: sh mods/sync/sync.test.sh
#
# Every test works on a scratch copy of the repo, a scratch Herdr config folder and a scratch
# Skillshare folder under $TMPDIR, and runs sync.sh with HOME pointed at a scratch folder too.
# Nothing in ~/.config/herdr-app or ~/.config/skillshare is ever read or written, and the
# skillshare CLI is a stub on PATH (it only records its arguments), so no test touches the network.

set -u

real_repo=$(cd "$(dirname "$0")/../.." && pwd)
base=$(mktemp -d "${TMPDIR:-/tmp}/sync-test.XXXXXX")
trap 'rm -rf "$base"' EXIT
base=$(cd "$base" && pwd -P)   # physical, as git reports the clone

# A stub skillshare on PATH for every run: it records its arguments and environment in $STUB_LOG, fails
# for a --name listed in $STUB_FAIL ("all" fails every one), and otherwise creates the skill folder in
# $STUB_SKILLS and rewrites .metadata.json there (as the real one does), so the tests can see the
# script put the recorded file back.
stub_bin="$base/bin"
mkdir -p "$stub_bin"
cat > "$stub_bin/skillshare" <<'STUB'
#!/bin/sh
# Where the real one would install: sources.skills of the config it is given (SKILLSHARE_CONFIG), else
# ~/.config/skillshare/skills; a leading ~/ expands from HOME, as it does for the real one.
target=""
if [ -n "${SKILLSHARE_CONFIG:-}" ] && [ -f "$SKILLSHARE_CONFIG" ]; then
  target=$(awk '/^sources:/ { s = 1; next } /^[^ ]/ { s = 0 } s && /^  skills:/ { sub(/^  skills: */, ""); print; exit }' "$SKILLSHARE_CONFIG")
fi
[ -n "$target" ] || target="~/.config/skillshare/skills"
case "$target" in "~/"*) target=$HOME/${target#"~/"} ;; esac
echo "args: $*" >> "$STUB_LOG"
echo "target: $target" >> "$STUB_LOG"
name=""; prev=""
for a in "$@"; do
  [ "$prev" = "--name" ] && name=$a
  prev=$a
done
case ",${STUB_FAIL:-}," in
  *",$name,"*|*",all,"*) printf '\033[31m\342\234\227 network unreachable\033[0m\r\n' >&2; exit 1 ;;
esac
mkdir -p "$target/$name"
echo "# $name" > "$target/$name/SKILL.md"
echo '{"rewritten": true}' > "$target/.metadata.json"
# Simulate a Ctrl-C / timeout in the middle of the install: signal the script, then outlive it.
if [ -n "${STUB_KILL_PARENT:-}" ]; then kill -TERM "$PPID"; sleep 2; fi
STUB
chmod +x "$stub_bin/skillshare"
PATH="$stub_bin:$PATH"; export PATH
# A PATH with neither the stub nor any real skillshare, for the CLI-missing test.
bare_path="/usr/bin:/bin"

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
  cp "$real_repo/preview.png" "$R/preview.png"
  cp -R "$real_repo/mods" "$real_repo/layouts" "$real_repo/personal" "$real_repo/skillshare" "$R/"
  find "$R" -name .DS_Store -delete
  # The script finds the clone with git, so the scratch repo is one, with an origin.
  git -C "$R" init -q
  git -C "$R" remote add origin "https://example.com/scratch/workstation.git"
  # Workflow starters live in a mod folder and sync like any other mod file; make sure the scratch repo has one.
  mkdir -p "$R/mods/github-tasks/starters"
  echo "name: scratch starter" > "$R/mods/github-tasks/starters/scratch-starter.yaml"
  # Installed skills are not in the repo: only mine/ and the file that records them.
  find "$R/skillshare/skills" -mindepth 1 -maxdepth 1 ! -name mine ! -name .metadata.json -exec rm -rf {} +
  write_metadata "$R/skillshare/skills/.metadata.json"
  cp "$R/skillshare/skills/.metadata.json" "$T/metadata.orig"
  STUB_LOG="$T/skillshare.log"; STUB_SKILLS="$R/skillshare/skills"; STUB_FAIL=""
  export STUB_LOG STUB_SKILLS STUB_FAIL
}

# write_metadata FILE: two recorded skills, shaped like Skillshare's own file (herdr pinned to a tag,
# skillshare to nothing but its commit).
write_metadata() {
  cat > "$1" <<'JSON'
{
  "version": 1,
  "entries": {
    "herdr": {
      "source": "https://github.com/herdrdev/herdr/blob/v0.9.5/skills/herdr/SKILL.md",
      "type": "github-subdir",
      "branch": "v0.9.5",
      "repo_url": "https://github.com/herdrdev/herdr.git",
      "subdir": "skills/herdr",
      "version": "2ecf19a",
      "commit": "2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01",
      "file_hashes": {
        "SKILL.md": "sha256:fbd9"
      }
    },
    "skillshare": {
      "source": "github.com/runkids/skillshare/skills/skillshare",
      "type": "github-subdir",
      "repo_url": "https://github.com/runkids/skillshare.git",
      "subdir": "skills/skillshare",
      "version": "c19ff80",
      "commit": "c19ff80611c20e9b69392ad4e4aeaf491d5036b7",
      "file_hashes": {
        "SKILL.md": "sha256:ec60",
        "references/install.md": "sha256:5624"
      }
    }
  }
}
JSON
}

# run_sync ARGS...: run the script from the scratch repo; sets $OUT (stdout+stderr) and $RC.
run_sync() {
  OUT=$(cd "$R" && HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mods/sync/sync.sh "$@" 2>&1)
  RC=$?
}

# lines OF-PREFIX: the output lines that start with PREFIX.
lines() { printf '%s\n' "$OUT" | grep "^$1" || true; }

# bump FILE: make FILE the newest file around.
bump() { touch -t 203001010000 "$1"; }

# herdr_path: the Herdr config folder as the script prints it (symlinks resolved).
herdr_path() { (cd "$H" && pwd -P); }

# json_get FILE KEY: the string value of KEY in a JSON file, parsed with node.
json_get() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]))' "$1" "$2"; }

# ---------------------------------------------------------------------------------------------
# 1. A fresh --dry-run lists only the expected mappings and writes nothing (no sync.json either).
new_world "dry-run-lists-only-the-mappings"
expected="$T/expected"
(
  cd "$R"
  find mods -type f ! -name RECIPE.md ! -name preview.png ! -name gpui-kit.d.ts ! -name jsconfig.json
  echo layouts/Tony.json
  echo layouts/Tony.png
  (cd personal/herdr-app && find themes workflows -type f)
) | sort > "$expected"
before=$(cd "$R" && find . -path ./.git -prune -o -type f -print | sort | xargs cksum)
run_sync --dry-run
assert_status 0 "$RC"
printf '%s\n' "$OUT" | sed -n 's/^to Herdr (new): //p' | sort > "$T/listed"
assert_same_file "$expected" "$T/listed"
assert_lacks "RECIPE.md"
assert_lacks "preview.png"
assert_has "to Herdr (new): mods/github-tasks/starters/scratch-starter.yaml"
assert_has "to Herdr (new): mods/sync/sync.sh"
assert_has "to Herdr (new): mods/sync/sync.test.sh"
assert_lacks "keys.json"
assert_lacks "settings.json"
assert_lacks "to repo"
assert_has "would copy: $(wc -l < "$expected" | tr -d ' ') to Herdr, 0 removed from Herdr; 0 already the same"
assert_has "would link: $(herdr_path)/sync.json"
assert_eq "" "$(ls -A "$H")" "dry run left the Herdr folder empty"
assert_absent "$H/sync.json"
after=$(cd "$R" && find . -path ./.git -prune -o -type f -print | sort | xargs cksum)
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
assert_same_file "$R/preview.png" "$H/layouts/Tony.png"
assert_same_tree "$R/personal/herdr-app/themes" "$H/themes"
assert_same_tree "$R/personal/herdr-app/workflows" "$H/workflows"
assert_absent "$H/mods/usage/RECIPE.md"
assert_absent "$H/mods/usage/preview.png"
assert_same_file "$R/mods/github-tasks/starters/scratch-starter.yaml" "$H/mods/github-tasks/starters/scratch-starter.yaml"
assert_absent "$H/keys.json"
assert_absent "$H/settings.json"
assert_has "copied: "
# the script and its test are copied like any other mod file
assert_same_file "$R/mods/sync/sync.sh" "$H/mods/sync/sync.sh"
assert_same_file "$R/mods/sync/sync.test.sh" "$H/mods/sync/sync.test.sh"
run_sync
assert_status 0 "$RC"
assert_has "copied: 0 to Herdr, 0 removed from Herdr;"
assert_lacks "to Herdr: "
assert_lacks "to Herdr (new): "

# 2b. The repo wins: a differing Herdr file is overwritten, whichever copy is newer, with no backup.
new_world "repo-wins-without-backups"
run_sync
echo "// edited in Herdr" >> "$H/mods/usage/main.js"
bump "$H/mods/usage/main.js"
echo "// edited in Herdr" >> "$H/layouts/Tony.json"
bump "$H/layouts/Tony.json"
echo "// edited in Herdr" >> "$H/themes/win98.json"
bump "$H/themes/win98.json"
echo "// edited in Herdr" >> "$H/workflows/bug.yaml"
bump "$H/workflows/bug.yaml"
before=$(cd "$R" && find . -path ./.git -prune -o -type f -print | sort | xargs cksum)
run_sync
assert_status 0 "$RC"
assert_has "to Herdr: mods/usage/main.js"
assert_has "to Herdr: layouts/Tony.json"
assert_has "to Herdr: themes/win98.json"
assert_has "to Herdr: workflows/bug.yaml"
assert_lacks "to repo"
assert_lacks "saved to"
assert_same_file "$R/mods/usage/main.js" "$H/mods/usage/main.js"
assert_same_file "$R/layouts/Tony.json" "$H/layouts/Tony.json"
assert_same_tree "$R/personal/herdr-app/themes" "$H/themes"
assert_same_tree "$R/personal/herdr-app/workflows" "$H/workflows"
assert_absent "$H/.workstation-backup"
assert_absent "$R/.sync-backup"
assert_eq "" "$(cd "$H" && find . -name '*.backup*' -o -name '*backup*')" "no backup files anywhere in Herdr"
after=$(cd "$R" && find . -path ./.git -prune -o -type f -print | sort | xargs cksum)
assert_eq "$before" "$after" "the repo was not touched"

# 3. Herdr-only files are never carried back, and recipes and previews are neither copied nor pruned.
new_world "repository-metadata-is-not-synced"
run_sync
echo herdr-recipe > "$H/mods/usage/RECIPE.md"
echo herdr-preview > "$H/mods/usage/preview.png"
echo herdr-only > "$H/mods/skills/note.txt"
echo herdr-only > "$H/themes/only-in-herdr.json"
echo herdr-only > "$H/workflows/only-in-herdr.yaml"
before=$(cd "$R" && find . -path ./.git -prune -o -type f -print | sort | xargs cksum)
run_sync --dry-run
assert_status 0 "$RC"
assert_lacks "RECIPE.md"
assert_lacks "preview.png"
assert_has "removed from Herdr: mods/skills/note.txt"
run_sync
assert_status 0 "$RC"
assert_lacks "RECIPE.md"
assert_lacks "preview.png"
assert_eq "herdr-recipe" "$(cat "$H/mods/usage/RECIPE.md")" "the Herdr recipe is left alone"
assert_eq "herdr-preview" "$(cat "$H/mods/usage/preview.png")" "the Herdr preview is left alone"
assert_absent "$R/mods/skills/note.txt"
assert_absent "$R/personal/herdr-app/themes/only-in-herdr.json"
assert_absent "$R/personal/herdr-app/workflows/only-in-herdr.yaml"
# outside the mod folders nothing is pruned
assert_exists "$H/themes/only-in-herdr.json"
assert_exists "$H/workflows/only-in-herdr.yaml"
after=$(cd "$R" && find . -path ./.git -prune -o -type f -print | sort | xargs cksum)
assert_eq "$before" "$after" "nothing was carried back to the repo"

# 3b. Starters sync like any other mod file: copied to Herdr, and pruned when the repo drops them.
new_world "starters-sync-like-mod-files"
run_sync
assert_exists "$H/mods/github-tasks/starters/scratch-starter.yaml"
rm "$R/mods/github-tasks/starters/scratch-starter.yaml"
run_sync
assert_status 0 "$RC"
assert_has "removed from Herdr: mods/github-tasks/starters/scratch-starter.yaml"
assert_absent "$H/mods/github-tasks/starters/scratch-starter.yaml"

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
rm -f "$H/sync.json"
run_sync --check
assert_status 0 "$RC"
assert_has "ok: skillshare/config.yaml has no absolute home paths"
assert_absent "$H/sync.json"
printf 'sources:\n  skills: %s/someone/.config/skillshare/skills\n' "$U" >> "$R/skillshare/config.yaml"
before=$(cd "$R" && find . -path ./.git -prune -o -type f -print | sort | xargs cksum)
run_sync --check
assert_status 1 "$RC"
assert_has "skillshare/config.yaml"
assert_has "$U/someone"
after=$(cd "$R" && find . -path ./.git -prune -o -type f -print | sort | xargs cksum)
assert_eq "$before" "$after" "--check wrote nothing"
rm -rf "$H"
printf 'x: /home/someone/skills\n' > "$R/skillshare/config.yaml"
run_sync --check
assert_status 1 "$RC"
assert_has "skillshare/config.yaml"

# 5. The flags that are gone, and bad combinations, print usage and exit 2; --help exits 0.
new_world "removed-flags"
for flag in --push --pull --prune "--push --prune" "--push --pull" --bogus; do
  run_sync $flag
  assert_status 2 "$RC"
  assert_has "usage:"
done
run_sync --check --dry-run
assert_status 2 "$RC"
run_sync --dry-run extra
assert_status 2 "$RC"
run_sync --help
assert_status 0 "$RC"
assert_has "usage:"
assert_lacks "--push"
assert_lacks "--pull"
assert_lacks "--prune"
assert_eq "" "$(ls -A "$H")" "a refused run left the Herdr folder empty"
assert_absent "$H/sync.json"

# 6. Prune: files in repo-owned mod folders that the repo lacks are deleted, with no backup;
# other Herdr files and mods are never removed. Emptied folders go too.
new_world "prune"
run_sync
echo stale > "$H/mods/usage/old.js"
mkdir -p "$H/mods/usage/old-dir" "$H/mods/shipped"
echo stale > "$H/mods/usage/old-dir/a.js"
echo untouched > "$H/mods/shipped/main.js"
echo untouched > "$H/themes/local.json"
run_sync --dry-run
assert_status 0 "$RC"
assert_has "removed from Herdr: mods/usage/old.js"
assert_has "removed from Herdr: mods/usage/old-dir/a.js"
assert_exists "$H/mods/usage/old.js"
run_sync
assert_status 0 "$RC"
assert_has "removed from Herdr: mods/usage/old.js"
assert_has "removed from Herdr: mods/usage/old-dir/a.js"
assert_has "2 removed from Herdr"
assert_absent "$H/mods/usage/old.js"
assert_absent "$H/mods/usage/old-dir"
assert_exists "$H/mods/shipped/main.js"
assert_exists "$H/themes/local.json"
assert_absent "$H/.workstation-backup"
assert_absent "$R/.sync-backup"
assert_absent "$R/mods/usage/old.js"
# a file the repo deletes is deleted in Herdr on the next run, nothing else is
rm "$R/mods/usage/main.js"
run_sync
assert_has "removed from Herdr: mods/usage/main.js"
assert_absent "$H/mods/usage/main.js"
assert_exists "$H/mods/usage/mod.json"

# 7. sync.json: written by each real run, in the Herdr config folder, with the clone and its remote.
new_world "sync-json"
git -C "$R" remote set-url origin "https://github.com/example/workstation.git"
root=$(git -C "$R" rev-parse --show-toplevel)
run_sync --dry-run
assert_absent "$H/sync.json"
run_sync
assert_status 0 "$RC"
assert_has "linked: $(herdr_path)/sync.json"
assert_exists "$H/sync.json"
assert_eq "$root" "$(json_get "$H/sync.json" repo)" "sync.json repo"
assert_eq "https://github.com/example/workstation.git" "$(json_get "$H/sync.json" remote)" "sync.json remote"
assert_eq '{"repo": "'"$root"'", "remote": "https://github.com/example/workstation.git"}' "$(cat "$H/sync.json")" "sync.json text"
assert_eq "" "$(ls -A "$H" | grep -i 'sync.json.' || true)" "no temporary sync.json left behind"
# the file is replaced on every run
echo garbage > "$H/sync.json"
run_sync
assert_eq "$root" "$(json_get "$H/sync.json" repo)" "sync.json is rewritten"
# the script finds the clone when run from another directory, by its own location
rm -f "$H/sync.json"
OUT=$(cd "$T" && HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh "$R/mods/sync/sync.sh" 2>&1); RC=$?
assert_status 0 "$RC"
assert_eq "$root" "$(json_get "$H/sync.json" repo)" "sync.json repo from another directory"

# 7b. No origin: the remote is an empty string. Odd characters are JSON-escaped.
new_world "sync-json-no-remote"
git -C "$R" remote remove origin
run_sync
assert_status 0 "$RC"
assert_eq "" "$(json_get "$H/sync.json" remote)" "no remote is an empty string"
grep -q '"remote": ""' "$H/sync.json" && pass || fail "remote is not an empty JSON string: $(cat "$H/sync.json")"
git -C "$R" remote add origin 'https://example.com/a"b\c/repo.git'
run_sync
assert_status 0 "$RC"
assert_eq 'https://example.com/a"b\c/repo.git' "$(json_get "$H/sync.json" remote)" "quote and backslash survive"

# 7c. HERDR_APP_HOME is respected, and the last clone to run wins.
new_world "sync-json-last-clone-wins"
mkdir -p "$T/other-herdr"
root=$(git -C "$R" rev-parse --show-toplevel)
run_sync
assert_exists "$H/sync.json"
assert_absent "$HOME_DIR/.config/herdr-app/sync.json"
second="$T/second"
mkdir -p "$second"
cp -R "$R/." "$second/"
git -C "$second" remote set-url origin "https://github.com/example/second.git"
second_root=$(git -C "$second" rev-parse --show-toplevel)
OUT=$(cd "$second" && HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$T/skillshare-second" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_status 0 "$RC"
assert_eq "$second_root" "$(json_get "$H/sync.json" repo)" "the last clone wins"
assert_eq "https://github.com/example/second.git" "$(json_get "$H/sync.json" remote)" "the last clone's remote wins"
run_sync
assert_eq "$root" "$(json_get "$H/sync.json" repo)" "and back again"
# the default folder is ~/.config/herdr-app under HOME
mkdir -p "$HOME_DIR/.config/herdr-app"
OUT=$(cd "$R" && env -u HERDR_APP_HOME HOME="$HOME_DIR" SKILLSHARE_HOME="$S" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_status 0 "$RC"
assert_exists "$HOME_DIR/.config/herdr-app/sync.json"
assert_exists "$HOME_DIR/.config/herdr-app/layouts/Tony.json"

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
OUT=$(cd "$R" && HOME=$U/tester HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mods/sync/sync.sh --dry-run 2>&1); RC=$?
assert_status 0 "$RC"
assert_has "would normalise paths: skillshare/config.yaml"
case $(cat "$R/skillshare/config.yaml") in *"$U/tester"*) pass ;; *) fail "dry run rewrote the config" ;; esac
OUT=$(cd "$R" && HOME=$U/tester HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_status 0 "$RC"
assert_has "normalised paths: skillshare/config.yaml"
assert_eq "  skills: ~/.config/skillshare/skills" "$(sed -n 2p "$R/skillshare/config.yaml")" "sources line"
assert_eq "      path: ~/.claude/skills" "$(sed -n 6p "$R/skillshare/config.yaml")" "target line"
assert_eq "      path: /elsewhere/skills" "$(sed -n 9p "$R/skillshare/config.yaml")" "other paths untouched"
OUT=$(cd "$R" && HOME=$U/tester HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_lacks "normalised"
run_sync --check
assert_status 0 "$RC"

# 10. The repo's own skillshare/config.yaml keeps Skillshare from re-expanding ~ when it saves.
current="repo-config-keeps-tilde"
grep -q '^preserve_tilde_on_save: true' "$real_repo/skillshare/config.yaml" && pass || fail "config.yaml lacks preserve_tilde_on_save: true"
! grep -qE '(/Use[r]s/|/home/)' "$real_repo/skillshare/config.yaml" && pass || fail "config.yaml has an absolute home path"

# 11. Guards: missing Herdr folder (and no sync.json), a Herdr folder inside the repo, a repo without mods/ or layouts/.
new_world "guards"
rm -rf "$H"
run_sync
assert_status 1 "$RC"
assert_has "no Herdr config folder"
assert_absent "$H"
mkdir -p "$R/inside"
OUT=$(cd "$R" && HERDR_APP_HOME="$R/inside" SKILLSHARE_HOME="$S" HOME="$HOME_DIR" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_status 1 "$RC"
assert_has "inside this repo"
assert_absent "$R/inside/sync.json"
# the script finds the repo as the git top level of its own folder, so a copy elsewhere in the clone works
mkdir -p "$R/tools" "$H"
cp "$R/mods/sync/sync.sh" "$R/tools/sync.sh"
rm -rf "$R/mods"
OUT=$(cd "$T" && HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh "$R/tools/sync.sh" --check 2>&1); RC=$?
assert_status 1 "$RC"
assert_has "no mods/ or layouts/ folder at the repo root"
mkdir -p "$R/mods"
rm -rf "$R/layouts"
OUT=$(cd "$T" && HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh "$R/tools/sync.sh" --check 2>&1); RC=$?
assert_status 1 "$RC"
assert_has "no mods/ or layouts/ folder at the repo root"

# 12. The script finds the repo two folders above itself, regardless of the caller's directory.
new_world "script-location"
OUT=$(cd "$T" && HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh "$R/mods/sync/sync.sh" --dry-run 2>&1); RC=$?
assert_status 0 "$RC"
assert_has "to Herdr (new): layouts/Tony.json"
assert_eq "" "$(ls -A "$H")" "dry run from another directory left Herdr empty"
# without a git repository it falls back to the folder two levels above the script
rm -rf "$R/.git"
OUT=$(cd "$T" && HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh "$R/mods/sync/sync.sh" 2>&1); RC=$?
assert_status 0 "$RC"
assert_exists "$H/layouts/Tony.json"
assert_eq "$R" "$(json_get "$H/sync.json" repo)" "sync.json repo without git"
assert_eq "" "$(json_get "$H/sync.json" remote)" "sync.json remote without git"

# 13. Recorded skills whose folder is missing are reinstalled from .metadata.json at their recorded commits.
herdr_args="args: install github.com/herdrdev/herdr/skills/herdr --name herdr --branch 2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01 -y -g"
shield_args="args: install github.com/runkids/skillshare/skills/skillshare --name skillshare --branch c19ff80611c20e9b69392ad4e4aeaf491d5036b7 -y -g"
assert_no_reinstall() {
  n=$(printf '%s\n' "$OUT" | grep -cE '^(reinstalled:|would reinstall:|skillshare: could not)' || true)
  assert_eq 0 "$n" "lines about reinstalling"
}
log_count() { if [ -f "$STUB_LOG" ]; then grep -c '^args: ' "$STUB_LOG"; else echo 0; fi; }

new_world "reinstall-dry-run"
run_sync --dry-run
assert_status 0 "$RC"
assert_has "would reinstall: herdr"
assert_has "would reinstall: skillshare"
assert_lacks "could not reinstall"
assert_absent "$STUB_LOG"
assert_absent "$R/skillshare/skills/herdr"
assert_same_file "$T/metadata.orig" "$R/skillshare/skills/.metadata.json"

new_world "reinstall"
run_sync
assert_status 0 "$RC"
assert_has "reinstalled: herdr"
assert_has "reinstalled: skillshare"
assert_eq 2 "$(log_count)" "one skillshare call per missing skill"
grep -qxF -- "$herdr_args" "$STUB_LOG" && pass || fail "herdr was not installed at its commit: $(cat "$STUB_LOG")"
grep -qxF -- "$shield_args" "$STUB_LOG" && pass || fail "skillshare was not installed at its commit: $(cat "$STUB_LOG")"
# the install lands in the Skillshare folder, not in ~/.config/skillshare under HOME
grep -qxF -- "target: $S/skills" "$STUB_LOG" && pass || fail "the install target is not $S/skills: $(cat "$STUB_LOG")"
assert_absent "$HOME_DIR/.config/skillshare"
assert_exists "$S/skills/herdr/SKILL.md"
assert_exists "$S/skills/skillshare/SKILL.md"
assert_same_file "$T/metadata.orig" "$R/skillshare/skills/.metadata.json"
# the next run has nothing left to reinstall
rm -f "$STUB_LOG"
run_sync
assert_status 0 "$RC"
assert_no_reinstall
assert_absent "$STUB_LOG"

# without SKILLSHARE_HOME the folder is ~/.config/skillshare and the install goes there
new_world "reinstall-default-home"
mkdir -p "$HOME_DIR/.config"
OUT=$(cd "$R" && env -u SKILLSHARE_HOME HOME="$HOME_DIR" HERDR_APP_HOME="$H" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_status 0 "$RC"
assert_has "reinstalled: herdr"
grep -qxF -- "target: $HOME_DIR/.config/skillshare/skills" "$STUB_LOG" && pass || fail "default install target: $(cat "$STUB_LOG")"
assert_same_file "$T/metadata.orig" "$R/skillshare/skills/.metadata.json"

# an interrupted install (SIGTERM mid-install) still puts .metadata.json back
new_world "reinstall-interrupted"
STUB_KILL_PARENT=1; export STUB_KILL_PARENT
run_sync
unset STUB_KILL_PARENT
[ "$RC" -ne 0 ] && pass || fail "an interrupted run should not exit 0"
assert_same_file "$T/metadata.orig" "$R/skillshare/skills/.metadata.json"

# only the missing folder is reinstalled
new_world "reinstall-only-missing"
mkdir -p "$R/skillshare/skills/herdr"
echo "# herdr" > "$R/skillshare/skills/herdr/SKILL.md"
run_sync
assert_status 0 "$RC"
assert_lacks "reinstalled: herdr"
assert_has "reinstalled: skillshare"
assert_eq 1 "$(log_count)" "one skillshare call"

# --check never reinstalls
new_world "reinstall-check"
run_sync --check
assert_status 0 "$RC"
assert_no_reinstall
assert_absent "$STUB_LOG"

# a failed reinstall (offline) warns, the rest of the sync finishes, and the exit is still 0
new_world "reinstall-fails"
STUB_FAIL=herdr; export STUB_FAIL
run_sync
assert_status 0 "$RC"
assert_has "skillshare: could not reinstall herdr: ✗ network unreachable"
assert_lacks "$(printf '\033')"
assert_lacks "$(printf '\r')"
assert_has "reinstalled: skillshare"
assert_has "copied: "
assert_has "skillshare: linked 3, 0 already linked"
assert_absent "$R/skillshare/skills/herdr"
assert_exists "$H/layouts/Tony.json"
assert_same_file "$T/metadata.orig" "$R/skillshare/skills/.metadata.json"
STUB_FAIL=all; export STUB_FAIL
rm -rf "$R/skillshare/skills/skillshare"
run_sync
assert_status 0 "$RC"
assert_has "could not reinstall herdr: ✗ network unreachable"
assert_has "could not reinstall skillshare: ✗ network unreachable"

# no skillshare CLI at all: a warning per skill, exit 0
new_world "reinstall-no-cli"
OUT=$(cd "$R" && PATH="$bare_path" HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_status 0 "$RC"
assert_has "skillshare: could not reinstall herdr: the skillshare CLI was not found"
assert_has "skillshare: could not reinstall skillshare: the skillshare CLI was not found"
assert_has "copied: "
assert_absent "$STUB_LOG"
# a dry run does not need the CLI
OUT=$(cd "$R" && PATH="$bare_path" HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mods/sync/sync.sh --dry-run 2>&1); RC=$?
assert_status 0 "$RC"
assert_has "would reinstall: herdr"

# an entry with no repo to reinstall from is reported, not guessed at; no recorded skills is silent
new_world "reinstall-no-source"
cat > "$R/skillshare/skills/.metadata.json" <<'JSON'
{
  "version": 1,
  "entries": {
    "local-only": {
      "source": "/somewhere/local-only",
      "type": "local",
      "version": "abc"
    }
  }
}
JSON
run_sync
assert_status 0 "$RC"
assert_has "skillshare: could not reinstall local-only: no repo_url is recorded for it"
assert_absent "$STUB_LOG"
run_sync --dry-run
assert_has "skillshare: could not reinstall local-only: no repo_url is recorded for it"
assert_absent "$STUB_LOG"
rm "$R/skillshare/skills/.metadata.json"
run_sync
assert_status 0 "$RC"
assert_no_reinstall

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]

