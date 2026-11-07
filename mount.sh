#!/bin/sh
# Link this repo's Herdr setup (layouts, themes and mods) into the installed Herdr config folder.
#
#   ./mount.sh             create the symlinks in ~/.config/herdr-app
#   ./mount.sh --dry-run   show what would change, write nothing
#
# Each layout file, theme file and mod folder in herdr-app/ becomes a symlink to the repo copy, so
# editing either side edits the same file and nothing needs copying again. Re-running is safe: links
# that already point at the repo are left alone, and new files in the repo get linked.
#
# A real file or folder that is in the way is moved to <config>/.workstation-backup/<timestamp>/ at
# the same relative path before it is replaced, so it can be moved back. Nothing else is deleted: a
# file removed from the repo leaves a dangling link behind until you remove it.
# keys.json and settings.json are not linked, because Herdr writes to them itself.
# layouts/.state/ (Herdr's saved sizes and theme picks) stays local and is never linked.
# Links use absolute paths, so run this again if you move the repo.
# Set HERDR_APP_HOME to link into a config folder other than ~/.config/herdr-app.
# Herdr picks up linked layouts and mods without a restart; restart it if something looks stale.

set -eu

dry_run=0
case "${1:-}" in
  "") ;;
  -n|--dry-run) dry_run=1 ;;
  -h|--help) echo "usage: $0 [--dry-run]"; exit 0 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

here=$(cd "$(dirname "$0")" && pwd)
src="$here/herdr-app"
dst="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

[ -d "$src" ] || { echo "no herdr-app folder next to this script: $src" >&2; exit 1; }
[ -d "$dst" ] || { echo "no Herdr config folder at $dst (start Herdr once, or set HERDR_APP_HOME)" >&2; exit 1; }
dst=$(cd "$dst" && pwd -P)
[ "$dst" != "$(cd "$src" && pwd -P)" ] || { echo "the config folder is the repo's herdr-app folder; nothing to link" >&2; exit 1; }

stamp=$(date +%Y%m%d-%H%M%S)
backup="$dst/.workstation-backup/$stamp"
list=$(mktemp)
trap 'rm -f "$list"' EXIT

# Things to link, as paths relative to herdr-app/: layout files, theme files and whole mod folders.
(
  cd "$src"
  find layouts themes -maxdepth 1 -type f ! -name '.DS_Store' 2>/dev/null
  find mods -mindepth 1 -maxdepth 1 -type d 2>/dev/null
) | sort > "$list"

new=0
replaced=0
same=0
while IFS= read -r rel; do
  from="$src/$rel"
  to="$dst/$rel"

  if [ -L "$to" ] && [ "$(readlink "$to")" = "$from" ]; then
    same=$((same + 1))
    continue
  fi

  if [ ! -e "$to" ] && [ ! -L "$to" ]; then
    state=link
  elif [ -L "$to" ]; then
    state=relink   # a link to somewhere else (or a dangling one): replace it, nothing to back up
  else
    state=replace  # a real file or folder: back it up first
  fi

  if [ "$dry_run" -eq 1 ]; then
    echo "would $state: $rel"
  else
    mkdir -p "$(dirname "$to")"
    if [ "$state" = replace ]; then
      mkdir -p "$(dirname "$backup/$rel")"
      mv "$to" "$backup/$rel"
    elif [ "$state" = relink ]; then
      rm "$to"
    fi
    ln -s "$from" "$to"
    echo "$state: $rel"
  fi

  if [ "$state" = link ]; then
    new=$((new + 1))
  else
    replaced=$((replaced + 1))
  fi
done < "$list"

if [ "$dry_run" -eq 1 ]; then
  echo "dry run: $new to link, $replaced to replace, $same already linked"
  exit 0
fi

if [ $((new + replaced)) -eq 0 ]; then
  echo "already linked: $same items"
  exit 0
fi

echo "linked: $new new, $replaced replaced, $same already linked"
if [ -d "$backup" ]; then
  echo "replaced files and folders were moved to $backup"
fi
