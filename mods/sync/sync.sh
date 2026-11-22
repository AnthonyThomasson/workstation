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
# On Windows (Git Bash, MSYS2, Cygwin) the folder is Skillshare's own there ($XDG_CONFIG_HOME/skillshare, else
# %AppData%\skillshare), agents/ and skills/ are NTFS junctions, config.yaml is a symlink or else a hard link, and the
# config's own sources folders are linked too: see "Skillshare on Windows" below. Elsewhere nothing of that runs.
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
    -h|--help) printf '%s\n' "$usage"; exit 0 ;;
    *) printf '%s\n' "$usage" >&2; exit 2 ;;
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
[ -d "$here/mods" ] && [ -d "$here/layouts" ] || { printf '%s\n' "no mods/ or layouts/ folder at the repo root: $here" >&2; exit 1; }

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
    grep -nE '([/\\]Use[r]s[/\\]|/home/)' "$cfg" > "$tmp/abs" || true   # macOS, Linux and Windows (C:\Users\, C:/Users/) homes
    while IFS= read -r line; do
      printf '%s\n' "absolute home path in skillshare/config.yaml:$line"
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
# windows: Git Bash, MSYS2 or Cygwin. Only the Skillshare part differs there (see "Skillshare on Windows" below).
windows=0
case "$(uname -s 2> /dev/null)" in MINGW*|MSYS*|CYGWIN*) windows=1 ;; esac
# The Skillshare folder: SKILLSHARE_HOME, else where Skillshare itself looks. On Windows that is its BaseDir():
# $XDG_CONFIG_HOME/skillshare when set, else %AppData%\skillshare (~/.config/skillshare only as a last resort).
if [ -n "${SKILLSHARE_HOME:-}" ]; then
  ss=$SKILLSHARE_HOME
elif [ "$windows" -eq 1 ] && [ -n "${XDG_CONFIG_HOME:-}" ]; then
  ss="$(cygpath -u "$XDG_CONFIG_HOME")/skillshare"
elif [ "$windows" -eq 1 ] && [ -n "${APPDATA:-}" ]; then
  ss="$(cygpath -u "$APPDATA")/skillshare"
else
  ss="$HOME/.config/skillshare"
fi

