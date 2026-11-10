export function migrate(get) {
  get("alpha.migrated");
}
export function migrateBad(get) {
  get("beta.migrated");
}
