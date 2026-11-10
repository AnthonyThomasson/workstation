export function makeChannel({ get, set, now = Date.now }) {
  return { read: () => get("alpha.chan"), write: (v) => set("alpha.chan", v), now };
}
export function makeBadChannel({ get }) {
  return { read: () => get("beta.chan") };
}
export function makeLostChannel({ get }) {
  return { read: (k) => get(k) };
}