[ -d "$dst" ] || { printf '%s\n' "no Herdr config folder at $dst (start Herdr once, or set HERDR_APP_HOME)" >&2; exit 1; }
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
  printf '%s\n' "$2" >> "$roots"
  { files "$here/$1"; files "$dst/$2"; } | sort -u | while IFS= read -r f; do
    printf '%s\t%s\n' "$1/$f" "$2/$f"
  done >> "$pairs"
}
# map_tracked REPODIR HERDRDIR: only the files the repo has.
map_tracked() {
  files "$here/$1" | sort -u | while IFS= read -r f; do
    printf '%s\n' "$2/$f" >> "$roots"
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
    printf '%s\n' "would replace link with a copy: $rel"
  else
    cp -RL "$dst/$rel" "$dst/$rel.unlink-$$"   # follows the link
    rm "$dst/$rel"
    mv "$dst/$rel.unlink-$$" "$dst/$rel"
    printf '%s\n' "replaced link with a copy: $rel"
  fi
done < "$roots"

to_herdr=0
pruned=0
same=0

# copy LABEL FROM TO HERDRREL: copy one file to Herdr, replacing what is there (no backup).
copy() {
  printf '%s\n' "$1: $4"
  [ "$dry_run" -eq 0 ] || return 0
  # the folder by parameter expansion, made only when missing: a copy starts one program (cp), not three; it counts on
  # Git Bash, where starting a program is slow. $3 is always "$dst/<path>", so it has a / and no trailing one.
  [ -d "${3%/*}" ] || mkdir -p "${3%/*}"
  cp -p "$2" "$3"
}

tab=$(printf '\t')
nl='
'

# same_set: the Herdr paths (one per line) whose file is byte for byte the repo's, found with two git processes in all
# (one per side, each hashing every file that both sides have) rather than one cmp per file. Starting a program per file is
# slow on Git Bash, and there GNU cmp/diff can take many seconds each to start, so a sync of a few hundred files never
# finished. Paths go to git relative to each root, so Git for Windows needs no path conversion; --no-filters hashes the raw
# bytes whatever a surrounding repo's config says. Without git, or if it fails or answers short, hashed stays 0 and each
# pair is compared with cmp as before.
same_set=""
hashed=0
if command -v git > /dev/null 2>&1; then
  : > "$tmp/both-r"; : > "$tmp/both-h"
  while IFS="$tab" read -r rrel hrel; do
    skip "$hrel" && continue
    [ -f "$here/$rrel" ] && [ -f "$dst/$hrel" ] || continue
    printf '%s\n' "$rrel" >> "$tmp/both-r"
    printf '%s\n' "$hrel" >> "$tmp/both-h"
  done < "$pairs"
  if (cd "$here" && git hash-object --no-filters --stdin-paths < "$tmp/both-r") > "$tmp/hash-r" 2> /dev/null &&
    (cd "$dst" && git hash-object --no-filters --stdin-paths < "$tmp/both-h") > "$tmp/hash-h" 2> /dev/null &&
    awk '
      FILENAME == ARGV[1] { p[++np] = $0; next }
      FILENAME == ARGV[2] { r[++nr] = $0; next }
      { h[++nh] = $0 }
      END {
        if (np != nr || np != nh) exit 1
        for (i = 1; i <= np; i++) if (r[i] != "" && r[i] == h[i]) print p[i]
      }
    ' "$tmp/both-h" "$tmp/hash-r" "$tmp/hash-h" > "$tmp/same"; then
    same_set=$(cat "$tmp/same")
    hashed=1
  fi
fi

# is_same A B HERDRREL: whether the repo's file A and Herdr's file B have the same bytes.
is_same() {
  if [ "$hashed" -eq 1 ] && [ -f "$1" ] && [ -f "$2" ]; then
    case "$nl$same_set$nl" in *"$nl$3$nl"*) return 0 ;; *) return 1 ;; esac
  fi
  cmp -s "$1" "$2"
}

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
        printf '%s\n' "removed from Herdr: $hrel"
        [ "$dry_run" -eq 1 ] || rm -f "$b"
        pruned=$((pruned + 1)) ;;
    esac
  elif is_same "$a" "$b" "$hrel"; then
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
printf '%s\n' "$verb: $to_herdr to Herdr, $pruned removed from Herdr; $same already the same"

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
  printf '%s\n' "would link: $dst/sync.json"
else
  printf '{"repo": %s, "remote": %s}\n' "$(json_string "$here")" "$(json_string "$remote")" > "$dst/sync.json.tmp-$$"
  mv "$dst/sync.json.tmp-$$" "$dst/sync.json"
  printf '%s\n' "linked: $dst/sync.json"
fi

# ---------------------------------------------------------------------------------------------
# Skillshare: link its config, agents and skills into the repo.
#
# Skillshare on Windows (Git Bash, MSYS2, Cygwin; elsewhere none of this runs). ln -s there makes a copy, not a link, unless
# Developer Mode (or admin) allows symlinks, so:
#   - agents/ and skills/ are NTFS junctions (mklink /J), as Skillshare links folders itself: no special rights needed.
#   - config.yaml, a single file, is a real symlink when the machine allows one, else a hard link to the repo's file.
#     Skillshare saves its config in place, so its edits land in the repo's file either way. Git replaces a file it
#     changes (a pull, a checkout), which leaves the hard link holding the old copy: the next sync puts the link back,
#     with no backup when that copy is still byte for byte the repo's (else it is backed up, as any real file in the way).
#   - Without SKILLSHARE_HOME, the folders the repo's config names as its sources (sources.skills/.agents, or the older
#     source/agents_source) are linked too: Skillshare reads skills from there, and the repo's ~/.config/skillshare/...
#     is %USERPROFILE%\.config\skillshare there, not the %AppData% folder.
#   - "Already linked" means the same folder or file as the repo's (test -ef), so the path spellings Git Bash mixes
#     (/c/..., /tmp/..., C:/...) do not matter.
linked=0
already=0
if [ "$windows" -eq 1 ]; then
  cmd_exe=$(cygpath -u "${COMSPEC:-${SYSTEMROOT:-C:\Windows}\System32\cmd.exe}")
