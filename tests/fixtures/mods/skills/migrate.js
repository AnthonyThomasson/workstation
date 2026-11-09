export const LEGACY = [
  ["skills.recent.v1", "skillshare.recent.v1"],
  ["skills.hideDisabled.v1", "skillshare.hideDisabled.v1"],
];
export function migrateKeys(get, set, pairs = LEGACY) {
  for (const [to, from] of pairs) {
    if (get(to) == null && get(from) != null) set(to, get(from));
  }
}
