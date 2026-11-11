import test from "node:test";
import assert from "node:assert/strict";
import {
  FOLDERS, tasksKey, tasksDir, statusDir, folderOfStatus, statusOfFolder,
  taskFileName, parseTask, serializeTask, makeLocalTasks,
} from "./local-tasks.js";
import { STATUSES } from "./lib/index.js";

const ROOT = "/Users/me/code/app", HOME = "/Users/me";
const BASE = `${HOME}/.herdr/tasks/-Users-me-code-app`;

test("the key is the main checkout's path with / turned into -", () => {
  assert.equal(tasksKey("/Users/me/code/app"), "-Users-me-code-app");
  assert.equal(tasksKey("/Users/me/code/app/"), "-Users-me-code-app");
});

test("tasks live in ~/.herdr/tasks/<key>/<status folder>", () => {
  assert.equal(tasksDir(HOME, ROOT), BASE);
  assert.equal(tasksDir("/Users/me/", ROOT), BASE);
  assert.equal(statusDir(HOME, ROOT, "in-review"), `${BASE}/in-review`);
});

test("the six status folders map to the six statuses", () => {
  assert.deepEqual(FOLDERS.map((f) => f.folder), ["to-do", "up-next", "in-progress", "in-review", "done", "wont-do"]);
  assert.deepEqual(FOLDERS.map((f) => f.status), [STATUSES.backlog, STATUSES.groomed, STATUSES.inProgress, STATUSES.inReview, STATUSES.done, STATUSES.wontDo]);
  assert.equal(folderOfStatus("To Do"), "to-do");
  assert.equal(folderOfStatus("Todo"), "to-do");
  assert.equal(folderOfStatus("Backlog"), "to-do");
  assert.equal(folderOfStatus("Up Next"), "up-next");
  assert.equal(folderOfStatus("in progress"), "in-progress");
  assert.equal(folderOfStatus("In Review"), "in-review");
  assert.equal(folderOfStatus("Done"), "done");
  assert.equal(folderOfStatus("Won't Do"), "wont-do");
  assert.equal(folderOfStatus("wont do"), "wont-do");
  assert.equal(folderOfStatus("wont-do"), "wont-do");
  assert.equal(folderOfStatus("in-review"), "in-review"); // a folder name is accepted too
  assert.equal(folderOfStatus("Blocked"), null);
  assert.equal(folderOfStatus(null), null);
  assert.equal(statusOfFolder("up-next"), "Up Next");
  assert.equal(statusOfFolder("to-do"), "To Do");
  assert.equal(statusOfFolder("wont-do"), "Won't Do");
  assert.equal(statusOfFolder("nope"), null);
});

test("a file is <id>-<slug>.yml, the slug made like a branch's, 40 characters", () => {
  assert.equal(taskFileName(7, "Fix login redirect!"), "7-fix-login-redirect.yml");
  assert.equal(taskFileName(12, "x".repeat(60)), `12-${"x".repeat(40)}.yml`);
  assert.equal(taskFileName(3, "!!!"), "3-task.yml");
  assert.equal(taskFileName(3, ""), "3-task.yml");
});

const SAMPLE = `id: 7
title: Fix login redirect
description: |
  After sign-in the user lands on /404.
labels:
  - bug
createdAt: 2026-11-08T10:00:00Z
`;

test("the ticket's example parses", () => {
  assert.deepEqual(parseTask(SAMPLE), {
    id: 7, title: "Fix login redirect", description: "After sign-in the user lands on /404.\n", labels: ["bug"], createdAt: "2026-11-08T10:00:00Z",
  });
});

test("a task serializes to the same shape and reads back", () => {
  const task = { id: 7, title: "Fix login redirect", description: "After sign-in the user lands on /404.\n", labels: ["bug"], createdAt: "2026-11-08T10:00:00Z" };
  assert.equal(serializeTask(task), SAMPLE);
  const odd = { id: 8, title: "Why: a #hash, \"quotes\" & 'more'", description: "", labels: ["good first issue", "yes", "123"], createdAt: "2026-11-08T10:00:00.5Z" };
  assert.deepEqual(parseTask(serializeTask(odd)), odd);
  const multi = { ...odd, description: "one\n\ntwo" };
  assert.deepEqual(parseTask(serializeTask(multi)), multi);
});