fi

# is_link_to PATH TARGET: PATH already links to TARGET. On Windows: a junction or symlink to it, or (a file) a hard link.
is_link_to() {
  if [ "$windows" -eq 1 ]; then
    { [ -L "$1" ] || [ -f "$1" ]; } && [ -e "$2" ] && [ "$1" -ef "$2" ]
  else
    [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]
  fi
}

# same_bytes A B (Windows only): whether two files hold the same bytes, by one git hash-object; false without git.
same_bytes() {
  sums=$(git hash-object --no-filters -- "$1" "$2" 2> /dev/null) || return 1
  [ -n "$sums" ] && [ "${sums%%"$nl"*}" = "${sums#*"$nl"}" ]
}

# make_link_windows TARGET LINK: a junction for a folder; for a file a symlink if allowed (winsymlinks:nativestrict fails
# rather than copy), else a hard link. The junction is made by a batch file run from its own folder, the paths passed in the
# environment, so cmd never parses them (spaces, &, ^ are safe). Prints "@hard" for a hard link, and why when it fails.
make_link_windows() {
  if [ -d "$1" ]; then
    printf '@mklink /J "%%SYNC_LINK%%" "%%SYNC_TARGET%%" > nul\r\n' > "$tmp/junction.cmd"
    if (cd "$tmp" && SYNC_LINK=$(cygpath -w "$2") SYNC_TARGET=$(cygpath -w "$1") MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
      "$cmd_exe" /d /c '.\junction.cmd') > "$tmp/link.out" 2>&1 && is_link_to "$2" "$1"; then
      return 0
    fi
    tr -d '\r' < "$tmp/link.out" | grep -v '^[[:space:]]*$' | tail -n 1
    return 1
  fi
  if MSYS=winsymlinks:nativestrict CYGWIN=winsymlinks:nativestrict ln -s "$1" "$2" 2> /dev/null && [ -L "$2" ]; then
    return 0
  fi
  rm -f "$2"
  if ln "$1" "$2" 2> "$tmp/link.out"; then
    echo "@hard"
    return 0
  fi
  printf '%s\n' "no symlink without Developer Mode, and no hard link: $(tail -n 1 "$tmp/link.out")"
  return 1
}

# link_one NAME HAVE: make HAVE a link to skillshare/NAME in the repo, backing up what is in the way.
link_one() {
  want="$here/skillshare/$1"
  have="$2"
  if [ ! -e "$want" ]; then
    printf '%s\n' "skip link (not in the repo): skillshare/$1"
  elif is_link_to "$have" "$want"; then
    printf '%s\n' "link ok: $have"
    already=$((already + 1))
  else
    if [ -L "$have" ]; then
      printf '%s\n' "relink: $have -> $want (was $(readlink "$have"))"
      [ "$dry_run" -eq 1 ] || rm "$have"
    elif [ "$windows" -eq 1 ] && [ -f "$have" ] && [ -f "$want" ] && same_bytes "$have" "$want"; then
      # the copy a hard link is left with once git has replaced the repo's file: nothing in it to keep
      printf '%s\n' "relink: $have -> $want (was a copy of it)"
      [ "$dry_run" -eq 1 ] || rm -f "$have"
    elif [ -e "$have" ]; then
      if [ "$dry_run" -eq 1 ]; then
        printf '%s\n' "would back up: $have -> $have.backup-$stamp"
      else
        mv "$have" "$have.backup-$stamp"
        printf '%s\n' "backed up: $have -> $have.backup-$stamp"
      fi
      printf '%s\n' "link: $have -> $want"
    else
      printf '%s\n' "link: $have -> $want"
    fi
    if [ "$dry_run" -eq 0 ]; then
      mkdir -p "${have%/*}"
      if [ "$windows" -eq 1 ]; then
        if ! how=$(make_link_windows "$want" "$have"); then
          printf '%s\n' "skillshare: could not link $have: $how"
          return 0
        fi
        [ "$how" != "@hard" ] || printf '%s\n' "hard link: $have (symlinks need Developer Mode; the next sync re-links it if git replaces the file)"
      else
        ln -s "$want" "$have"
      fi
    fi
    linked=$((linked + 1))
  fi
}

