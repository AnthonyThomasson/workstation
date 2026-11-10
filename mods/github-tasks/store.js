// Where workflows live and how they are read and written. Pure: the file operations come in as `io`
// (workflow-env.js passes Herdr's), so node --test runs it against a Map.
//   io.read(path) -> text | null     io.write(path, text, expected) -> rejects if the file is not `expected`
//   io.list(dir) -> file names       io.remove(path)    io.mkdir(dir)
//
// A workflow's scope is the folder it is in (see workflow-model.js SCOPES). dirs maps each scope to its folder:
//   { global?, repo? }
// a scope without a folder is not available (global always has one; repo has none when the selected space
// is not in a repo), and nothing is listed from it or written to it. Nothing here runs git.
//
// Every function takes the kind of thing stored (kinds.js): workflows, the default, or refactor types.
import { WORKFLOW } from "./kinds.js";

export class StoreError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; } // "conflict" | "invalid" | "missing" | "unavailable" | "other"
}

// A copy keeps its contents and scope; its name is changed until the slug it produces is not an existing id.
export function cloneItem(item, existingIds, kind = WORKFLOW) {
  const { normalize, slug } = kind.model;
  const copy = normalize(item), base = `${copy.name} copy`, taken = new Set(existingIds);
  for (let number = 1; ; number++) {
    const name = number === 1 ? base : `${base} ${number}`;
    // slug() cuts to 60 characters, so reserve the suffix instead of letting a long name cut it off forever.
    const id = number === 1 ? slug(base) : `${slug(base, 59 - String(number).length)}-${number}`;
    if (!taken.has(id)) return { ...copy, id, name };
  }
}

export const cloneWorkflow = cloneItem;

// Clipboard YAML becomes the replacement's contents, never its id: that still belongs to the destination file.
export function replacementFromYaml(source, id, kind = WORKFLOW) {
  let replacement;
  try { replacement = { ...kind.model.parse(source), id }; }
  catch (e) { throw new StoreError("invalid", `Clipboard is not a valid ${kind.noun}: ${e?.message ?? e}`); }
  const problems = kind.model.validate(replacement);
  if (problems.length) throw Object.assign(new StoreError("invalid", problems[0].message), { problems });
  return replacement;
}

// Restore needs a real snapshot of the current place, not the initial empty list or the previous place's items.
export const canRestoreDefaults = ({ loaded, placeChanged }) => loaded && !placeChanged;

// A failed read still ends the skeleton, but only a successful one marks its place's items as safe to restore.
export const workflowRefreshState = ({ loadedPlaceKey }, placeKey, succeeded) => ({
  loaded: true, loadedPlaceKey: succeeded ? placeKey : loadedPlaceKey,
});

// Project resets only the repo; Global only the global files; All removes both but puts the starters in Global.
// Capture the repo root so a place change while confirming cannot redirect the restore. With no repo there is
// only Global, whatever tab was last selected while a repo was open.
export function restorePlan(items, tab, repoRoot) {
  const scope = repoRoot ? tab : "global";
  const deletions = items.filter((item) => scope === "all" || item.scope === scope)
    .map(({ id, name, scope }) => ({ id, name, scope }));
  return { repoRoot: repoRoot ?? null, deletions, createScope: scope === "repo" ? "repo" : "global" };
}

// Workflows are YAML files. Ones saved as JSON before that still load, and are rewritten as YAML when saved.
const fileOf = (dir, id) => `${dir}/${id}.yaml`;
const legacyOf = (dir, id) => `${dir}/${id}.json`;

