#!/bin/sh
# Check how skillshare/skills/ is tracked: only mine/ and .metadata.json are committed, and
# any other top-level folder (an installed skill, synced/) is ignored.
# Run with: sh tests/skills.test.sh

set -u

repo=$(cd "$(dirname "$0")/.." && pwd)
failures=0

fail() {
  printf 'FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

# 1. Everything git tracks under skillshare/skills/ is .metadata.json or lives under mine/.
tracked=$(git -C "$repo" ls-files skillshare/skills)
[ -n "$tracked" ] || fail "git ls-files skillshare/skills lists nothing"
outside=$(printf '%s\n' "$tracked" | grep -vE '^skillshare/skills/(\.metadata\.json$|mine/)' || true)
[ -z "$outside" ] || fail "tracked outside mine/: $outside"

printf '%s\n' "$tracked" | grep -qx 'skillshare/skills/.metadata.json' || fail ".metadata.json is not tracked"
printf '%s\n' "$tracked" | grep -q '^skillshare/skills/mine/.' || fail "nothing under mine/ is tracked"

# 2. git check-ignore: a new top-level folder is ignored, anything under mine/ is not.
ignored() { git -C "$repo" check-ignore -q "$1"; }

ignored skillshare/skills/newskill/SKILL.md || fail "skillshare/skills/newskill/SKILL.md should be ignored"
ignored skillshare/skills/herdr/SKILL.md || fail "skillshare/skills/herdr/SKILL.md should be ignored"
ignored skillshare/skills/skillshare/SKILL.md || fail "skillshare/skills/skillshare/SKILL.md should be ignored"
ignored skillshare/skills/synced/anything/SKILL.md || fail "skillshare/skills/synced/ should be ignored"
ignored skillshare/skills/mine/x/SKILL.md && fail "skillshare/skills/mine/x/SKILL.md should not be ignored"
ignored skillshare/skills/.metadata.json && fail "skillshare/skills/.metadata.json should not be ignored"

if [ "$failures" -ne 0 ]; then
  printf '%s skills tracking check(s) failed\n' "$failures"
  exit 1
fi

printf 'All skills tracking checks passed\n'
