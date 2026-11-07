#!/bin/sh
# Check that every Herdr gallery entry has the required files and shape.
# Run with: sh tests/entries.test.sh

set -u

repo=$(cd "$(dirname "$0")/.." && pwd)
failures=0

fail() {
  printf 'FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

for entry in "$repo"/herdr/*/; do
  [ -d "$entry" ] || continue
  name=${entry%/}
  name=${name##*/}

  [ -f "$entry/RECIPE.md" ] || fail "$name: missing RECIPE.md"
  [ -f "$entry/preview.png" ] || fail "$name: missing preview.png"

  if [ "$name" != "tony" ] && [ -d "$entry/layouts" ]; then
    fail "$name: mod entry must not contain a layouts/ directory"
  fi
done

preview="$repo/herdr/tony/preview.png"
if [ -f "$preview" ]; then
  dimensions=$(sips -g pixelWidth -g pixelHeight "$preview" 2>&1)
  status=$?
  if [ "$status" -ne 0 ]; then
    fail "tony: could not read preview.png dimensions: $dimensions"
  else
    width=$(printf '%s\n' "$dimensions" | awk '/pixelWidth:/ { print $2 }')
    height=$(printf '%s\n' "$dimensions" | awk '/pixelHeight:/ { print $2 }')
    if [ "$width" != "720" ] || [ "$height" != "450" ]; then
      fail "tony: preview.png must be exactly 720x450, got ${width:-unknown}x${height:-unknown}"
    fi
  fi
fi

if [ "$failures" -ne 0 ]; then
  printf '%s gallery entry check(s) failed\n' "$failures"
  exit 1
fi

printf 'All gallery entry checks passed\n'