export function makeStore({ io, dirs, kind = WORKFLOW }) {
  const { parse, serialize, validate, slug, SCOPES, SCOPE_LABELS } = kind.model, noun = kind.noun;
  // An item is stored under `item`; `workflow` names the same object, as it did before there were two kinds.
  const withItem = (item, rest) => ({ item, workflow: item, ...rest });
  const previousId = (previous) => (previous.item ?? previous.workflow).id;
  const available = SCOPES.filter((scope) => Boolean(dirs[scope]));

  function folder(scope) {
    if (!dirs[scope]) throw new StoreError("unavailable", `${SCOPE_LABELS[scope] ?? scope} ${kind.plural} aren't available here.`);
    return dirs[scope];
  }

  // Every file in the available scopes, read: [{ id, scope, workflow }] or [{ id, scope, file, error }] for a file that cannot be
  // read. The one place a workflow folder is listed.
  async function readAll() {
    const entries = [];
    for (const scope of available) {
      const dir = dirs[scope];
      const files = (await io.list(dir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".json")).sort();
      const ids = [...new Set(files.map((f) => f.slice(0, f.lastIndexOf(".")))) ];
      for (const id of ids) {
        try {
          const text = (await io.read(fileOf(dir, id))) ?? (await io.read(legacyOf(dir, id)));
          if (text == null) continue;
          entries.push({ id, scope, workflow: { ...parse(text), id, scope } });
        } catch (e) {
          entries.push({ id, scope, error: e.message, file: files.includes(`${id}.yaml`) ? `${id}.yaml` : `${id}.json` });
        }
      }
    }
    return entries;
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.scope.localeCompare(b.scope);

  // Every workflow in the available scopes, by name: [{ id, name, scope, error? }]. A file that cannot be
  // read is listed with its error instead of failing the whole list.
  async function list() {
    const items = (await readAll()).map((e) => (e.error ? { id: e.id, name: e.id, scope: e.scope, error: e.error } : { id: e.id, name: e.workflow.name || e.id, scope: e.scope }));
    return items.sort(byName);
  }

  // Every workflow that can be read, whole, for Start to match a ticket's labels against: { items: [workflow with its
  // scope], errors: ["broken.yaml: what is wrong"] }, by name.
  async function loadAll() {
    const entries = await readAll();
    return {
      items: entries.filter((e) => e.workflow).map((e) => ({ ...e.workflow, name: e.workflow.name || e.id })).sort(byName),
      errors: entries.filter((e) => e.error).map((e) => `${e.file}: ${e.error}`),
    };
  }

  // The exact file text, without parsing it: Copy can therefore copy even a file whose error is listed.
  async function loadText(scope, id) {
    const dir = folder(scope);
    let text = await io.read(fileOf(dir, id)), legacy = false;
    if (text == null) { text = await io.read(legacyOf(dir, id)); legacy = text != null; }
    return text == null ? null : { text, scope, legacy };
  }

  // Clipboard text: YAML stays byte-for-byte, while a legacy JSON file is parsed and serialized as YAML.
  async function copyText(scope, id) {
    const found = await loadText(scope, id);
    return found && (found.legacy ? serialize(parse(found.text)) : found.text);
  }

  // One workflow and the text it was read as: { item, text, scope, legacy } (item is also `workflow`), or null when there is none.
  // legacy: it was read from an old JSON file.
  async function load(scope, id) {
    const found = await loadText(scope, id);
    return found && withItem({ ...parse(found.text), id }, found);
  }

  // A write that fails because the file changed since it was read is a conflict; anything else is not.
  async function write(path, text, expected) {
    try {
      await io.write(path, text, expected);
    } catch (e) {
      const now = await io.read(path).catch(() => undefined);
      if (now !== undefined && now !== expected) throw new StoreError("conflict", `This ${noun} changed on disk after you opened it.`);
      throw new StoreError("other", `Could not write ${path}: ${e?.message ?? e}`);
    }
  }

  // Saves a workflow in a scope. `previous` is what load() gave (null for a new one). A new one gets its file
  // name from its name, unless clone() supplies the unique id it already chose. Moving to another scope writes
  // the new file, then removes the old one. Returns { item, workflow (the same), text, scope, legacy }.
  async function save(workflow, scope, previous = null, newId = null) {
    const dir = folder(scope);
    const id = previous ? previousId(previous) : newId ?? slug(workflow.name);
    const taken = (await list()).map((i) => i.id).filter((id) => id !== (previous && previousId(previous)));
    const problems = validate({ ...workflow, id: previous ? workflow.id : id }, previous ? taken : []);
    if (!previous && taken.includes(id)) problems.unshift({ field: "name", message: `A ${noun} with that name already exists.` });
    if (problems.length) throw Object.assign(new StoreError("invalid", problems[0].message), { problems });

    const text = serialize({ ...workflow, id }), path = fileOf(dir, id);
    await io.mkdir(dir);
    // Same place as before: replace what was read. A new file, or a move: nothing may be there yet.
    const sameFile = previous && previous.scope === scope;
    if (!sameFile && ((await io.read(path)) != null || (await io.read(legacyOf(dir, id))) != null)) {
      throw new StoreError("invalid", `A ${noun} with the id "${id}" already exists in ${SCOPE_LABELS[scope].toLowerCase()}.`);
    }
    // An old JSON file has no YAML beside it yet: write that new, then take the JSON away.
    await write(path, text, sameFile && !previous.legacy ? previous.text : null);
    if (previous && (!sameFile || previous.legacy)) await io.remove(previous.legacy ? legacyOf(folder(previous.scope), id) : fileOf(folder(previous.scope), id));
    return withItem({ ...parse(text), id }, { text, scope, legacy: false });
  }

  async function clone(scope, id) {
    const found = await load(scope, id);
    if (!found) throw new StoreError("missing", `That ${noun} is already gone.`);
    const copy = cloneItem(found.item, (await list()).map((item) => item.id), kind);
    return save(copy, scope, null, copy.id);
  }

  async function paste(scope, id, source) {
    const previous = await loadText(scope, id);
    if (!previous) throw new StoreError("missing", `That ${noun} is already gone.`);
    const destination = withItem({ id }, previous); // the old file need not be valid for Paste to repair it
    return save(replacementFromYaml(source, id, kind), scope, destination);
  }

  async function restore(plan, starterTexts) {
    // Read and check every starter before the first deletion. Restore copies their text, including their own ids,
    // directly: the same Bug and Story may intentionally remain in the other scope.
    const starters = starterTexts.map((source) => {
      let workflow;
      try { workflow = parse(source); }
      catch (e) { throw new StoreError("invalid", `A shipped starter is invalid: ${e?.message ?? e}`); }
      const problems = validate(workflow);
      if (problems.length) throw Object.assign(new StoreError("invalid", `A shipped starter is invalid: ${problems[0].message}`), { problems });
      return { id: workflow.id || slug(workflow.name), text: source };
    });
    // Snapshot both possible files before changing anything, including malformed YAML and hidden legacy JSON.
    const originals = [];
    for (const item of plan.deletions) {
      const dir = folder(item.scope);
      for (const path of [fileOf(dir, item.id), legacyOf(dir, item.id)]) {
        const text = await io.read(path);
        if (text != null) originals.push({ path, text });
      }
    }
    const originalPaths = new Set(originals.map((file) => file.path)), starterWrites = [];
    try {
      for (const file of originals) await io.remove(file.path);
      const dir = folder(plan.createScope);
      await io.mkdir(dir);
      for (const starter of starters) {
        const path = fileOf(dir, starter.id);
        starterWrites.push({ path, text: starter.text }); // include an attempted write: the I/O may fail after writing
        await write(path, starter.text, null);
      }
    } catch (error) {
      const rollbackErrors = [];
      // Remove only starter text that this operation wrote; a conflicting file from elsewhere is not ours to delete.
      for (const starter of starterWrites.reverse()) {
        if (originalPaths.has(starter.path)) continue;
        try {
          if (await io.read(starter.path) === starter.text) await io.remove(starter.path);
        } catch (e) { rollbackErrors.push(e); }
      }
      // Read the current bytes for the expected-value check, then put every original file back exactly as it was.
      for (const file of originals) {
        try {
          const current = await io.read(file.path);
          if (current !== file.text) await io.write(file.path, file.text, current);
        } catch (e) { rollbackErrors.push(e); }
      }
      if (rollbackErrors.length) throw new StoreError("other", `${error?.message ?? error}; Restore also could not put every original file back: ${rollbackErrors.map((e) => e?.message ?? e).join("; ")}`);
      throw error;
    }
  }

  async function remove(scope, id) {
    const found = await load(scope, id);
    if (!found) throw new StoreError("missing", `That ${noun} is already gone.`);
    await io.remove((found.legacy ? legacyOf : fileOf)(folder(scope), id));
  }

  return { list, loadAll, loadText, copyText, load, save, clone, paste, restore, remove, available };
}
