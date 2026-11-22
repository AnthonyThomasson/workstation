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
printf '%s\n' "args: $*" >> "$STUB_LOG"
printf '%s\n' "target: $target" >> "$STUB_LOG"
name=""; prev=""
for a in "$@"; do
  [ "$prev" = "--name" ] && name=$a
  prev=$a
done
case ",${STUB_FAIL:-}," in
  *",$name,"*|*",all,"*) printf '\033[31m\342\234\227 network unreachable\033[0m\r\n' >&2; exit 1 ;;
esac
mkdir -p "$target/$name"
printf '%s\n' "# $name" > "$target/$name/SKILL.md"
echo '{"rewritten": true}' > "$target/.metadata.json"
# Simulate a Ctrl-C / timeout in the middle of the install: signal the script, then outlive it.
if [ -n "${STUB_KILL_PARENT:-}" ]; then kill -TERM "$PPID"; sleep 2; fi
STUB
chmod +x "$stub_bin/skillshare"
PATH="$stub_bin:$PATH"; export PATH
# A PATH with neither the stub nor any real skillshare, for the CLI-missing test.
# It keeps git, through a folder that holds only a wrapper for it: git is not in /usr/bin on Git Bash (/mingw64/bin), and the
# script compares files with git (without it, one cmp per file, slow there). Git's own folder could hold a real skillshare.
git_only="$base/git-only"
mkdir -p "$git_only"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$(command -v git)" > "$git_only/git"
chmod +x "$git_only/git"
bare_path="/usr/bin:/bin:$git_only"

# A macOS home path, built so the literal is not in this file (the repo must hold no such path).
U="/Use"rs

passed=0
failed=0
current=""

# Git Bash and Cygwin: each test's name is printed as it starts. The run starts thousands of programs, which is slow there, so
# this shows it is moving, and where it stopped if it does. Elsewhere the output is only the failures and the count, as before.
# Detected as the script detects it (uname), since the Skillshare links differ there.
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) on_windows=1 ;; *) on_windows=0 ;; esac
# can_link: whether this machine allows real file symlinks. On Git Bash that takes Developer Mode (or admin); the script then
# links config.yaml with one, and otherwise with a hard link (folders are junctions either way). Probed as the script makes
# them (winsymlinks:nativestrict fails rather than copy). Elsewhere always 1.
mkdir -p "$base/link-probe"
: > "$base/link-probe/file"
MSYS=winsymlinks:nativestrict CYGWIN=winsymlinks:nativestrict ln -s "$base/link-probe/file" "$base/link-probe-link" 2>/dev/null
if [ -L "$base/link-probe-link" ]; then can_link=1; else can_link=0; fi
rm -rf "$base/link-probe" "$base/link-probe-link"

# native PATH: PATH as a native Windows program is given it on Git Bash (cygpath -m: C:/...); elsewhere as it is.
native() { if [ "$on_windows" -eq 1 ]; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }

# make_dir_link TARGET LINK: a folder link the way one is made on this machine: ln -s, or a junction on Git Bash (where
# ln -s copies). The paths reach cmd through the environment, as in the script.
make_dir_link() {
  if [ "$on_windows" -eq 1 ]; then
    printf '@mklink /J "%%SYNC_LINK%%" "%%SYNC_TARGET%%" > nul\r\n' > "$base/junction.cmd"
    (cd "$base" && SYNC_LINK=$(cygpath -w "$2") SYNC_TARGET=$(cygpath -w "$1") MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
      "$(cygpath -u "$COMSPEC")" /d /c '.\junction.cmd')
  else
    ln -s "$1" "$2"
  fi
}