test("missing fields get defaults; a missing or empty title, bad YAML or a non-map is no task", () => {
  assert.deepEqual(parseTask("title: Just a title\n"), { id: null, title: "Just a title", description: "", labels: [], createdAt: null });
  assert.equal(parseTask("title: Hand\nlabels: bug\n").labels.length, 1);
  assert.deepEqual(parseTask("title: 2024\nlabels: [a, b]\n").labels, ["a", "b"]);
  assert.deepEqual(parseTask("title: T\nlabels:\n  - 2\n  - true\n  - bug\n").labels, ["2", "true", "bug"]);
  assert.deepEqual(parseTask("title: T\nlabels: 2\n").labels, ["2"]);
  assert.equal(parseTask("title: 2024\n").title, "2024");
  for (const text of ["", "id: 1\n", "title:\nid: 1\n", "title: '  '\n", "title: [a\n", "a: 1\na: 2\n", "- a\n- b\n", "just text\n", "7\n", "title: x\n\ttab: 1\n", null, undefined]) {
    assert.equal(parseTask(text), null, JSON.stringify(text));
  }
});

test("an id that is not a whole number counts as missing; the file name's id stands in", () => {
  assert.equal(parseTask("id: abc\ntitle: T\n").id, null);
  assert.equal(parseTask("id: 1.5\ntitle: T\n").id, null);
  assert.equal(parseTask("id: 0\ntitle: T\n").id, null);
  assert.equal(parseTask("title: T\n", 9).id, 9);
  assert.equal(parseTask("id: 4\ntitle: T\n", 9).id, 4);
});

// A disk in a Map. write() overwrites (last write wins); list() gives the names directly in a folder.
function disk(files = {}) {
  const fs = new Map(Object.entries(files)), calls = [], failWrites = new Set();
  return {
    fs, calls, failWrites,
    io: {
      list: async (dir) => [...fs.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1)),
      read: async (p) => fs.get(p) ?? null,
      write: async (p, text) => { calls.push(["write", p]); if (failWrites.has(p)) throw new Error("disk full"); fs.set(p, text); },
      remove: async (p) => { calls.push(["remove", p]); fs.delete(p); },
      mkdir: async (dir) => { calls.push(["mkdir", dir]); },
    },
  };
}
const file = (id, title, createdAt, extra = "") => `id: ${id}\ntitle: ${title}\ncreatedAt: ${createdAt}\n${extra}`;
const setup = (files = {}) => { const d = disk(files); return { d, tasks: makeLocalTasks({ io: d.io, root: ROOT, home: HOME }) }; };

test("next id is the highest across all six folders plus one, 1 when there are none", async () => {
  assert.equal(await setup().tasks.nextId(), 1);
  const { tasks } = setup({
    [`${BASE}/to-do/2-b.yml`]: file(2, "B", "2026-01-01T00:00:00Z"),
    [`${BASE}/up-next/5-a.yml`]: file(5, "A", "2026-01-01T00:00:00Z"),
    [`${BASE}/done/11-old.yml`]: file(11, "Old", "2026-01-01T00:00:00Z"),
    [`${BASE}/in-review/3-c.yml`]: file(3, "C", "2026-01-01T00:00:00Z"),
  });
  assert.equal(await tasks.nextId(), 12);
});

test("next id also counts a file that does not parse, by its name, so its id is never reused", async () => {
  const { tasks } = setup({
    [`${BASE}/to-do/9-broken.yml`]: "title: [oops\n",
    [`${BASE}/to-do/notes.txt`]: "id: 40\n",
    [`${BASE}/up-next/4-x.yml`]: file(4, "X", "2026-01-01T00:00:00Z"),
    [`${BASE}/in-progress/6-renamed-by-hand.yml`]: file(20, "Hand", "2026-01-01T00:00:00Z"),
  });
  assert.equal(await tasks.nextId(), 21);
});

