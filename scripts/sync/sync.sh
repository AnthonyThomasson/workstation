#!/bin/sh
# Keep this repo's Herdr setup (mods, the Tony layout, themes, workflows) and Skillshare config in
# step with the installed folders.
#
#   ./scripts/sync/sync.sh             two-way: the newer copy of each file wins, in either direction
#   ./scripts/sync/sync.sh --push      repo -> Herdr only (the repo wins)
#   ./scripts/sync/sync.sh --pull      Herdr -> repo only (Herdr wins)
#   ./scripts/sync/sync.sh --push --prune
#                                     repo -> Herdr, and files in a repo-owned mod folder in Herdr that the repo does
#                                     not have are moved to the backup folder (only with --push)
#   ./scripts/sync/sync.sh --dry-run   show what would change, write nothing (combine with --push or --pull)
#   ./scripts/sync/sync.sh --check     write nothing; fail if skillshare/config.yaml has an absolute home path
#
# What goes where (repo -> the Herdr config folder, ~/.config/herdr-app):
#   mods/<mod>/                        -> mods/<mod>/       every mod
#   layouts/Tony.json                  -> layouts/Tony.json
#   personal/herdr-app/themes/<file>   -> themes/<file>     only the theme files the repo has
#   personal/herdr-app/workflows/      -> workflows/        new files on either side are carried over
# Herdr does not load a mod's icons and other assets through a symlink, so both sides hold real
# copies. A new file inside a mod folder, on either side, is carried over to the other. Each mod's
# RECIPE.md and preview.png, and mods/workflows/starters/, belong only to the repo: they are never
# copied to Herdr, pulled, or pruned. keys.json and settings.json are not synced, because Herdr
# writes to them itself. Generated files (gpui-kit.d.ts, jsconfig.json, .DS_Store) are skipped.
#
# Skillshare: ~/.config/skillshare/{config.yaml,agents,skills} become symlinks to skillshare/ in
# this repo. A real file or folder in the way is moved to <name>.backup-<timestamp> first; a link
# that is already right is left alone; a link to somewhere else is pointed at the repo. Skillshare
# saves absolute paths unless the config says preserve_tilde_on_save: true (the repo's does), and
# keeps whatever it already had, so each real run also rewrites "$HOME/" to "~/" in
# skillshare/config.yaml. Set SKILLSHARE_HOME to use a folder other than ~/.config/skillshare.
# Only skillshare/skills/mine/ and skillshare/skills/.metadata.json are committed: every real run
# also reinstalls each skill recorded in .metadata.json whose folder is missing (see below), at its
# recorded commit. --dry-run prints "would reinstall: <name>"; --check never does it; a missing
# skillshare CLI or a failed install (offline) is a warning, never an error.
#
# Nothing is deleted from the repo, and Herdr loses files only with --push --prune (see above). A file you remove on one side comes back
# from the other on the next run, so delete it on both. A file this run overwrites is first saved at
# the same relative path in <config>/.workstation-backup/<timestamp>/ (Herdr's copy) or
# <repo>/.sync-backup/<timestamp>/ (the repo's). A symlink left in the config folder by an older
# version of this script is replaced with a real copy.
#
# Output: one line per file change, "<what>: <path>", then summary lines ("copied: ...",
# "skillshare: ...", "reinstalled: <name>"). A sync mod can read these.
# Set HERDR_APP_HOME to use a config folder other than ~/.config/herdr-app.
# Herdr picks up changed layouts and mods without a restart; restart it if something looks stale.
# Commit after a --pull or a two-way run: pulled files are edits to the repo.

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

