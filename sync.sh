#!/bin/sh
# Keep this repo's Herdr setup (mods, the Tony layout, themes, workflows) and Skillshare config in
# step with the installed folders.
#
#   ./sync.sh             two-way: the newer copy of each file wins, in either direction
#   ./sync.sh --push      repo -> Herdr only (the repo wins)
#   ./sync.sh --pull      Herdr -> repo only (Herdr wins)
#   ./sync.sh --push --prune  repo -> Herdr, and files in a repo-owned mod folder in Herdr that the repo does
#                          not have are moved to the backup folder (only with --push)
#   ./sync.sh --dry-run   show what would change, write nothing (combine with --push or --pull)
#   ./sync.sh --check     write nothing; exit 1 and name each file when a Tony copy differs from
#                          its entry folder (or no entry owns it), or skillshare/config.yaml has an
#                          absolute home path
#
# What goes where (repo -> the Herdr config folder, ~/.config/herdr-app):
#   herdr/<entry>/mods/<mod>/              -> mods/<mod>/      every entry folder except tony
#   herdr/tony/mods/tabs-icons/            -> mods/tabs-icons/ the one mod that lives only in tony
#   herdr/tony/layouts/Tony.json           -> layouts/Tony.json
#   personal/herdr-app/themes/<file>       -> themes/<file>    only the theme files the repo has
#   personal/herdr-app/workflows/          -> workflows/       new files on either side are carried over
# Herdr does not load a mod's icons and other assets through a symlink, so both sides hold real
# copies. A new file inside a mod folder, on either side, is carried over to the other. A pull goes
# back to the entry folder that owns the mod, never into the copies in herdr/tony/mods/ (except
# tabs-icons). Mods that ship with Herdr are never pulled into the repo. keys.json and settings.json
# are not synced, because Herdr writes to them itself. Generated files (gpui-kit.d.ts, jsconfig.json,
# .DS_Store) are skipped.
#
# Tony's copies: herdr/tony/mods/<mod>/ is an exact copy of each entry folder's mod. After the sync,
# every run (not --dry-run) makes it so: files are added, overwritten and removed to match the entry,
# and a mod folder no entry owns (other than tabs-icons) is removed. --check names those too.
# Never edit those copies by hand; edit the entry folder. --dry-run lists what the refresh would do.
#
# Skillshare: ~/.config/skillshare/{config.yaml,agents,skills} become symlinks to skillshare/ in
# this repo. A real file or folder in the way is moved to <name>.backup-<timestamp> first; a link
# that is already right is left alone; a link to somewhere else is pointed at the repo. Skillshare
# saves absolute paths unless the config says preserve_tilde_on_save: true (the repo's does), and
# keeps whatever it already had, so each real run also rewrites "$HOME/" to "~/" in
# skillshare/config.yaml. Set SKILLSHARE_HOME to use a folder other than ~/.config/skillshare.
#
# Nothing is deleted from the repo's entry folders, and Herdr loses files only with --push --prune (see above). A file you remove on one side comes back
# from the other on the next run, so delete it on both. A file this run overwrites is first saved at
# the same relative path in <config>/.workstation-backup/<timestamp>/ (Herdr's copy) or
# <repo>/.sync-backup/<timestamp>/ (the repo's). A symlink left in the config folder by an older
# version of this script is replaced with a real copy. Tony's copies are not backed up: git has them.
#
# Output: one line per file change, "<what>: <path>", then summary lines ("copied: ...",
# "refreshed Tony's copies: ...", "skillshare: ..."). A sync mod can read these.
# Set HERDR_APP_HOME to use a config folder other than ~/.config/herdr-app.
# Herdr picks up changed layouts and mods without a restart; restart it if something looks stale.
# Commit after a --pull or a two-way run: pulled and refreshed files are edits to the repo.

set -eu

usage="usage: $0 [--push|--pull] [--dry-run] | --check"
dry_run=0
push=1
pull=1
check=0
prune=0
for arg in "$@"; do
  case "$arg" in
    -n|--dry-run) dry_run=1 ;;
    --push) pull=0 ;;
    --pull) push=0 ;;
    --check) check=1 ;;
    --prune) prune=1 ;;
    -h|--help) echo "$usage"; exit 0 ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
[ "$push" -eq 1 ] || [ "$pull" -eq 1 ] || { echo "--push and --pull together are the default two-way sync: leave both off" >&2; exit 2; }
[ "$prune" -eq 0 ] || { [ "$push" -eq 1 ] && [ "$pull" -eq 0 ]; } || { echo "--prune goes with --push" >&2; exit 2; }
if [ "$check" -eq 1 ] && { [ "$dry_run" -eq 1 ] || [ "$push" -eq 0 ] || [ "$pull" -eq 0 ]; }; then
  echo "--check stands alone" >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