test("list gives tasks from the folders newest first, with their status, and leaves done out unless asked", async () => {
  const { tasks } = setup({
    [`${BASE}/to-do/1-old.yml`]: file(1, "Old", "2026-01-01T00:00:00Z"),
    [`${BASE}/to-do/4-new.yml`]: file(4, "New", "2026-03-01T00:00:00Z"),
    [`${BASE}/up-next/2-mid.yml`]: file(2, "Mid", "2026-02-01T00:00:00Z", "labels:\n  - bug\n"),
    [`${BASE}/done/3-done.yml`]: file(3, "Done one", "2026-04-01T00:00:00Z"),
  });
  const open = await tasks.list();
  assert.deepEqual(open.map((t) => t.id), [4, 2, 1]);
  assert.deepEqual(open.map((t) => t.status), ["To Do", "Up Next", "To Do"]);
  assert.deepEqual(open.map((t) => t.folder), ["to-do", "up-next", "to-do"]);
  assert.deepEqual(open[1], { id: 2, title: "Mid", description: "", labels: ["bug"], createdAt: "2026-02-01T00:00:00Z", status: "Up Next", folder: "up-next", path: `${BASE}/up-next/2-mid.yml` });
  assert.deepEqual((await tasks.list({ includeDone: true })).map((t) => t.id), [3, 4, 2, 1]);
  assert.deepEqual((await tasks.list({ onlyDone: true })).map((t) => t.id), [3]);
});

test("list never gives Won't Do tasks, not even when done is asked for", async () => {
  const { tasks } = setup({
    [`${BASE}/to-do/1-open.yml`]: file(1, "Open", "2026-01-01T00:00:00Z"),
    [`${BASE}/done/3-done.yml`]: file(3, "Done one", "2026-04-01T00:00:00Z"),
    [`${BASE}/wont-do/5-no.yml`]: file(5, "No", "2026-05-01T00:00:00Z"),
  });
  assert.deepEqual((await tasks.list()).map((t) => t.id), [1]);
  assert.deepEqual((await tasks.list({ includeDone: true })).map((t) => t.id), [3, 1]);
  assert.deepEqual((await tasks.list({ onlyDone: true })).map((t) => t.id), [3]);
  assert.deepEqual((await tasks.list({ includeDone: true, onlyDone: true })).map((t) => t.id), [3]);
});

test("a Won't Do task still counts for the next id and can still be read by id", async () => {
  const { tasks } = setup({ [`${BASE}/wont-do/9-no.yml`]: file(9, "No", "2026-05-01T00:00:00Z") });
  assert.equal(await tasks.nextId(), 10);
  assert.equal((await tasks.get(9)).status, "Won't Do");
});

test("move to Won't Do puts the file in the wont-do folder", async () => {
  const { d, tasks } = setup({ [`${BASE}/up-next/7-fix-login-redirect.yml`]: SAMPLE });
  const moved = await tasks.move(7, "Won't Do");
  assert.equal(moved.status, "Won't Do");
  assert.equal(moved.folder, "wont-do");
  assert.equal(moved.path, `${BASE}/wont-do/7-fix-login-redirect.yml`);
  assert.deepEqual(d.calls, [["mkdir", `${BASE}/wont-do`], ["write", `${BASE}/wont-do/7-fix-login-redirect.yml`], ["remove", `${BASE}/up-next/7-fix-login-redirect.yml`]]);
  assert.deepEqual((await tasks.list({ includeDone: true })).map((t) => t.id), []);
});

test("equal or missing createdAt sort by id, the higher first; files that are not tasks are skipped silently", async () => {
  const { tasks } = setup({
    [`${BASE}/to-do/1-a.yml`]: "id: 1\ntitle: A\n",
    [`${BASE}/to-do/2-b.yml`]: "id: 2\ntitle: B\n",
    [`${BASE}/to-do/3-c.yml`]: "id: 3\ntitle: C\ncreatedAt: 2026-01-01T00:00:00Z\n",
    [`${BASE}/to-do/4-bad.yml`]: "title: [oops\n",
    [`${BASE}/to-do/5-untitled.yml`]: "id: 5\n",
    [`${BASE}/to-do/readme.md`]: "title: not yaml file\n",
    [`${BASE}/to-do/sub/6-nested.yml`]: file(6, "Nested", "2026-01-01T00:00:00Z"),
    [`${BASE}/stray/7-stray.yml`]: file(7, "Stray", "2026-01-01T00:00:00Z"),
  });
  assert.deepEqual((await tasks.list()).map((t) => t.id), [3, 2, 1]);
});

test("a task with no id in its file takes the one in its file name", async () => {
  const { tasks } = setup({ [`${BASE}/to-do/8-by-hand.yml`]: "title: By hand\n", [`${BASE}/to-do/notes.yml`]: "title: No id anywhere\n" });
  assert.deepEqual((await tasks.list()).map((t) => [t.id, t.title]), [[8, "By hand"]]);
});

