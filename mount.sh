#!/bin/sh
# Keep this repo's Herdr setup (layouts, themes and mods) and the installed Herdr config folder in step.
#
#   ./mount.sh             two-way: the newer copy of each file wins, in either direction
#   ./mount.sh --push      repo -> Herdr only (the repo wins)
#   ./mount.sh --pull      Herdr -> repo only (Herdr wins)
#   ./mount.sh --dry-run   show what would change, write nothing (combine with --push or --pull)
#
# Herdr does not load a mod's icons and other assets through a symlink, so both sides hold real
# copies. Only what the repo already tracks is synced: each layout file, theme file and mod folder in
# herdr-app/. Mods that ship with Herdr are never pulled into the repo. A new file inside a tracked
# mod, on either side, is carried over to the other.
#
# Nothing is deleted. A file you remove on one side comes back from the other on the next run, so
# delete it on both. A file this run overwrites is first saved at the same relative path in
# <config>/.workstation-backup/<timestamp>/ (Herdr's copy) or <repo>/.sync-backup/<timestamp>/ (the repo's).
# A symlink left in the config folder by an older version of this script is replaced with a real copy.
# keys.json and settings.json are not synced, because Herdr writes to them itself.
# layouts/.state/ (Herdr's saved sizes and theme picks) and generated files (gpui-kit.d.ts,
# jsconfig.json, .DS_Store) are skipped.
# Set HERDR_APP_HOME to use a config folder other than ~/.config/herdr-app.
# Herdr picks up changed layouts and mods without a restart; restart it if something looks stale.
# Commit after a --pull or a two-way run: pulled changes are edits to the repo.

set -eu

dry_run=0
push=1
pull=1
for arg in "$@"; do
  case "$arg" in
    -n|--dry-run) dry_run=1 ;;
    --push) pull=0 ;;
    --pull) push=0 ;;
    -h|--help) echo "usage: $0 [--push|--pull] [--dry-run]"; exit 0 ;;
    *) echo "usage: $0 [--push|--pull] [--dry-run]" >&2; exit 2 ;;
  esac
done
[ "$push" -eq 1 ] || [ "$pull" -eq 1 ] || { echo "--push and --pull together are the default two-way sync: leave both off" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
src="$here/herdr-app"
dst="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

[ -d "$src" ] || { echo "no herdr-app folder next to this script: $src" >&2; exit 1; }
[ -d "$dst" ] || { echo "no Herdr config folder at $dst (start Herdr once, or set HERDR_APP_HOME)" >&2; exit 1; }
dst=$(cd "$dst" && pwd -P)
[ "$dst" != "$(cd "$src" && pwd -P)" ] || { echo "the config folder is the repo's herdr-app folder; nothing to sync" >&2; exit 1; }

stamp=$(date +%Y%m%d-%H%M%S)
tracked=$(mktemp)
list=$(mktemp)
trap 'rm -f "$tracked" "$list"' EXIT

# What the repo tracks, relative to herdr-app/: layout files, theme files and whole mod folders.
(
  cd "$src"
  find layouts themes -maxdepth 1 -type f ! -name '.DS_Store' 2>/dev/null
  find mods -mindepth 1 -maxdepth 1 -type d 2>/dev/null
) | sort > "$tracked"

# Swap links left by the old script for real copies, so the sync below sees ordinary files.
while IFS= read -r rel; do
  [ -L "$dst/$rel" ] || continue
  if [ "$dry_run" -eq 1 ]; then
    echo "would replace link with a copy: $rel"
  else
    tmp="$dst/$rel.unlink-$$"
    cp -RL "$dst/$rel" "$tmp"   # follows the link
    rm "$dst/$rel"
    mv "$tmp" "$dst/$rel"
    echo "replaced link with a copy: $rel"
  fi
done < "$tracked"

skip() {
  case "$1" in
    */.DS_Store|*/gpui-kit.d.ts|*/jsconfig.json|layouts/.state/*) return 0 ;;
  esac
  return 1
}

# Every file in the tracked places, on either side.
while IFS= read -r rel; do
  if [ -d "$src/$rel" ]; then
    (cd "$src" && find "$rel" -type f)
    if [ -d "$dst/$rel" ]; then (cd "$dst" && find "$rel" -type f); fi
  else
    echo "$rel"
  fi
done < "$tracked" | sort -u > "$list"

to_herdr=0
to_repo=0
same=0

# copy REL FROM TO LABEL BACKUPDIR: copy one file, saving what it replaces.
copy() {
  echo "$4: $1"
  [ "$dry_run" -eq 0 ] || return 0
  from="$2"; to="$3"; rel="$1"
  mkdir -p "$(dirname "$to")"
  if [ -e "$to" ]; then
    mkdir -p "$(dirname "$5/$rel")"
    cp -p "$to" "$5/$rel"
  fi
  cp -p "$from" "$to"
}

herdr_backup="$dst/.workstation-backup/$stamp"
repo_backup="$here/.sync-backup/$stamp"

while IFS= read -r rel; do
  skip "$rel" && continue
  a="$src/$rel"   # the repo's copy
  b="$dst/$rel"   # Herdr's copy

  if [ ! -e "$b" ]; then
    if [ "$push" -eq 1 ]; then copy "$rel" "$a" "$b" "to Herdr (new)" "$herdr_backup"; to_herdr=$((to_herdr + 1)); fi
  elif [ ! -e "$a" ]; then
    if [ "$pull" -eq 1 ]; then copy "$rel" "$b" "$a" "to repo (new)" "$repo_backup"; to_repo=$((to_repo + 1)); fi
  elif cmp -s "$a" "$b"; then
    same=$((same + 1))
  elif [ "$push" -eq 1 ] && { [ "$pull" -eq 0 ] || [ "$a" -nt "$b" ]; }; then
    copy "$rel" "$a" "$b" "to Herdr" "$herdr_backup"; to_herdr=$((to_herdr + 1))
  elif [ "$pull" -eq 1 ] && { [ "$push" -eq 0 ] || [ "$b" -nt "$a" ]; }; then
    copy "$rel" "$b" "$a" "to repo" "$repo_backup"; to_repo=$((to_repo + 1))
  else
    same=$((same + 1))
  fi
done < "$list"

verb="copied"
[ "$dry_run" -eq 0 ] || verb="would copy"
echo "$verb: $to_herdr to Herdr, $to_repo to the repo; $same already the same"
if [ "$dry_run" -eq 0 ]; then
  [ ! -d "$herdr_backup" ] || echo "replaced Herdr files were saved to $herdr_backup"
  [ ! -d "$repo_backup" ] || echo "replaced repo files were saved to $repo_backup"
fi