[ -d "$here/herdr" ] || { echo "no herdr folder next to this script: $here/herdr" >&2; exit 1; }

tab=$(printf '\t')
tmp=$(mktemp -d "${TMPDIR:-/tmp}/sync.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# skip REL: generated files, which are never synced or compared.
skip() {
  case "$1" in
    .DS_Store|*/.DS_Store|gpui-kit.d.ts|*/gpui-kit.d.ts|jsconfig.json|*/jsconfig.json|layouts/.state/*) return 0 ;;
  esac
  return 1
}

# files DIR: every file under DIR (relative paths), if DIR exists.
files() {
  if [ -d "$1" ]; then (cd "$1" && find . -type f | sed 's|^\./||'); fi
}

# entry_mods: each mod folder an entry owns, relative to the repo (herdr/<entry>/mods/<mod>).
entry_mods() {
  (cd "$here" && find herdr -mindepth 3 -maxdepth 3 -type d -path 'herdr/*/mods/*' ! -path 'herdr/tony/*' | sort)
}

dupes=$(entry_mods | sed 's|.*/||' | sort | uniq -d)
[ -z "$dupes" ] || { echo "two entry folders hold a mod with the same name: $dupes" >&2; exit 1; }

# tony_changes: how herdr/tony/mods/<mod>/ differs from each entry's mod, as
# "<new|changed|removed>\t<entry file>\t<tony file>" (new: Tony lacks it; removed: only Tony has it).
# A --dry-run keeps the files it would pull from Herdr in $tmp/overlay; they stand in for the entry's
# files here, so the dry run reports what a real run would do to Tony after the pull.
tony_changes() {
  entry_mods | while IFS= read -r e; do
    t="herdr/tony/mods/${e##*/}"
    { files "$here/$e"; files "$here/$t"; files "$tmp/overlay/$e"; } | sort -u | while IFS= read -r f; do
      skip "$f" && continue
      src="$here/$e/$f"
      [ ! -e "$tmp/overlay/$e/$f" ] || src="$tmp/overlay/$e/$f"
      if [ ! -e "$here/$t/$f" ]; then printf 'new\t%s\t%s\n' "$e/$f" "$t/$f"
      elif [ ! -e "$src" ]; then printf 'removed\t%s\t%s\n' "$e/$f" "$t/$f"
      elif ! cmp -s "$src" "$here/$t/$f"; then printf 'changed\t%s\t%s\n' "$e/$f" "$t/$f"
      fi
    done
  done
}

# tony_extras: mod folders in herdr/tony/mods/ that no entry folder owns (tabs-icons lives only in
# Tony and is the one exception), as herdr/tony/mods/<mod>.
tony_extras() {
  [ -d "$here/herdr/tony/mods" ] || return 0
  owned=$(entry_mods | sed 's|.*/||')
  for d in "$here"/herdr/tony/mods/*/; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    [ "$n" != tabs-icons ] || continue
    printf '%s\n' "$owned" | grep -qxF "$n" || echo "herdr/tony/mods/$n"
  done
}

# ---------------------------------------------------------------------------------------------
if [ "$check" -eq 1 ]; then
  bad=0
  tony_changes > "$tmp/changes"
  while IFS="$tab" read -r kind ef tf; do
    case "$kind" in
      new) echo "Tony copy missing: $tf (entry: $ef)" ;;
      removed) echo "Tony copy extra: $tf (not in the entry folder)" ;;
      changed) echo "Tony copy differs: $tf (entry: $ef)" ;;
    esac
    bad=1
  done < "$tmp/changes"
  tony_extras | while IFS= read -r x; do
    echo "Tony copy extra: $x (no entry folder owns it)"
  done > "$tmp/extras"
  if [ -s "$tmp/extras" ]; then cat "$tmp/extras"; bad=1; fi
  cfg="$here/skillshare/config.yaml"
  if [ -f "$cfg" ]; then
    grep -nE '(/Use[r]s/|/home/)' "$cfg" > "$tmp/abs" || true
    while IFS= read -r line; do
      echo "absolute home path in skillshare/config.yaml:$line"
      bad=1
    done < "$tmp/abs"
  fi
  if [ "$bad" -eq 1 ]; then
    echo "check failed: edit the entry folders under herdr/ and run ./sync.sh to refresh herdr/tony/mods; keep skillshare/config.yaml paths in ~/ form" >&2
    exit 1
  fi
  echo "ok: herdr/tony/mods matches the entry folders and skillshare/config.yaml has no absolute home paths"
  exit 0
fi

# ---------------------------------------------------------------------------------------------
dst="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
ss="${SKILLSHARE_HOME:-$HOME/.config/skillshare}"

[ -d "$dst" ] || { echo "no Herdr config folder at $dst (start Herdr once, or set HERDR_APP_HOME)" >&2; exit 1; }
dst=$(cd "$dst" && pwd -P)
case "$dst/" in
  "$here"/*|"$(cd "$here" && pwd -P)"/*) echo "the config folder is inside this repo; nothing to sync" >&2; exit 1 ;;
esac

stamp=$(date +%Y%m%d-%H%M%S)
pairs="$tmp/pairs"      # "<repo file>\t<Herdr file relative to the config folder>"
roots="$tmp/roots"      # Herdr paths the repo tracks, to swap old links for copies
: > "$pairs"; : > "$roots"

# map_dir REPODIR HERDRDIR: every file in the folder on either side.
map_dir() {
  echo "$2" >> "$roots"
  { files "$here/$1"; files "$dst/$2"; } | sort -u | while IFS= read -r f; do
    printf '%s\t%s\n' "$1/$f" "$2/$f"
  done >> "$pairs"
}
# map_tracked REPODIR HERDRDIR: only the files the repo has.
map_tracked() {
  files "$here/$1" | sort -u | while IFS= read -r f; do
    echo "$2/$f" >> "$roots"
    printf '%s\t%s\n' "$1/$f" "$2/$f"
  done >> "$pairs"
}

entry_mods | while IFS= read -r e; do
  map_dir "$e" "mods/${e##*/}"
done
map_dir herdr/tony/mods/tabs-icons mods/tabs-icons
echo layouts/Tony.json >> "$roots"
printf 'herdr/tony/layouts/Tony.json\tlayouts/Tony.json\n' >> "$pairs"
map_tracked personal/herdr-app/themes themes
map_dir personal/herdr-app/workflows workflows
sort -u "$pairs" -o "$pairs"

# Swap links left by the old script for real copies, so the sync below sees ordinary files.
while IFS= read -r rel; do
  [ -L "$dst/$rel" ] || continue
  if [ "$dry_run" -eq 1 ]; then
    echo "would replace link with a copy: $rel"
  else
    cp -RL "$dst/$rel" "$dst/$rel.unlink-$$"   # follows the link
    rm "$dst/$rel"
    mv "$dst/$rel.unlink-$$" "$dst/$rel"
    echo "replaced link with a copy: $rel"
  fi
done < "$roots"

to_herdr=0
pruned=0
to_repo=0
same=0

# copy LABEL FROM TO BACKUP HERDRREL: copy one file, saving what it replaces at BACKUP.
copy() {
  echo "$1: $5"
  if [ "$dry_run" -eq 1 ]; then
    case "$3" in   # a file pulled into the repo: keep it where tony_changes can see it
      "$here"/*) mkdir -p "$(dirname "$tmp/overlay/${3#"$here"/}")"; cp -p "$2" "$tmp/overlay/${3#"$here"/}" ;;
    esac
    return 0
  fi
  mkdir -p "$(dirname "$3")"
  if [ -e "$3" ]; then
    mkdir -p "$(dirname "$4")"
    cp -p "$3" "$4"
  fi
  cp -p "$2" "$3"
}

herdr_backup="$dst/.workstation-backup/$stamp"
repo_backup="$here/.sync-backup/$stamp"

while IFS="$tab" read -r rrel hrel; do
  skip "$hrel" && continue
  a="$here/$rrel"   # the repo's copy
  b="$dst/$hrel"    # Herdr's copy

  if [ ! -e "$b" ]; then
    if [ "$push" -eq 1 ]; then copy "to Herdr (new)" "$a" "$b" "$herdr_backup/$hrel" "$hrel"; to_herdr=$((to_herdr + 1)); fi
  elif [ ! -e "$a" ]; then
    if [ "$prune" -eq 1 ]; then
      case "$hrel" in
        mods/*)
          echo "removed from Herdr: $hrel"
          if [ "$dry_run" -eq 0 ]; then mkdir -p "$(dirname "$herdr_backup/$hrel")"; mv "$b" "$herdr_backup/$hrel"; fi
          pruned=$((pruned + 1)) ;;
      esac
    elif [ "$pull" -eq 1 ]; then copy "to repo (new)" "$b" "$a" "$repo_backup/$rrel" "$hrel"; to_repo=$((to_repo + 1)); fi
  elif cmp -s "$a" "$b"; then
    same=$((same + 1))
  elif [ "$push" -eq 1 ] && { [ "$pull" -eq 0 ] || [ "$a" -nt "$b" ]; }; then
    copy "to Herdr" "$a" "$b" "$herdr_backup/$hrel" "$hrel"; to_herdr=$((to_herdr + 1))
  elif [ "$pull" -eq 1 ] && { [ "$push" -eq 0 ] || [ "$b" -nt "$a" ]; }; then
    copy "to repo" "$b" "$a" "$repo_backup/$rrel" "$hrel"; to_repo=$((to_repo + 1))
  else
    same=$((same + 1))
  fi
done < "$pairs"

verb="copied"
[ "$dry_run" -eq 0 ] || verb="would copy"
echo "$verb: $to_herdr to Herdr, $to_repo to the repo; $same already the same$([ "$pruned" -eq 0 ] || echo "; $pruned removed from Herdr")"
if [ "$dry_run" -eq 0 ]; then
  [ ! -d "$herdr_backup" ] || echo "replaced Herdr files were saved to $herdr_backup"
  [ ! -d "$repo_backup" ] || echo "replaced repo files were saved to $repo_backup"
fi

# ---------------------------------------------------------------------------------------------
# Make herdr/tony/mods/<mod>/ an exact copy of each entry's mod.
added=0
changed=0
removed=0
extra=0
tony_changes > "$tmp/changes"
while IFS="$tab" read -r kind ef tf; do
  case "$kind" in
    new) echo "Tony copy (new): $tf"; added=$((added + 1)) ;;
    changed) echo "Tony copy (changed): $tf"; changed=$((changed + 1)) ;;
    removed) echo "Tony copy (removed): $tf"; removed=$((removed + 1)) ;;
  esac
  [ "$dry_run" -eq 0 ] || continue
  case "$kind" in
    removed) rm -f "$here/$tf" ;;
    *) mkdir -p "$(dirname "$here/$tf")"; cp -p "$here/$ef" "$here/$tf" ;;
  esac
done < "$tmp/changes"
if [ "$dry_run" -eq 0 ] && [ "$removed" -gt 0 ] && [ -d "$here/herdr/tony/mods" ]; then
  find "$here/herdr/tony/mods" -depth -mindepth 1 -type d -empty -exec rmdir {} + 2>/dev/null || true
fi
tony_extras > "$tmp/extras"
while IFS= read -r x; do
  echo "Tony copy (extra): $x"
  extra=$((extra + 1))
  [ "$dry_run" -eq 1 ] || rm -rf "$here/$x"
done < "$tmp/extras"
verb="refreshed"
[ "$dry_run" -eq 0 ] || verb="would refresh"
summary="$verb Tony's copies: $added added, $changed changed, $removed removed"
[ "$extra" -eq 0 ] || summary="$summary, $extra extra mod folders removed"
echo "$summary"

# ---------------------------------------------------------------------------------------------
# Skillshare: link its config, agents and skills into the repo.
linked=0
already=0
for name in config.yaml agents skills; do
  want="$here/skillshare/$name"
  have="$ss/$name"
  if [ ! -e "$want" ]; then
    echo "skip link (not in the repo): skillshare/$name"
  elif [ -L "$have" ] && [ "$(readlink "$have")" = "$want" ]; then
    echo "link ok: $have"
    already=$((already + 1))
  else
    if [ -L "$have" ]; then
      echo "relink: $have -> $want (was $(readlink "$have"))"
      [ "$dry_run" -eq 1 ] || rm "$have"
    elif [ -e "$have" ]; then
      if [ "$dry_run" -eq 1 ]; then
        echo "would back up: $have -> $have.backup-$stamp"
      else
        mv "$have" "$have.backup-$stamp"
        echo "backed up: $have -> $have.backup-$stamp"
      fi
      echo "link: $have -> $want"
    else
      echo "link: $have -> $want"
    fi
    if [ "$dry_run" -eq 0 ]; then
      mkdir -p "$ss"
      ln -s "$want" "$have"
    fi
    linked=$((linked + 1))
  fi
done
verb="linked"
[ "$dry_run" -eq 0 ] || verb="would link"
echo "skillshare: $verb $linked, $already already linked"

# Keep the config in ~/ form so the username never reaches a commit.
cfg="$here/skillshare/config.yaml"
home="${HOME:-}"
if [ -f "$cfg" ] && [ -n "$home" ] && [ "$home" != "/" ] && grep -qF "$home/" "$cfg"; then
  if [ "$dry_run" -eq 1 ]; then
    echo "would normalise paths: skillshare/config.yaml"
  else
    awk -v h="$home/" '{
      while ((i = index($0, h)) > 0) $0 = substr($0, 1, i - 1) "~/" substr($0, i + length(h))
      print
    }' "$cfg" > "$tmp/config.yaml"
    cat "$tmp/config.yaml" > "$cfg"
    echo "normalised paths: skillshare/config.yaml"
  fi
fi