test("get finds a task in any folder, null when there is none", async () => {
  const { tasks } = setup({ [`${BASE}/done/3-x.yml`]: file(3, "X", "2026-01-01T00:00:00Z") });
  assert.equal((await tasks.get(3)).status, "Done");
  assert.equal(await tasks.get(4), null);
  assert.equal(await tasks.get(undefined), null);
});

test("save writes title, description and labels, keeping the id, createdAt and any other field", async () => {
  const { d, tasks } = setup({ [`${BASE}/up-next/7-fix-login.yml`]: `${SAMPLE}owner: me\n` });
  const saved = await tasks.save(7, { title: "Fix login redirect", description: "New text", labels: ["bug", "p1"] });
  assert.equal(saved.description, "New text");
  assert.deepEqual(saved.labels, ["bug", "p1"]);
  assert.equal(saved.path, `${BASE}/up-next/7-fix-login-redirect.yml`);
  const text = d.fs.get(`${BASE}/up-next/7-fix-login-redirect.yml`);
  assert.deepEqual(parseTask(text), { id: 7, title: "Fix login redirect", description: "New text", labels: ["bug", "p1"], createdAt: "2026-11-08T10:00:00Z" });
  assert.match(text, /owner: me/);
  assert.equal(d.fs.has(`${BASE}/up-next/7-fix-login.yml`), false); // the old name is gone
});

test("saving a new title renames the file to the new slug; the same slug keeps the file", async () => {
  const { d, tasks } = setup({ [`${BASE}/to-do/7-fix-login-redirect.yml`]: SAMPLE });
  await tasks.save(7, { title: "Fix  LOGIN redirect", description: "d", labels: [] }); // same slug
  assert.deepEqual(d.calls.filter((c) => c[0] !== "write"), []);
  d.calls.length = 0;
  const saved = await tasks.save(7, { title: "Totally different", description: "d", labels: [] });
  assert.equal(saved.path, `${BASE}/to-do/7-totally-different.yml`);
  assert.deepEqual([...d.fs.keys()], [`${BASE}/to-do/7-totally-different.yml`]);
  assert.equal(parseTask(d.fs.get(saved.path)).title, "Totally different");
  assert.deepEqual(d.calls, [["write", `${BASE}/to-do/7-totally-different.yml`], ["remove", `${BASE}/to-do/7-fix-login-redirect.yml`]]); // write first, then remove
});

test("a file named some other way is renamed to <id>-<slug>.yml on save", async () => {
  const { d, tasks } = setup({ [`${BASE}/to-do/7-whatever.yml`]: SAMPLE });
  await tasks.save(7, { title: "Fix login redirect", description: "", labels: [] });
  assert.deepEqual([...d.fs.keys()], [`${BASE}/to-do/7-fix-login-redirect.yml`]);
});

