export function createChannel({ get, set }) {
  return { read: () => get("clean.chan"), write: (v) => set("clean.chan", v) };
}
export class Panel {
  constructor(deps) {
    this.deps = deps;
  }
  load(id) {
    return this.deps.shared(`clean.panel.${id}`);
  }
}
