// Local tasks: a repo's tasks kept as YAML files on this computer instead of in a GitHub Project.
//   ~/.herdr/tasks/<key>/<status folder>/<id>-<slug>.yml
// <key> is the main checkout's absolute path with / turned into -, so the checkout and all its ticket worktrees share
// one list. The folder a file is in is the task's status. Pure: the file operations come in as `io`
// (local-tasks-env.js passes Herdr's), so node --test runs it against a Map. Nothing here runs git.
//   io.list(dir) -> file names ([] when the folder is missing)    io.read(path) -> text | null
//   io.write(path, text)  (last write wins)    io.remove(path)    io.rename(from, to)    io.mkdir(dir)
import { parse, stringify } from "./yaml.js";
import { slug, uniqueLabels } from "./workflow-model.js";
import { STATUSES, sameStatus } from "./model.js";

// The five status folders, in the order the board reads, each with the status (model.js STATUSES) it stands for.
export const FOLDERS = [
  { key: "backlog", folder: "to-do", status: STATUSES.backlog },
  { key: "groomed", folder: "up-next", status: STATUSES.groomed },
  { key: "inProgress", folder: "in-progress", status: STATUSES.inProgress },
  { key: "inReview", folder: "in-review", status: STATUSES.inReview },
  { key: "done", folder: "done", status: STATUSES.done },
];

// "To Do" (or "Todo", or the folder name "to-do") -> "to-do"; null when it is none of the five.
export const folderOfStatus = (status) => {
  const found = FOLDERS.find((f) => f.folder === status || sameStatus(f.status, status));
  return found ? found.folder : null;
};
// "up-next" -> "Up Next"; null for any other folder.
export const statusOfFolder = (folder) => FOLDERS.find((f) => f.folder === folder)?.status ?? null;

const trimmed = (path) => String(path).replace(/\/+$/, "");
export const tasksKey = (mainRoot) => trimmed(mainRoot).replace(/\//g, "-");
export const tasksDir = (home, mainRoot) => `${trimmed(home)}/.herdr/tasks/${tasksKey(mainRoot)}`;
export const statusDir = (home, mainRoot, folder) => `${tasksDir(home, mainRoot)}/${folder}`;

// 7 + "Fix login!" -> 7-fix-login.yml. The slug is made like a branch's, 40 characters.
export const taskFileName = (id, title) => `${id}-${slug(title, 40) || "task"}.yml`;
const idOfFileName = (name) => {
  const m = /^(\d+)(?:-.*)?\.yml$/.exec(name);
  return m ? Number(m[1]) : null;
};

const wholeId = (v) => (Number.isInteger(v) && v > 0 ? v : null);

// A task file's text as { id, title, description, labels, createdAt }, or null when it doesn't parse or has no title.
// A file with no usable id takes fallbackId (the number in its file name), else its id is null.
export function parseTask(text, fallbackId = null) {
  let doc;
  try { doc = parse(text ?? ""); } catch { return null; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const raw = doc.title;
  const title = typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? String(raw).trim() : "";
  if (!title) return null;
  const labels = Array.isArray(doc.labels) ? doc.labels : doc.labels == null ? [] : [doc.labels];
  return {
    id: wholeId(doc.id) ?? wholeId(fallbackId),
    title,
    description: doc.description == null ? "" : String(doc.description),
    labels: uniqueLabels(labels.filter((l) => l != null && typeof l !== "object")),
    createdAt: doc.createdAt == null ? null : String(doc.createdAt),
  };
}

// The file's text. createdAt is left out when there is none.
export const serializeTask = (task) => stringify({
  id: task.id, title: task.title, description: task.description ?? "", labels: task.labels ?? [],
  ...(task.createdAt ? { createdAt: task.createdAt } : {}),
});

const created = (task) => {
  const at = Date.parse(task.createdAt);
  return Number.isNaN(at) ? -Infinity : at;
};
const newestFirst = (a, b) => created(b) - created(a) || b.id - a.id;

// The store for one repo. root: the main checkout, home: the user's home folder.
//   list({ includeDone, onlyDone }) -> tasks, newest createdAt first; done/ is left out unless asked for
//   get(id) -> task | null          nextId() -> highest id in any of the five folders + 1 (1 when empty)
//   save(id, { title, description, labels }) -> task (renames the file when the slug changes)
//   move(id, status) -> task (status: "To Do" / "Up Next" / "In Progress" / "In Review" / "Done", or a folder name)
// A task is { id, title, description, labels, createdAt, status, folder, path }. Rejects with an Error whose message
// can be shown. Saves are last-write-wins: nothing checks what is in the file.
export function makeLocalTasks({ io, root, home }) {
  const dir = (folder) => statusDir(home, root, folder);

  // Every .yml file in the five folders: { folder, name, path, text }.
  async function scan() {
    const perFolder = await Promise.all(FOLDERS.map(async ({ folder }) => {
      const names = (await io.list(dir(folder)).catch(() => [])).filter((n) => n.endsWith(".yml"));
      return Promise.all(names.map(async (name) => {
        const path = `${dir(folder)}/${name}`;
        return { folder, name, path, text: await io.read(path).catch(() => null) };
      }));
    }));
    return perFolder.flat();
  }

  const taskOf = (file) => {
    const task = parseTask(file.text, idOfFileName(file.name));
    return task && task.id ? { ...task, status: statusOfFolder(file.folder), folder: file.folder, path: file.path } : null;
  };

  async function find(id) {
    const file = (await scan()).find((f) => taskOf(f)?.id === Number(id));
    if (!file) throw new Error(`There is no task #${id}.`);
    return file;
  }

  return {
    async list({ includeDone = false, onlyDone = false } = {}) {
      return (await scan()).filter((f) => (onlyDone ? f.folder === "done" : includeDone || f.folder !== "done"))
        .map(taskOf).filter(Boolean).sort(newestFirst);
    },

    async get(id) {
      const file = (await scan()).find((f) => id != null && taskOf(f)?.id === Number(id));
      return file ? taskOf(file) : null;
    },

    // Counts a file that doesn't parse too (by its name), so its id is never given to another task.
    async nextId() {
      let highest = 0;
      for (const file of await scan()) {
        highest = Math.max(highest, idOfFileName(file.name) ?? 0, parseTask(file.text)?.id ?? 0);
      }
      return highest + 1;
    },

    async save(id, { title, description, labels }) {
      const name = String(title ?? "").trim();
      if (!name) throw new Error("A task needs a title.");
      const file = await find(id);
      const text = stringify({ ...parse(file.text), id: Number(id), title: name, description: description ?? "", labels: uniqueLabels(labels ?? []) });
      const target = taskFileName(id, name);
      const path = `${dir(file.folder)}/${target}`;
      if (target !== file.name) await io.rename(file.path, path);
      await io.write(path, text);
      return taskOf({ folder: file.folder, name: target, path, text });
    },

    async move(id, status) {
      const folder = folderOfStatus(status);
      if (!folder) throw new Error(`"${status}" isn't a status a task can have.`);
      const file = await find(id);
      if (file.folder === folder) return taskOf(file);
      const path = `${dir(folder)}/${file.name}`;
      await io.mkdir(dir(folder));
      await io.rename(file.path, path);
      return taskOf({ ...file, folder, path });
    },
  };
}
