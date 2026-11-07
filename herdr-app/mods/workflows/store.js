// Where workflows live and how they are read and written. Pure: the file operations come in as `io`
// (env.js passes Herdr's), so node --test runs it against a Map.
//   io.read(path) -> text | null     io.write(path, text, expected) -> rejects if the file is not `expected`
//   io.list(dir) -> file names       io.remove(path)    io.mkdir(dir)
//
// A workflow's scope is the folder it is in (see model.js SCOPES). dirs maps each scope to its folder:
//   { global?, repo? }
// a scope without a folder is not available (no workstation repo found, or the selected space is not in
// a repo), and nothing is listed from it or written to it. The global folder is in the workstation repo
// and the repo one in a project's, so git carries those; nothing here runs git.
import { parse, serialize, slug, validate, SCOPES, SCOPE_LABELS } from "./model.js";

export class StoreError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; } // "conflict" | "invalid" | "missing" | "unavailable" | "other"
}

const fileOf = (dir, id) => `${dir}/${id}.json`;

export function makeStore({ io, dirs }) {
  const available = SCOPES.filter((scope) => Boolean(dirs[scope]));

  function folder(scope) {
    if (!dirs[scope]) throw new StoreError("unavailable", `${SCOPE_LABELS[scope] ?? scope} workflows aren't available here.`);
    return dirs[scope];
  }

  // Every workflow in the available scopes, by name: [{ id, name, scope, error? }]. A file that cannot be
  // read is listed with its error instead of failing the whole list.
  async function list() {
    const items = [];
    for (const scope of available) {
      const dir = dirs[scope];
      for (const file of (await io.list(dir)).filter((f) => f.endsWith(".json")).sort()) {
        const id = file.slice(0, -5);
        try {
          const text = await io.read(fileOf(dir, id));
          if (text == null) continue;
          items.push({ id, name: parse(text).name || id, scope });
        } catch (e) {
          items.push({ id, name: id, scope, error: e.message });
        }
      }
    }
    return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.scope.localeCompare(b.scope));
  }

  // One workflow and the text it was read as: { workflow, text, scope }, or null when there is none.
  async function load(scope, id) {
    const text = await io.read(fileOf(folder(scope), id));
    return text == null ? null : { workflow: { ...parse(text), id }, text, scope };
  }

  // A write that fails because the file changed since it was read is a conflict; anything else is not.
  async function write(path, text, expected) {
    try {
      await io.write(path, text, expected);
    } catch (e) {
      const now = await io.read(path).catch(() => undefined);
      if (now !== undefined && now !== expected) throw new StoreError("conflict", "This workflow changed on disk after you opened it.");
      throw new StoreError("other", `Could not write ${path}: ${e?.message ?? e}`);
    }
  }

  // Saves a workflow in a scope. `previous` is what load() gave (null for a new one). A new one gets its file
  // name from its name. Moving to another scope writes the new file, then removes the old one.
  // Returns { workflow, text, scope }.
  async function save(workflow, scope, previous = null) {
    const dir = folder(scope);
    const taken = (await list()).map((i) => i.id).filter((id) => id !== previous?.workflow.id);
    const problems = validate({ ...workflow, id: previous ? workflow.id : "" }, taken);
    if (problems.length) throw Object.assign(new StoreError("invalid", problems[0].message), { problems });

    const id = previous ? previous.workflow.id : slug(workflow.name);
    const text = serialize({ ...workflow, id }), path = fileOf(dir, id);
    await io.mkdir(dir);
    // Same place as before: replace what was read. A new file, or a move: nothing may be there yet.
    const sameFile = previous && previous.scope === scope;
    if (!sameFile && (await io.read(path)) != null) {
      throw new StoreError("invalid", `A workflow with the id "${id}" already exists in ${SCOPE_LABELS[scope].toLowerCase()}.`);
    }
    await write(path, text, sameFile ? previous.text : null);
    if (previous && !sameFile) await io.remove(fileOf(folder(previous.scope), id));
    return { workflow: { ...parse(text), id }, text, scope };
  }

  async function remove(scope, id) {
    if (!(await load(scope, id))) throw new StoreError("missing", "That workflow is already gone.");
    await io.remove(fileOf(folder(scope), id));
  }

  return { list, load, save, remove, available };
}
