// Where workflows live and how they are read and written. Pure: the file operations come in as `io`
// (main.js passes Herdr's), so node --test runs it against a Map.
//   io.read(path) -> text | null     io.write(path, text, expected) -> rejects if the file is not `expected`
//   io.list(dir) -> file names       io.remove(path)    io.mkdir(dir)    io.isDir(path) -> boolean
//
// Global workflows are written to dirs.global, which the app keeps, and copied to the workstation
// clone's folder (mirrorDir) when one is set, to be committed from there. Local ones stay in dirs.local.
import { parse, serialize, slug, validate } from "./model.js";

export class StoreError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; } // "conflict" | "invalid" | "missing" | "other"
}

const fileOf = (dir, id) => `${dir}/${id}.json`;

export function makeStore({ io, dirs, mirrorDir = null }) {
  const dirOf = (isGlobal) => (isGlobal ? dirs.global : dirs.local);

  // Every workflow, by name: [{ id, name, global, error? }]. A file that cannot be read is listed with
  // its error instead of failing the whole list.
  async function list() {
    const items = [];
    for (const isGlobal of [true, false]) {
      const dir = dirOf(isGlobal);
      for (const file of (await io.list(dir)).filter((f) => f.endsWith(".json")).sort()) {
        const id = file.slice(0, -5);
        try {
          const text = await io.read(fileOf(dir, id));
          if (text == null) continue;
          const w = parse(text);
          // The folder decides where a workflow is, whatever the file says.
          items.push({ id, name: w.name || id, global: isGlobal });
        } catch (e) {
          items.push({ id, name: id, global: isGlobal, error: e.message });
        }
      }
    }
    return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  // One workflow and the text it was read as: { workflow, text, global }, or null when there is none.
  async function load(id) {
    for (const isGlobal of [true, false]) {
      const text = await io.read(fileOf(dirOf(isGlobal), id));
      if (text != null) return { workflow: { ...parse(text), id, global: isGlobal }, text, global: isGlobal };
    }
    return null;
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

  // The copy in the workstation clone. Its failure is reported, not thrown: the save itself worked.
  async function mirror(workflow, text, previous) {
    if (!mirrorDir) return { mirrored: false };
    try {
      const root = mirrorDir.replace(/\/workflows$/, "");
      if (!(await io.isDir(root))) return { mirrored: false, error: `${root} is not a folder` };
      await io.mkdir(mirrorDir);
      const path = fileOf(mirrorDir, workflow.id);
      if (workflow.global) await write(path, text, await io.read(path));
      else if (previous) await io.remove(path);
      return { mirrored: workflow.global };
    } catch (e) {
      return { mirrored: false, error: e.message };
    }
  }

  // Saves a workflow. `previous` is what load() gave (null for a new one). A new one gets its file name
  // from its name. Moving between Global and local writes the new file, then removes the old one.
  // Returns { workflow, text, global, mirror }.
  async function save(workflow, previous = null) {
    const taken = (await list()).map((i) => i.id).filter((id) => id !== previous?.workflow.id);
    const problems = validate({ ...workflow, id: previous ? workflow.id : "" }, taken);
    if (problems.length) throw Object.assign(new StoreError("invalid", problems[0].message), { problems });

    const id = previous ? previous.workflow.id : slug(workflow.name);
    const saved = { ...workflow, id };
    const text = serialize(saved), dir = dirOf(saved.global), path = fileOf(dir, id);
    await io.mkdir(dir);
    // Same place as before: replace what was read. A new file, or a move: nothing may be there yet.
    const sameFile = previous && previous.global === saved.global;
    await write(path, text, sameFile ? previous.text : null);
    if (previous && !sameFile) await io.remove(fileOf(dirOf(previous.global), id));
    return { workflow: { ...parse(text), id, global: saved.global }, text, global: saved.global, mirror: await mirror(saved, text, previous) };
  }

  async function remove(id) {
    const found = await load(id);
    if (!found) throw new StoreError("missing", "That workflow is already gone.");
    await io.remove(fileOf(dirOf(found.global), id));
    return mirror({ id, global: false }, "", found);
  }

  return { list, load, save, remove };
}