script_dir=$(cd "$(dirname "$0")" && pwd)
here=$(cd "$script_dir/../.." && pwd)
[ -d "$here/mods" ] && [ -d "$here/layouts" ] || { echo "no mods/ or layouts/ folder at the repo root: $here" >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/sync.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# skip REL: generated files and repository-only mod documentation/artwork, which are never synced.
skip() {
  case "$1" in
    .DS_Store|*/.DS_Store|gpui-kit.d.ts|*/gpui-kit.d.ts|jsconfig.json|*/jsconfig.json|layouts/.state/*) return 0 ;;
    mods/*/RECIPE.md|mods/*/preview.png|mods/workflows/starters/*) return 0 ;;
  esac
  return 1
}

# files DIR: every file under DIR (relative paths), if DIR exists.
files() {
  if [ -d "$1" ]; then (cd "$1" && find . -type f | sed 's|^\./||'); fi
}

# repo_mods: each mod folder, relative to the repo (mods/<mod>).
repo_mods() {
  (cd "$here" && find mods -mindepth 1 -maxdepth 1 -type d | sort)
}

# ---------------------------------------------------------------------------------------------
if [ "$check" -eq 1 ]; then
  bad=0
  cfg="$here/skillshare/config.yaml"
  if [ -f "$cfg" ]; then
    grep -nE '(/Use[r]s/|/home/)' "$cfg" > "$tmp/abs" || true
    while IFS= read -r line; do
      echo "absolute home path in skillshare/config.yaml:$line"
      bad=1
    done < "$tmp/abs"
  fi
  if [ "$bad" -eq 1 ]; then
    echo "check failed: keep skillshare/config.yaml paths in ~/ form" >&2
    exit 1
  fi
  echo "ok: skillshare/config.yaml has no absolute home paths"
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

repo_mods | while IFS= read -r m; do
  map_dir "$m" "$m"
done
echo layouts/Tony.json >> "$roots"
printf 'layouts/Tony.json\tlayouts/Tony.json\n' >> "$pairs"
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
  [ "$dry_run" -eq 0 ] || return 0
  mkdir -p "$(dirname "$3")"
  if [ -e "$3" ]; then
    mkdir -p "$(dirname "$4")"
    cp -p "$3" "$4"
  fi
  cp -p "$2" "$3"
}

herdr_backup="$dst/.workstation-backup/$stamp"
repo_backup="$here/.sync-backup/$stamp"

tab=$(printf '\t')
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

# Skillshare: reinstall the skills recorded in skillshare/skills/.metadata.json whose folder is missing.
# Installed skills are not committed (only skillshare/skills/mine/ is), so on a fresh clone they come
# back from their source at the commit recorded for each: skillshare install <repo>/<subdir> --name
# <entry> --branch <commit>. That rewrites the entry's source/branch/installed_at in .metadata.json, so the
# file is put back as it was. Never fatal: a missing CLI or a failed install (offline) only warns.
meta="$here/skillshare/skills/.metadata.json"
if [ -f "$meta" ]; then
  skills_dir="$ss/skills"
  if [ "$dry_run" -eq 1 ] && ! { [ -L "$skills_dir" ] && [ "$(readlink "$skills_dir")" = "$here/skillshare/skills" ]; }; then
    skills_dir="$here/skillshare/skills"   # not linked yet: a real run would link it first
  fi

  # reinstall_skill NAME REPO_URL SUBDIR COMMIT: install one recorded skill; prints why it failed.
  reinstall_skill() {
    src=${2%.git}
    case "$src" in https://*) src=${src#https://} ;; http://*) src=${src#http://} ;; esac
    if [ -n "$3" ]; then
      case "$src" in git@*) src="$src//$3" ;; *) src="$src/$3" ;; esac
    fi
    set -- "$1" "$src" "$4"
    set -- install "$2" --name "$1" ${3:+--branch "$3"} -y -g
    # An alternative Skillshare folder (SKILLSHARE_HOME) is used through its linked config.
    if [ -n "${SKILLSHARE_HOME:-}" ] && [ -z "${SKILLSHARE_CONFIG:-}" ] && [ -f "$ss/config.yaml" ]; then
      SKILLSHARE_CONFIG="$ss/config.yaml" skillshare "$@" > "$tmp/reinstall.out" 2>&1 < /dev/null
    else
      skillshare "$@" > "$tmp/reinstall.out" 2>&1 < /dev/null
    fi
  }

  # name|repo_url|subdir|commit for each recorded entry (entries are indented 4 spaces, their fields 6).
  awk '
    function field(line) { sub(/^[^:]*: *"/, "", line); sub(/",? *$/, "", line); return line }
    function flush() { if (entry != "") printf "%s|%s|%s|%s\n", entry, url, dir, commit }
    /^    "[^"]+": \{ *$/ { flush(); entry = $0; sub(/^    "/, "", entry); sub(/".*/, "", entry); url = ""; dir = ""; commit = ""; next }
    entry != "" && /^      "repo_url": / { url = field($0) }
    entry != "" && /^      "subdir": / { dir = field($0) }
    entry != "" && /^      "commit": / { commit = field($0) }
    END { flush() }
  ' "$meta" > "$tmp/recorded"

  restored=0
  while IFS='|' read -r name url dir commit; do
    [ -n "$name" ] || continue
    [ ! -e "$skills_dir/$name" ] || continue
    if [ -z "$url" ]; then
      echo "skillshare: could not reinstall $name: no repo_url is recorded for it"
    elif [ "$dry_run" -eq 1 ]; then
      echo "would reinstall: $name"
    elif ! command -v skillshare > /dev/null 2>&1; then
      echo "skillshare: could not reinstall $name: the skillshare CLI was not found"
    else
      [ "$restored" -eq 1 ] || cp "$meta" "$tmp/metadata.json"
      restored=1
      if reinstall_skill "$name" "$url" "$dir" "$commit" && [ -e "$skills_dir/$name" ]; then
        echo "reinstalled: $name"
      else
        reason=$(tr -d '\r' < "$tmp/reinstall.out" | grep -v '^[[:space:]]*$' | tail -n 1)
        echo "skillshare: could not reinstall $name: ${reason:-skillshare install failed}"
      fi
    fi
  done < "$tmp/recorded"
  [ "$restored" -eq 0 ] || cat "$tmp/metadata.json" > "$meta"
fi

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
