// The saved choices used to live under "skillshare.*" keys; they are "skills.*" now (each mod's
// shared keys start with its folder name). No Herdr imports: main.js passes shared/setShared in.
// The old names stay here, read only through get, never passed to shared() directly.
export const LEGACY = [
  ["skills.recent.v1", "skillshare.recent.v1"],
  ["skills.hideDisabled.v1", "skillshare.hideDisabled.v1"],
  ["skills.doctorIgnored.v1", "skillshare.doctorIgnored.v1"],
];

const empty = (v) => v === undefined || v === null;

// migrateKeys(get, set, pairs): for each [newKey, oldKey], when newKey is empty and oldKey is not,
// copies the old value to the new key. The old key is left alone. Writes: call it from init, never
// while a view renders.
export function migrateKeys(get, set, pairs = LEGACY) {
  for (const [to, from] of pairs) {
    if (!empty(get(to))) continue;
    const old = get(from);
    if (!empty(old)) set(to, old);
  }
}