for name in config.yaml agents skills; do
  link_one "$name" "$ss/$name"
done

# Windows without SKILLSHARE_HOME: the folders the repo's config names as Skillshare's sources (see above), ~ from HOME.
if [ "$windows" -eq 1 ] && [ -z "${SKILLSHARE_HOME:-}" ] && [ -f "$here/skillshare/config.yaml" ]; then
  awk '
    function val(line) { sub(/^[^:]*: */, "", line); sub(/[ \t]+#.*$/, "", line); gsub(/^["\047]|["\047]$/, "", line); return line }
    /^sources:/ { in_s = 1; next }
    /^[^ \t#]/ { in_s = 0 }
    in_s && /^[ \t]+skills:/ { s = val($0) }
    in_s && /^[ \t]+agents:/ { a = val($0) }
    /^source:/ { old_s = val($0) }
    /^agents_source:/ { old_a = val($0) }
    END {
      if (s == "") s = old_s
      if (a == "") a = old_a
      if (s != "") print "skills\t" s
      if (a != "") print "agents\t" a
    }
  ' "$here/skillshare/config.yaml" > "$tmp/sources"
  while IFS="$tab" read -r name src; do
    case "$src" in
      "~") src=$HOME ;;
      "~/"*|"~\\"*) src="$HOME/${src#??}" ;;
    esac
    case "$src" in /*|[A-Za-z]:*) ;; *) continue ;; esac   # relative: not a place to link
    src=$(cygpath -u "$src")
    [ "${src%/}" = "$ss/$name" ] && continue
    link_one "$name" "${src%/}"
  done < "$tmp/sources"
fi
verb="linked"
[ "$dry_run" -eq 0 ] || verb="would link"
printf '%s\n' "skillshare: $verb $linked, $already already linked"

# Skillshare: reinstall the skills recorded in skillshare/skills/.metadata.json whose folder is missing.
# Installed skills are not committed (only skillshare/skills/mine/ is), so on a fresh clone they come
# back from their source at the commit recorded for each: skillshare install <repo>/<subdir> --name
# <entry> --branch <commit>. That rewrites the entry's source/branch/installed_at in .metadata.json, so the
# file is put back as it was. Never fatal: a missing CLI or a failed install (offline) only warns.
meta="$here/skillshare/skills/.metadata.json"
if [ -f "$meta" ]; then
  skills_dir="$ss/skills"
  if [ "$dry_run" -eq 1 ] && ! is_link_to "$skills_dir" "$here/skillshare/skills"; then
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
  # On Windows Skillshare is a native program, so both paths are given the Windows way (C:/...), not as Git Bash spells them.
  skillshare_config=""
  if [ -n "${SKILLSHARE_HOME:-}" ]; then
    skillshare_config="$tmp/skillshare-config.yaml"
    ss_native=$ss
    if [ "$windows" -eq 1 ]; then ss_native=$(cygpath -m "$ss"); fi
    {
      printf 'sources:\n  skills: %s/skills\n  agents: %s/agents\n' "$ss_native" "$ss_native"
      if [ -f "$ss/config.yaml" ]; then
        awk '
          /^sources:/ { skip = 1; next }
          skip && /^([ \t]|#|$)/ { next }
          { skip = 0; print }
        ' "$ss/config.yaml"
      fi
    } > "$skillshare_config"
    if [ "$windows" -eq 1 ]; then skillshare_config=$(cygpath -m "$skillshare_config"); fi
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
      printf '%s\n' "skillshare: could not reinstall $name: no repo_url is recorded for it"
    elif [ "$dry_run" -eq 1 ]; then
      printf '%s\n' "would reinstall: $name"
    elif ! command -v skillshare > /dev/null 2>&1; then
      printf '%s\n' "skillshare: could not reinstall $name: the skillshare CLI was not found"
    else
      if [ "$restored" -eq 0 ]; then
        cp "$meta" "$tmp/metadata.json"
        meta_file="$meta"; meta_saved="$tmp/metadata.json"
        restored=1
      fi
      if reinstall_skill "$name" "$url" "$dir" "$commit" && [ -e "$skills_dir/$name" ]; then
        printf '%s\n' "reinstalled: $name"
      else
        esc=$(printf '\033')
        reason=$(tr -d '\r' < "$tmp/reinstall.out" | sed "s/${esc}\[[0-9;?]*[A-Za-z]//g" | grep -v '^[[:space:]]*$' | tail -n 1)
        printf '%s\n' "skillshare: could not reinstall $name: ${reason:-skillshare install failed}"
      fi
    fi
  done < "$tmp/recorded"
  if [ "$restored" -eq 1 ]; then cat "$tmp/metadata.json" > "$meta"; meta_saved=""; fi
fi

# Keep the config in ~/ form so the username never reaches a commit.
cfg="$here/skillshare/config.yaml"
# On Git Bash, MSYS2 or Cygwin HOME is /c/Users/<name>, but a native Windows program (Skillshare among them) writes it as
# C:\Users\<name> or C:/Users/<name>, so those spellings count too (cygpath, where there is one). awk reads them from the
# environment, since -v would take the backslashes for escapes.
home="${HOME:-}"
home_w=""; home_m=""
if [ -n "$home" ] && command -v cygpath > /dev/null 2>&1; then
  home_w=$(cygpath -w "$home" 2> /dev/null) || home_w=""
  home_m=$(cygpath -m "$home" 2> /dev/null) || home_m=""
fi
if [ -f "$cfg" ] && [ -n "$home" ] && [ "$home" != "/" ] &&
  grep -qF -e "$home/" -e "${home_w:-$home}/" -e "${home_w:-$home}\\" -e "${home_m:-$home}/" "$cfg"; then
  if [ "$dry_run" -eq 1 ]; then
    echo "would normalise paths: skillshare/config.yaml"
  else
    SYNC_HOME_U="$home" SYNC_HOME_W="$home_w" SYNC_HOME_M="$home_m" awk '
      BEGIN {
        n = 0
        h[++n] = ENVIRON["SYNC_HOME_U"] "/"
        if (ENVIRON["SYNC_HOME_W"] != "") { h[++n] = ENVIRON["SYNC_HOME_W"] "/"; h[++n] = ENVIRON["SYNC_HOME_W"] "\\" }
        if (ENVIRON["SYNC_HOME_M"] != "") h[++n] = ENVIRON["SYNC_HOME_M"] "/"
      }
      {
        for (k = 1; k <= n; k++)
          while ((i = index($0, h[k])) > 0) $0 = substr($0, 1, i - 1) "~/" substr($0, i + length(h[k]))
        print
      }' "$cfg" > "$tmp/config.yaml"
    cat "$tmp/config.yaml" > "$cfg"
    echo "normalised paths: skillshare/config.yaml"
  fi
fi