pass() { passed=$((passed + 1)); }
fail() { failed=$((failed + 1)); printf '%s\n' "FAIL: $current: $1"; }   # printf: messages may hold backslashes

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
# The comparisons use cksum (CRC and size; POSIX, on macOS and Git Bash alike), not cmp or diff: GNU diffutils can take
# many seconds to start under Git Bash, which made these asserts, like the script's own comparisons once, crawl.
assert_same_file() { # A B
  [ -f "$1" ] && [ -f "$2" ] && [ "$(cksum < "$1")" = "$(cksum < "$2")" ] && pass || fail "files differ: $1 and $2"
}
assert_exists() { [ -e "$1" ] && pass || fail "missing: $1"; }
assert_absent() { [ ! -e "$1" ] && [ ! -L "$1" ] && pass || fail "should not exist: $1"; }
# tree_sums DIR: "<crc> <size> <path>" for every file under DIR but .DS_Store, sorted by path.
tree_sums() { (cd "$1" && find . -type f ! -name .DS_Store -exec cksum {} + | sort -k 3); }
assert_same_tree() { # A B
  ta=$(tree_sums "$1" 2>&1); tb=$(tree_sums "$2" 2>&1)
  [ "$ta" = "$tb" ] && pass || fail "trees differ: $1 and $2
--- $1 ---
$ta
--- $2 ---
$tb"
}
assert_eq() { # EXPECTED ACTUAL LABEL
  [ "$1" = "$2" ] && pass || fail "$3: expected [$1], got [$2]"
}
# assert_link LINK TARGET LABEL: LINK links to TARGET. Outside Git Bash: a symlink whose text is TARGET. On Git Bash: a
# junction (a folder) or a symlink to the same folder or file, or, for a file where symlinks can't be made, a hard link to it.
assert_link() {
  if [ "$on_windows" -eq 0 ]; then
    [ -L "$1" ] && pass || fail "$3: not a link: $1"
    assert_eq "$2" "$(readlink "$1")" "$3"
  elif [ -d "$2" ] || [ "$can_link" -eq 1 ]; then
    [ -L "$1" ] && [ "$1" -ef "$2" ] && pass || fail "$3: $1 is not a link to $2"
  else
    [ -f "$1" ] && [ ! -L "$1" ] && [ "$1" -ef "$2" ] && pass || fail "$3: $1 is not a hard link to $2"
  fi
}