test("save fills in the id of a file that had none, and refuses an empty title or a missing task", async () => {
  const { d, tasks } = setup({ [`${BASE}/to-do/8-by-hand.yml`]: "title: By hand\n" });
  await tasks.save(8, { title: "By hand", description: "", labels: [] });
  assert.equal(parseTask(d.fs.get(`${BASE}/to-do/8-by-hand.yml`)).id, 8);
  await assert.rejects(tasks.save(8, { title: "  ", description: "", labels: [] }), /title/i);
  await assert.rejects(tasks.save(99, { title: "X", description: "", labels: [] }), /no task #99/i);
});

test("labels are trimmed, empty ones dropped and each kept once", async () => {
  const { tasks } = setup({ [`${BASE}/to-do/7-fix-login-redirect.yml`]: SAMPLE });
  const saved = await tasks.save(7, { title: "Fix login redirect", description: "", labels: [" bug ", "", "Bug", "p1"] });
  assert.deepEqual(saved.labels, ["bug", "p1"]);
});

test("the last write wins: a save never checks what is in the file", async () => {
  const { d, tasks } = setup({ [`${BASE}/to-do/7-fix-login-redirect.yml`]: SAMPLE });
  const stale = await tasks.get(7);
  d.fs.set(stale.path, SAMPLE.replace("lands on /404", "CHANGED OUTSIDE"));
  const saved = await tasks.save(7, { title: stale.title, description: "mine", labels: stale.labels });
  assert.equal(saved.description, "mine");
});

test("move puts the file in the other status folder, making it first", async () => {
  const { d, tasks } = setup({ [`${BASE}/to-do/7-fix-login-redirect.yml`]: SAMPLE });
  const moved = await tasks.move(7, "In Progress");
  assert.equal(moved.status, "In Progress");
  assert.equal(moved.folder, "in-progress");
  assert.equal(moved.path, `${BASE}/in-progress/7-fix-login-redirect.yml`);
  assert.deepEqual(d.calls, [["mkdir", `${BASE}/in-progress`], ["write", `${BASE}/in-progress/7-fix-login-redirect.yml`], ["remove", `${BASE}/to-do/7-fix-login-redirect.yml`]]);
  assert.equal(d.fs.get(moved.path), SAMPLE);
  assert.equal((await tasks.move(7, "Done")).folder, "done");
  assert.deepEqual((await tasks.list()).map((t) => t.id), []);
  assert.deepEqual((await tasks.list({ onlyDone: true })).map((t) => t.id), [7]);
});

test("move to the status it is already in changes nothing; an unknown status or task is an error", async () => {
  const { d, tasks } = setup({ [`${BASE}/to-do/7-fix-login-redirect.yml`]: SAMPLE });
  const same = await tasks.move(7, "Todo");
  assert.equal(same.folder, "to-do");
  assert.deepEqual(d.calls, []);
  await assert.rejects(tasks.move(7, "Blocked"), /status/i);
  await assert.rejects(tasks.move(99, "Done"), /no task #99/i);
});

test("a moved file keeps working when its name was not the usual one", async () => {
  const { d, tasks } = setup({ [`${BASE}/to-do/7-old-name.yml`]: SAMPLE });
  const moved = await tasks.move(7, "Up Next");
  assert.equal(moved.path, `${BASE}/up-next/7-old-name.yml`); // the file keeps its name; save is what renames it
  assert.equal(d.fs.size, 1);
});

test("save will not take another file's name, and changes nothing", async () => {
  const other = file(8, "Other", "2026-01-01T00:00:00Z");
  const { d, tasks } = setup({ [`${BASE}/to-do/7-fix-login-redirect.yml`]: SAMPLE, [`${BASE}/to-do/7-new-title.yml`]: other });
  await assert.rejects(tasks.save(7, { title: "New title", description: "", labels: [] }), /already a file called 7-new-title\.yml/);
  assert.equal(d.fs.get(`${BASE}/to-do/7-new-title.yml`), other);
  assert.equal(d.fs.get(`${BASE}/to-do/7-fix-login-redirect.yml`), SAMPLE);
  assert.deepEqual(d.calls, []);
});

test("move will not take another file's name in the target folder, and changes nothing", async () => {
  const other = "id: 70\ntitle: Other\n";
  const { d, tasks } = setup({ [`${BASE}/to-do/7-fix-login-redirect.yml`]: SAMPLE, [`${BASE}/done/7-fix-login-redirect.yml`]: other });
  await assert.rejects(tasks.move(7, "Done"), /already a file called/);
  assert.equal(d.fs.get(`${BASE}/done/7-fix-login-redirect.yml`), other);
  assert.equal(d.fs.get(`${BASE}/to-do/7-fix-login-redirect.yml`), SAMPLE);
  assert.deepEqual(d.calls, []);
});

test("a write that fails leaves the old file where it was (save with a new name, and move)", async () => {
  const { d, tasks } = setup({ [`${BASE}/to-do/7-fix-login-redirect.yml`]: SAMPLE });
  d.failWrites.add(`${BASE}/to-do/7-totally-different.yml`);
  await assert.rejects(tasks.save(7, { title: "Totally different", description: "", labels: [] }), /disk full/);
  assert.deepEqual([...d.fs.keys()], [`${BASE}/to-do/7-fix-login-redirect.yml`]);
  assert.equal(d.fs.get(`${BASE}/to-do/7-fix-login-redirect.yml`), SAMPLE);
  d.failWrites.add(`${BASE}/done/7-fix-login-redirect.yml`);
  await assert.rejects(tasks.move(7, "Done"), /disk full/);
  assert.deepEqual([...d.fs.keys()], [`${BASE}/to-do/7-fix-login-redirect.yml`]);
});
