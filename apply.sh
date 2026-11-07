#!/bin/sh
# Apply this repo's Herdr setup (layouts, themes and mods) to the installed Herdr config folder.
#
#   ./apply.sh             copy changed files into ~/.config/herdr-app
#   ./apply.sh --dry-run   show what would change, write nothing
#
# Only files that differ are copied. Before a file is replaced, its old copy is saved under
# <config>/.workstation-backup/<timestamp>/ at the same relative path, so it can be copied back.
# Nothing is deleted: a file removed from the repo stays in the installed folder.
# keys.json and settings.json are not touched, because Herdr writes to them itself.
# Test files (*.test.js) are not copied, since Herdr never loads them.
# Set HERDR_APP_HOME to apply to a config folder other than ~/.config/herdr-app.
# Restart Herdr afterwards to pick the changes up.

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

stamp=$(date +%Y%m%d-%H%M%S)
backup="$dst/.workstation-backup/$stamp"
list=$(mktemp)
trap 'rm -f "$list"' EXIT

# Every file under layouts/, themes/ and mods/, as paths relative to herdr-app/.
(cd "$src" && find layouts themes mods -type f ! -name '.DS_Store' ! -name '*.test.js' 2>/dev/null | sort) > "$list"

new=0
updated=0
same=0
while IFS= read -r rel; do
  from="$src/$rel"
  to="$dst/$rel"
  if [ ! -e "$to" ]; then
    state=new
  elif cmp -s "$from" "$to"; then
    same=$((same + 1))
    continue
  else
    state=update
  fi

  if [ "$dry_run" -eq 1 ]; then
    if [ "$state" = update ]; then
      diff -u "$to" "$from" || true
    fi
    echo "would $state: $rel"
  else
    if [ "$state" = update ]; then
      mkdir -p "$(dirname "$backup/$rel")"
      cp "$to" "$backup/$rel"
    fi
    mkdir -p "$(dirname "$to")"
    cp "$from" "$to"
    echo "$state: $rel"
  fi

  if [ "$state" = new ]; then
    new=$((new + 1))
  else
    updated=$((updated + 1))
  fi
done < "$list"

if [ "$dry_run" -eq 1 ]; then
  echo "dry run: $new new, $updated to update, $same unchanged"
  exit 0
fi

if [ $((new + updated)) -eq 0 ]; then
  echo "already up to date: $same files unchanged"
  exit 0
fi

echo "applied: $new new, $updated updated, $same unchanged"
if [ "$updated" -gt 0 ]; then
  echo "replaced files were saved to $backup"
fi
echo "restart Herdr to pick up the changes"