# new_world NAME: a repo copy ($R), an empty Herdr config folder ($H), a Skillshare folder ($S).
new_world() {
  current="$1"
  [ "$on_windows" -eq 0 ] || echo "# $1 (${SECONDS:-?}s)"
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
  # A mod's own keys.json is an ordinary mod file; none ships now, so the scratch repo has one.
  echo '{}' > "$R/mods/github-tasks/keys.json"
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
# a mod's own keys.json is an ordinary mod file; only Herdr's top-level keys.json/settings.json never sync
assert_has "to Herdr (new): mods/github-tasks/keys.json"
assert_lacks ": keys.json"
assert_lacks ": settings.json"
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
assert_same_file "$R/mods/github-tasks/keys.json" "$H/mods/github-tasks/keys.json"
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

# 2c. Comparing starts no program per file: with git on PATH, a run that finds every file already in Herdr never starts
# cmp or diff (on Git Bash each can take many seconds to start, and one per file made a real sync never finish), yet a
# change on either side is still copied, including one that keeps the file's size. Without a working git hash-object,
# each pair falls back to cmp and the result is the same.
new_world "compares-without-a-program-per-file"
cmp_bin="$T/cmp-bin"
mkdir -p "$cmp_bin"
for tool in cmp diff; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 2\n' "$tool" "$T/cmp.log" > "$cmp_bin/$tool"
  chmod +x "$cmp_bin/$tool"
done
run_sync
assert_status 0 "$RC"
LC_ALL=C tr -c '\n' x < "$R/layouts/Tony.json" > "$T/same-size"   # every byte but the newlines changed: the same size
cp "$T/same-size" "$H/layouts/Tony.json"
cp "$R/layouts/Tony.json" "$T/tony.orig"
echo "// edited in Herdr" >> "$H/mods/usage/main.js"
echo "// edited in the repo" >> "$R/mods/sync/README.md"
OUT=$(cd "$R" && PATH="$cmp_bin:$PATH" HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_status 0 "$RC"
assert_absent "$T/cmp.log"
assert_has "to Herdr: layouts/Tony.json"
assert_has "to Herdr: mods/usage/main.js"
assert_has "to Herdr: mods/sync/README.md"
assert_has "copied: 3 to Herdr, 0 removed from Herdr;"
assert_same_file "$R/layouts/Tony.json" "$H/layouts/Tony.json"
assert_same_file "$R/mods/usage/main.js" "$H/mods/usage/main.js"
assert_same_file "$R/mods/sync/README.md" "$H/mods/sync/README.md"
# the fallback: a git whose hash-object fails (everything else goes to the real git), and a cmp that compares by cksum
real_git=$(command -v git)
printf '#!/bin/sh\n[ "$1" = hash-object ] && exit 1\nexec "%s" "$@"\n' "$real_git" > "$cmp_bin/git"
printf '#!/bin/sh\necho "cmp $*" >> "%s"\n[ "$(cksum < "$2")" = "$(cksum < "$3")" ]\n' "$T/cmp.log" > "$cmp_bin/cmp"
chmod +x "$cmp_bin/git" "$cmp_bin/cmp"
cp "$T/same-size" "$H/layouts/Tony.json"
OUT=$(cd "$R" && PATH="$cmp_bin:$PATH" HOME="$HOME_DIR" HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_status 0 "$RC"
assert_exists "$T/cmp.log"
assert_has "to Herdr: layouts/Tony.json"
assert_has "copied: 1 to Herdr, 0 removed from Herdr;"
assert_same_file "$T/tony.orig" "$H/layouts/Tony.json"

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
# Git Bash would turn the backslash into a slash on its way to git (MSYS argument conversion); these turn that off and mean
# nothing elsewhere. cd rather than -C, as the scratch path itself still needs converting.
(cd "$R" && MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' git remote add origin 'https://example.com/a"b\c/repo.git')
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

# 8. Skillshare links are created, idempotent, and back up what is in the way. (On Git Bash the links are junctions and, for
# config.yaml, a symlink or a hard link: see 8b. assert_link takes each for what it is.)
new_world "skillshare-links"
run_sync --dry-run
assert_has "link: $S/config.yaml"
assert_absent "$S/config.yaml"
run_sync
assert_status 0 "$RC"
for name in config.yaml agents skills; do
  assert_link "$S/$name" "$R/skillshare/$name" "$name link"
done
run_sync
assert_status 0 "$RC"
assert_lacks "backed up"
assert_lacks "link: "
assert_has "link ok: $S/config.yaml"
assert_has "link ok: $S/agents"
assert_has "link ok: $S/skills"
assert_has "skillshare: linked 0, 3 already linked"
run_sync --dry-run
assert_lacks "would back up"
assert_lacks "link: $S"
assert_has "skillshare: would link 0, 3 already linked"
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
assert_link "$S/config.yaml" "$R/skillshare/config.yaml" "config link"
assert_link "$S/skills" "$R/skillshare/skills" "skills link"
backups=$(ls -d "$S"/config.yaml.backup-* "$S"/skills.backup-* "$S"/agents.backup-* 2>/dev/null | wc -l | tr -d ' ')
assert_eq 3 "$backups" "three backups"
assert_eq mine "$(cat "$S"/config.yaml.backup-*)" "backup keeps the old config"
assert_exists "$S"/skills.backup-*/theirs
assert_exists "$S"/agents.backup-*/a.md
# a link that points somewhere else is repointed
new_world "skillshare-links-wrong-target"
mkdir -p "$S" "$T/elsewhere"
make_dir_link "$T/elsewhere" "$S/skills"
run_sync
assert_has "relink: $S/skills"
assert_link "$S/skills" "$R/skillshare/skills" "wrong link repointed"
assert_exists "$T/elsewhere"

# 8b. Git Bash: agents/ and skills/ are junctions, which need no Developer Mode, so they are the repo's folders, not
# copies; config.yaml is a symlink if the machine allows one, else a hard link that Skillshare's in-place saves write
# through. Git replacing the repo's config.yaml leaves the hard link with the old copy: the next sync re-links it, with no
# backup when the copy is unchanged. Without SKILLSHARE_HOME the folder is Skillshare's own (%AppData%\skillshare, or
# $XDG_CONFIG_HOME/skillshare), and the config's sources (~/.config/skillshare/...) are linked too.
if [ "$on_windows" -eq 0 ]; then
  echo "skip: 8b. Skillshare links on Windows (not Git Bash)" >&2
else
new_world "skillshare-windows-junctions"
run_sync
assert_status 0 "$RC"
assert_lacks "could not link"
for name in agents skills; do
  [ -L "$S/$name" ] && [ "$S/$name" -ef "$R/skillshare/$name" ] && pass || fail "$name is not a junction to the repo"
done
# the same folder, not a copy: what lands in the repo is there through the link at once, and the other way round
echo probe > "$R/skillshare/skills/mine/probe.md"
assert_exists "$S/skills/mine/probe.md"
echo agent > "$S/agents/through-the-link.md"
assert_exists "$R/skillshare/agents/through-the-link.md"
rm -f "$R/skillshare/skills/mine/probe.md" "$S/agents/through-the-link.md"
# config.yaml: Skillshare's in-place save lands in the repo's file
assert_link "$S/config.yaml" "$R/skillshare/config.yaml" "config.yaml link"
if [ "$can_link" -eq 0 ]; then assert_has "hard link: $S/config.yaml"; else assert_lacks "hard link: "; fi
cp "$R/skillshare/config.yaml" "$T/config.orig"
echo "# saved by skillshare" >> "$S/config.yaml"
assert_eq "# saved by skillshare" "$(tail -n 1 "$R/skillshare/config.yaml")" "a save through the link reaches the repo"
cp "$T/config.orig" "$S/config.yaml"
run_sync
assert_has "skillshare: linked 0, 3 already linked"
assert_exists "$R/skillshare/skills/mine"
if [ "$can_link" -eq 0 ]; then
  # git replaces the file with the same bytes (a checkout that leaves it as it was): re-linked, no backup
  rm "$R/skillshare/config.yaml"; cp "$T/config.orig" "$R/skillshare/config.yaml"
  run_sync --dry-run
  assert_has "relink: $S/config.yaml -> "
  assert_has "(was a copy of it)"
  assert_lacks "would back up"
  run_sync
  assert_status 0 "$RC"
  assert_link "$S/config.yaml" "$R/skillshare/config.yaml" "re-linked after git replaced the file"
  assert_eq "" "$(ls -d "$S"/*.backup-* 2>/dev/null)" "no backup of an unchanged copy"
  # git replaces it with new content: the old copy may hold a Skillshare save, so it is backed up, then linked
  rm "$R/skillshare/config.yaml"; { cat "$T/config.orig"; echo "# from a pull"; } > "$R/skillshare/config.yaml"
  run_sync
  assert_status 0 "$RC"
  assert_has "backed up: $S/config.yaml -> "
  assert_link "$S/config.yaml" "$R/skillshare/config.yaml" "linked to the new file"
  assert_same_file "$T/config.orig" "$(ls -d "$S"/config.yaml.backup-* | head -n 1)"
fi
# a directory path with a space and cmd's special characters is linked all the same
new_world "skillshare-windows-odd-path"
S="$T/skill share & co^1"
run_sync
assert_status 0 "$RC"
assert_link "$S/skills" "$R/skillshare/skills" "skills link in an odd path"
run_sync
assert_has "skillshare: linked 0, 3 already linked"

# the default folder: %AppData%\skillshare (a scratch APPDATA here), plus the config's ~/.config/skillshare sources
new_world "skillshare-windows-default-folder"
APP="$T/appdata"
mkdir -p "$APP"
OUT=$(cd "$R" && env -u SKILLSHARE_HOME -u XDG_CONFIG_HOME APPDATA="$(cygpath -w "$APP")" HOME="$HOME_DIR" HERDR_APP_HOME="$H" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_status 0 "$RC"
for name in config.yaml agents skills; do
  assert_link "$APP/skillshare/$name" "$R/skillshare/$name" "%AppData% $name"
done
assert_link "$HOME_DIR/.config/skillshare/skills" "$R/skillshare/skills" "sources.skills"
assert_link "$HOME_DIR/.config/skillshare/agents" "$R/skillshare/agents" "sources.agents"
assert_absent "$HOME_DIR/.config/skillshare/config.yaml"
assert_has "skillshare: linked 5, 0 already linked"
assert_has "reinstalled: herdr"
OUT=$(cd "$R" && env -u SKILLSHARE_HOME -u XDG_CONFIG_HOME APPDATA="$(cygpath -w "$APP")" HOME="$HOME_DIR" HERDR_APP_HOME="$H" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_has "skillshare: linked 0, 5 already linked"
assert_lacks "reinstalled:"
assert_lacks "could not reinstall"
# XDG_CONFIG_HOME wins over %AppData%, as it does for Skillshare
new_world "skillshare-windows-xdg-folder"
OUT=$(cd "$R" && env -u SKILLSHARE_HOME XDG_CONFIG_HOME="$(cygpath -w "$T/xdg")" APPDATA="$(cygpath -w "$T/appdata")" HOME="$HOME_DIR" HERDR_APP_HOME="$H" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_status 0 "$RC"
assert_link "$T/xdg/skillshare/skills" "$R/skillshare/skills" "XDG skills"
assert_absent "$T/appdata/skillshare"
fi

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

# 9b. On Git Bash a native Skillshare writes the home the Windows way (C:\…\tester\ or C:/…/tester/) while HOME is /c/…/tester:
# every spelling cygpath gives for HOME is rewritten to ~/. A stub cygpath stands in, so this runs the same on macOS.
new_world "skillshare-windows-home-paths"
win_bin="$T/win-bin"
mkdir -p "$win_bin"
# (On Git Bash the real cygpath answers, and gives these very spellings for /c/fake/tester; the stub only stands in where
# there is none, as on macOS.)
real_cygpath=$(command -v cygpath 2>/dev/null || true)
{
  echo '#!/bin/sh'
  [ -z "$real_cygpath" ] || printf 'exec "%s" "$@"\n' "$real_cygpath"
  # printf '%s\n', never echo: macOS /bin/sh's echo reads the backslashes as escapes (\f, \t)
  printf '%s\n' "case \"\$1\" in -w) printf 'C:\\\\fake\\\\tester\\n' ;; -m) printf 'C:/fake/tester\\n' ;; *) exit 1 ;; esac"
} > "$win_bin/cygpath"
chmod +x "$win_bin/cygpath"
cat > "$R/skillshare/config.yaml" <<'EOF'
sources:
  skills: C:\fake\tester\.config\skillshare\skills
  agents: C:/fake/tester/.config/skillshare/agents
  mixed: C:\fake\tester/.config/skillshare/mixed
  unix: /c/fake/tester/.config/skillshare/unix
  other: C:\elsewhere\skills
EOF
OUT=$(cd "$R" && PATH="$win_bin:$PATH" HOME=/c/fake/tester HERDR_APP_HOME="$H" SKILLSHARE_HOME="$S" sh ./mods/sync/sync.sh 2>&1); RC=$?
assert_status 0 "$RC"
assert_has "normalised paths: skillshare/config.yaml"
assert_eq '  skills: ~/.config\skillshare\skills' "$(sed -n 2p "$R/skillshare/config.yaml")" "backslash home"
assert_eq "  agents: ~/.config/skillshare/agents" "$(sed -n 3p "$R/skillshare/config.yaml")" "forward-slash home"
assert_eq "  mixed: ~/.config/skillshare/mixed" "$(sed -n 4p "$R/skillshare/config.yaml")" "mixed home"
assert_eq "  unix: ~/.config/skillshare/unix" "$(sed -n 5p "$R/skillshare/config.yaml")" "MSYS home"
assert_eq '  other: C:\elsewhere\skills' "$(sed -n 6p "$R/skillshare/config.yaml")" "other paths untouched"
# --check catches a Windows home under Users, either slash
printf 'sources:\n  skills: C:\\%s\\tester\\.config\n' "${U#/}" > "$R/skillshare/config.yaml"
run_sync --check
assert_status 1 "$RC"
printf 'sources:\n  skills: C:%s/tester/.config\n' "$U" > "$R/skillshare/config.yaml"
run_sync --check
assert_status 1 "$RC"

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
# (as a native program is given it on Git Bash: C:/...)
grep -qxF -- "target: $(native "$S")/skills" "$STUB_LOG" && pass || fail "the install target is not $S/skills: $(cat "$STUB_LOG")"
assert_absent "$HOME_DIR/.config/skillshare"
assert_exists "$S/skills/herdr/SKILL.md"
assert_exists "$S/skills/skillshare/SKILL.md"
assert_same_file "$T/metadata.orig" "$R/skillshare/skills/.metadata.json"
# the next run has nothing left to reinstall: $S/skills is a link into the repo (a junction on Git Bash), so the install is
# still there and nothing is backed up
rm -f "$STUB_LOG"
run_sync
assert_status 0 "$RC"
assert_no_reinstall
assert_absent "$STUB_LOG"
assert_lacks "backed up"
assert_has "link ok: $S/skills"

# without SKILLSHARE_HOME the install goes where the config's sources say, ~/.config/skillshare/skills (on Git Bash the
# Skillshare folder is %AppData%\skillshare: a scratch APPDATA, and no XDG_CONFIG_HOME, so the real one is never reached)
new_world "reinstall-default-home"
mkdir -p "$HOME_DIR/.config"
OUT=$(cd "$R" && env -u SKILLSHARE_HOME -u XDG_CONFIG_HOME APPDATA="$T/appdata" HOME="$HOME_DIR" HERDR_APP_HOME="$H" sh ./mods/sync/sync.sh 2>&1); RC=$?
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

