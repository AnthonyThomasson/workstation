#!/bin/sh
# Keep the Herdr config folder (~/.config/herdr-app) and Skillshare in step with this clone: copy
# the repo's Herdr setup (mods, the Tony layout, themes, workflows) into Herdr, link Skillshare to
# the repo, and record which clone did it.
#
#   ./mods/sync/sync.sh             repo -> Herdr, with prune; links this clone (writes sync.json)
#   ./mods/sync/sync.sh --dry-run   show what would change, write nothing (no sync.json either)
#   ./mods/sync/sync.sh --check     write nothing; fail if skillshare/config.yaml has an absolute home path
#
# What goes where (repo -> the Herdr config folder, ~/.config/herdr-app):
#   mods/<mod>/                        -> mods/<mod>/       every mod, this one (sync.sh and its test) included
#   layouts/Tony.json                  -> layouts/Tony.json
#   preview.png                        -> layouts/Tony.png   (the picture the layout picker shows)
#   personal/herdr-app/themes/<file>   -> themes/<file>
#   personal/herdr-app/workflows/<file> -> workflows/<file>
# Herdr does not load a mod's icons and other assets through a symlink, so Herdr holds real copies.
# The repo always wins: a differing file in Herdr is overwritten, with no backup. Each mod's
# RECIPE.md and preview.png (but not the root preview.png, which is Tony's) belong only to the repo
# and are never copied. Herdr's top-level keys.json and settings.json are not synced, because Herdr
# writes to them itself (a mod's own keys.json is an ordinary mod file and is copied). Generated files (gpui-kit.d.ts, jsconfig.json, .DS_Store) are skipped.
#
# Prune: a file inside a repo-owned mod folder in Herdr (mods/<mod>/ for a mod the repo has) that the
# repo no longer has is deleted, and so is a folder that leaves empty. Nothing else in Herdr is
# removed, and nothing is ever deleted from the repo. A symlink left in the config folder by an
# older version of this script is replaced with a real copy.
#
# sync.json: every real run writes <config>/sync.json, {"repo": "<this clone>", "remote": "<its
# origin URL, or empty>"}, so the Sync mod knows which clone to watch. The last clone to run wins.
#
# Skillshare: ~/.config/skillshare/{config.yaml,agents,skills} become symlinks to skillshare/ in
# this repo. A real file or folder in the way is moved to <name>.backup-<timestamp> first; a link
# that is already right is left alone; a link to somewhere else is pointed at the repo. Skillshare
# saves absolute paths unless the config says preserve_tilde_on_save: true (the repo's does), and
# keeps whatever it already had, so each real run also rewrites "$HOME/" to "~/" in
# skillshare/config.yaml. Set SKILLSHARE_HOME to use a folder other than ~/.config/skillshare.
# Only skillshare/skills/mine/ and skillshare/skills/.metadata.json are committed: every real run
# also reinstalls each skill recorded in .metadata.json whose folder is missing (see below), at its
# recorded commit (with SKILLSHARE_HOME set, into that folder, through a temporary copy of its config).
# --dry-run prints "would reinstall: <name>"; --check never does it; a missing skillshare CLI or a
# failed install (offline) is a warning, never an error.
#
# Output: one line per change, "<what>: <path>" ("to Herdr (new): <path>", "to Herdr: <path>",
# "removed from Herdr: <path>"), then summary lines ("copied: <n> to Herdr, <m> removed from Herdr;
# <k> already the same", "linked: <sync.json>", "skillshare: ...", "reinstalled: <name>").
# Exit 0 on success, 1 on a failure, 2 on bad arguments.
# Set HERDR_APP_HOME to use a config folder other than ~/.config/herdr-app. The folder must exist:
# start Herdr once. Herdr picks up changed layouts and mods without a restart; restart it if
# something looks stale.

set -eu

usage="usage: $0 [--dry-run] | --check"
dry_run=0
check=0
for arg in "$@"; do
  case "$arg" in
    -n|--dry-run) dry_run=1 ;;
    --check) check=1 ;;
    -h|--help) echo "$usage"; exit 0 ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
if [ "$check" -eq 1 ] && [ "$dry_run" -eq 1 ]; then
  echo "--check stands alone" >&2
  exit 2
fi

# The clone is the git top level of this script's folder (the script sits two folders below it); without git, two folders up.
script_dir=$(cd "$(dirname "$0")" && pwd)
if here=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) && [ -n "$here" ]; then
  in_git=1
else
  in_git=0
  here=$(cd "$script_dir/../.." && pwd)
