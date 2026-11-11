#!/bin/sh
# Check the Tony layout and every standalone mod gallery entry.
# Run with: sh tests/entries.test.sh

set -u

repo=$(cd "$(dirname "$0")/.." && pwd)
failures=0

fail() {
  printf 'FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

[ -f "$repo/RECIPE.md" ] || fail "Tony: missing root RECIPE.md"
[ -f "$repo/preview.png" ] || fail "Tony: missing root preview.png"
[ -f "$repo/layouts/Tony.json" ] || fail "Tony: missing layouts/Tony.json"

for entry in "$repo"/mods/*/; do
  [ -d "$entry" ] || continue
  name=${entry%/}
  name=${name##*/}

  [ -f "$entry/RECIPE.md" ] || fail "$name: missing RECIPE.md"
  [ -f "$entry/preview.png" ] || fail "$name: missing preview.png"
  [ -f "$entry/mod.json" ] || fail "$name: missing mod.json"
done

layout="$repo/layouts/Tony.json"
if [ -f "$layout" ]; then
  references=$(node -e '
    const fs = require("fs");
    const layout = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const mods = new Set();
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (node.content && typeof node.content.mod === "string") mods.add(node.content.mod);
      if (typeof node.terminal_menu === "string") mods.add(node.terminal_menu);
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") visit(value);
      }
    }
    visit(layout);
    for (const mod of [...mods].sort()) console.log(mod);
  ' "$layout" 2>&1)
  status=$?
  if [ "$status" -ne 0 ]; then
    fail "Tony: could not read layouts/Tony.json: $references"
  else
    for name in $references; do
      case "$name" in
        spaces|agents|changes|files|pane|workspace-chrome|artifacts)
          # These mods ship with Herdr and deliberately are not copied here.
          ;;
        *)
          [ -f "$repo/mods/$name/mod.json" ] || fail "Tony: referenced mod $name is missing from mods/"
          ;;
      esac
    done
  fi
fi

preview="$repo/preview.png"
if [ -f "$preview" ]; then
  dimensions=$(sips -g pixelWidth -g pixelHeight "$preview" 2>&1)
  status=$?
  if [ "$status" -ne 0 ]; then
    fail "Tony: could not read preview.png dimensions: $dimensions"
  else
    width=$(printf '%s\n' "$dimensions" | awk '/pixelWidth:/ { print $2 }')
    height=$(printf '%s\n' "$dimensions" | awk '/pixelHeight:/ { print $2 }')
    if [ "$width" != "720" ] || [ "$height" != "450" ]; then
      fail "Tony: preview.png must be exactly 720x450, got ${width:-unknown}x${height:-unknown}"
    fi
  fi
fi

if [ "$failures" -ne 0 ]; then
  printf '%s gallery entry check(s) failed\n' "$failures"
  exit 1
fi

printf 'All gallery entry checks passed\n'