fi
[ -d "$here/mods" ] && [ -d "$here/layouts" ] || { echo "no mods/ or layouts/ folder at the repo root: $here" >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/sync.XXXXXX")
# cleanup: put .metadata.json back if a skill reinstall was interrupted (it rewrites the file), drop $tmp.
meta_saved=""
meta_file=""
cleanup() {
  if [ -n "$meta_saved" ] && [ -f "$meta_saved" ]; then cat "$meta_saved" > "$meta_file"; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

# skip REL: generated files and repository-only mod documentation/artwork, which are never synced.
skip() {
  case "$1" in
    .DS_Store|*/.DS_Store|gpui-kit.d.ts|*/gpui-kit.d.ts|jsconfig.json|*/jsconfig.json|layouts/.state/*) return 0 ;;
    mods/*/RECIPE.md|mods/*/preview.png) return 0 ;;
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

# map_dir REPODIR HERDRDIR: every file in the folder on either side (Herdr-only ones get pruned).
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
echo layouts/Tony.png >> "$roots"
printf 'preview.png\tlayouts/Tony.png\n' >> "$pairs"
map_tracked personal/herdr-app/themes themes
map_tracked personal/herdr-app/workflows workflows
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
same=0

# copy LABEL FROM TO HERDRREL: copy one file to Herdr, replacing what is there (no backup).
copy() {
  echo "$1: $4"
  [ "$dry_run" -eq 0 ] || return 0
  mkdir -p "$(dirname "$3")"
  cp -p "$2" "$3"
}

tab=$(printf '\t')
while IFS="$tab" read -r rrel hrel; do
  skip "$hrel" && continue
  a="$here/$rrel"   # the repo's copy
  b="$dst/$hrel"    # Herdr's copy

  if [ ! -e "$b" ]; then
    copy "to Herdr (new)" "$a" "$b" "$hrel"; to_herdr=$((to_herdr + 1))
  elif [ ! -e "$a" ]; then
    # Prune: only files in a repo-owned mod folder go; anything else only Herdr has stays.
    case "$hrel" in
      mods/*)
        echo "removed from Herdr: $hrel"
        [ "$dry_run" -eq 1 ] || rm -f "$b"
        pruned=$((pruned + 1)) ;;
    esac
  elif cmp -s "$a" "$b"; then
    same=$((same + 1))
  else
    copy "to Herdr" "$a" "$b" "$hrel"; to_herdr=$((to_herdr + 1))
  fi
done < "$pairs"

# A folder the prune emptied goes too (the mod folder itself stays).
if [ "$pruned" -gt 0 ] && [ "$dry_run" -eq 0 ]; then
  repo_mods | while IFS= read -r m; do
    find "$dst/$m" -mindepth 1 -type d -empty -delete 2>/dev/null || true
  done
fi

verb="copied"
[ "$dry_run" -eq 0 ] || verb="would copy"
echo "$verb: $to_herdr to Herdr, $pruned removed from Herdr; $same already the same"

# ---------------------------------------------------------------------------------------------
# sync.json: tell the Sync mod which clone this is. Last run wins.

# json_string TEXT: TEXT as a JSON string (quotes included).
json_string() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$tab/\\\\t/g" -e "s/$(printf '\r')/\\\\r/g" |
    awk 'BEGIN { printf "\"" } NR > 1 { printf "\\n" } { printf "%s", $0 } END { printf "\"" }'
}
remote=""
if [ "$in_git" -eq 1 ]; then remote=$(git -C "$here" remote get-url origin 2>/dev/null || true); fi
if [ "$dry_run" -eq 1 ]; then
  echo "would link: $dst/sync.json"
else
  printf '{"repo": %s, "remote": %s}\n' "$(json_string "$here")" "$(json_string "$remote")" > "$dst/sync.json.tmp-$$"
  mv "$dst/sync.json.tmp-$$" "$dst/sync.json"
  echo "linked: $dst/sync.json"
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
    if [ -n "$skillshare_config" ]; then
      SKILLSHARE_CONFIG="$skillshare_config" skillshare "$@" > "$tmp/reinstall.out" 2>&1 < /dev/null
    else
      skillshare "$@" > "$tmp/reinstall.out" 2>&1 < /dev/null
    fi
  }

  # With SKILLSHARE_HOME set, Skillshare would still install where the config's sources say (the repo's
  # config says ~/.config/skillshare/skills, which expands from HOME), so give it a copy of the config
  # whose sources are this Skillshare folder. Without SKILLSHARE_HOME the folder is Skillshare's default.
  skillshare_config=""
  if [ -n "${SKILLSHARE_HOME:-}" ]; then
    skillshare_config="$tmp/skillshare-config.yaml"
    {
      printf 'sources:\n  skills: %s/skills\n  agents: %s/agents\n' "$ss" "$ss"
      if [ -f "$ss/config.yaml" ]; then
        awk '
          /^sources:/ { skip = 1; next }
          skip && /^([ \t]|#|$)/ { next }
          { skip = 0; print }
        ' "$ss/config.yaml"
      fi
    } > "$skillshare_config"
  fi

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
      if [ "$restored" -eq 0 ]; then
        cp "$meta" "$tmp/metadata.json"
        meta_file="$meta"; meta_saved="$tmp/metadata.json"
        restored=1
      fi
      if reinstall_skill "$name" "$url" "$dir" "$commit" && [ -e "$skills_dir/$name" ]; then
        echo "reinstalled: $name"
      else
        esc=$(printf '\033')
        reason=$(tr -d '\r' < "$tmp/reinstall.out" | sed "s/${esc}\[[0-9;?]*[A-Za-z]//g" | grep -v '^[[:space:]]*$' | tail -n 1)
        echo "skillshare: could not reinstall $name: ${reason:-skillshare install failed}"
      fi
    fi
  done < "$tmp/recorded"
  if [ "$restored" -eq 1 ]; then cat "$tmp/metadata.json" > "$meta"; meta_saved=""; fi
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
