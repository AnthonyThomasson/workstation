import test from "node:test";
import assert from "node:assert/strict";
import { makeStore, StoreError } from "./store.js";
import { blank, ROLES } from "./model.js";

const DIRS = { global: "/app/workflows", local: "/app/workflows.local" };
const MIRROR = "/repo/herdr-app/workflows";

// A disk in a Map. write() rejects like writeTextFile when the file is not what the caller expected.
function disk(files = {}, dirs = ["/repo/herdr-app"]) {
  const fs = new Map(Object.entries(files)), made = new Set(dirs), calls = [];
  return {
    fs, made, calls,
    io: {
      read: async (p) => fs.get(p) ?? null,
      write: async (p, text, expected) => {
        calls.push(["write", p]);
        if ((fs.get(p) ?? null) !== expected) throw new Error("stale snapshot");
        fs.set(p, text);
      },
      list: async (dir) => [...fs.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
      remove: async (p) => { calls.push(["remove", p]); fs.delete(p); },
      mkdir: async (d) => { made.add(d); },
      isDir: async (p) => made.has(p),
    },
  };
}

const wf = (name, over = {}) => {
  const w = blank();
  w.name = name;
  w.trigger.label = "workflow:x";
  for (const role of ROLES) w[role].prompt = "do it";
  return { ...w, ...over };
};

test("a new local workflow is written under its slug in the local folder", async () => {
  const d = disk(), store = makeStore({ io: d.io, dirs: DIRS });
  const saved = await store.save(wf("Feature Work"));
  assert.equal(saved.workflow.id, "feature-work");
  assert.ok(d.fs.has("/app/workflows.local/feature-work.json"));
  assert.equal(d.fs.has("/app/workflows/feature-work.json"), false);
  assert.deepEqual(saved.mirror, { mirrored: false });
});

test("a global workflow goes to the global folder and into the clone when there is one", async () => {
  const d = disk(), store = makeStore({ io: d.io, dirs: DIRS, mirrorDir: MIRROR });
  const saved = await store.save(wf("Ship it", { global: true }));
  assert.ok(d.fs.has("/app/workflows/ship-it.json"));
  assert.equal(d.fs.get(`${MIRROR}/ship-it.json`), d.fs.get("/app/workflows/ship-it.json"));
  assert.equal(saved.mirror.mirrored, true);
});

test("a clone path that is not a folder is reported and does not fail the save", async () => {
  const d = disk({}, []), store = makeStore({ io: d.io, dirs: DIRS, mirrorDir: MIRROR });
  const saved = await store.save(wf("Ship it", { global: true }));
  assert.ok(d.fs.has("/app/workflows/ship-it.json"));
  assert.equal(saved.mirror.mirrored, false);
  assert.match(saved.mirror.error, /not a folder/);
  assert.equal(d.fs.has(`${MIRROR}/ship-it.json`), false);
});

test("the list is by name, across both folders, and marks the global ones", async () => {
  const d = disk(), store = makeStore({ io: d.io, dirs: DIRS });
  await store.save(wf("beta", { global: true }));
  await store.save(wf("Alpha"));
  await store.save(wf("Gamma"));
  const items = await store.list();
  assert.deepEqual(items.map((i) => [i.name, i.global]), [["Alpha", false], ["beta", true], ["Gamma", false]]);
});

test("a malformed file is listed with its error instead of breaking the list", async () => {
  const d = disk({ "/app/workflows/broken.json": "{nope" }), store = makeStore({ io: d.io, dirs: DIRS });
  await store.save(wf("Fine"));
  const items = await store.list();
  const broken = items.find((i) => i.id === "broken");
  assert.match(broken.error, /not valid JSON/);
  assert.equal(items.length, 2);
});

test("load finds a workflow in either folder, and null when there is none", async () => {
  const d = disk(), store = makeStore({ io: d.io, dirs: DIRS });
  await store.save(wf("Local one"));
  await store.save(wf("Global one", { global: true }));
  assert.equal((await store.load("local-one")).global, false);
  assert.equal((await store.load("global-one")).global, true);
  assert.equal((await store.load("global-one")).workflow.global, true);
  assert.equal(await store.load("nope"), null);
});

test("saving again replaces the file; the id stays when the name changes", async () => {
  const d = disk(), store = makeStore({ io: d.io, dirs: DIRS });
  await store.save(wf("First name"));
  const previous = await store.load("first-name");
  const saved = await store.save({ ...previous.workflow, name: "Second name" }, previous);
  assert.equal(saved.workflow.id, "first-name");
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.load("first-name")).workflow.name, "Second name");
});

test("turning Global on moves the file, and off moves it back and drops the clone's copy", async () => {
  const d = disk(), store = makeStore({ io: d.io, dirs: DIRS, mirrorDir: MIRROR });
  await store.save(wf("Mover"));
  let previous = await store.load("mover");
  await store.save({ ...previous.workflow, global: true }, previous);
  assert.deepEqual([...d.fs.keys()].sort(), ["/app/workflows/mover.json", `${MIRROR}/mover.json`]);

  previous = await store.load("mover");
  await store.save({ ...previous.workflow, global: false }, previous);
  assert.deepEqual([...d.fs.keys()], ["/app/workflows.local/mover.json"]);
  assert.equal((await store.list()).length, 1);
});

test("a file changed on disk since it was read is a conflict, and is not overwritten", async () => {
  const d = disk(), store = makeStore({ io: d.io, dirs: DIRS });
  await store.save(wf("Shared"));
  const previous = await store.load("shared");
  d.fs.set("/app/workflows.local/shared.json", previous.text.replace("do it", "someone else's edit"));
  await assert.rejects(store.save({ ...previous.workflow, name: "Mine" }, previous), (e) => e instanceof StoreError && e.kind === "conflict");
  assert.match(d.fs.get("/app/workflows.local/shared.json"), /someone else's edit/);
});

test("a new workflow cannot take over another's file", async () => {
  const d = disk(), store = makeStore({ io: d.io, dirs: DIRS });
  await store.save(wf("Same name"));
  await assert.rejects(store.save(wf("same  NAME", { global: true })), (e) => e.kind === "invalid" && /already exists/.test(e.message));
  assert.equal(d.fs.size, 1);
});

test("an invalid workflow is refused with its problems and writes nothing", async () => {
  const d = disk(), store = makeStore({ io: d.io, dirs: DIRS });
  await assert.rejects(store.save(blank()), (e) => e.kind === "invalid" && e.problems.length === 5);
  assert.equal(d.fs.size, 0);
  assert.equal(d.calls.length, 0);
});

test("a write that fails for another reason is not called a conflict", async () => {
  const d = disk(), store = makeStore({ io: { ...d.io, write: async () => { throw new Error("disk full"); } }, dirs: DIRS });
  await assert.rejects(store.save(wf("Nope")), (e) => e.kind === "other" && /disk full/.test(e.message));
});

test("remove deletes the file and the clone's copy", async () => {
  const d = disk(), store = makeStore({ io: d.io, dirs: DIRS, mirrorDir: MIRROR });
  await store.save(wf("Gone", { global: true }));
  assert.equal(d.fs.size, 2);
  await store.remove("gone");
  assert.equal(d.fs.size, 0);
  await assert.rejects(store.remove("gone"), (e) => e.kind === "missing");
});

test("the strategy is saved in the file and survives a reload", async () => {
  const d = disk(), store = makeStore({ io: d.io, dirs: DIRS });
  await store.save(wf("Parallel", { strategy: "worktree" }));
  assert.equal(JSON.parse(d.fs.get("/app/workflows.local/parallel.json")).strategy, "worktree");
  assert.equal((await store.load("parallel")).workflow.strategy, "worktree");
});

test("a file saved before strategies existed loads as a branch", async () => {
  const old = JSON.stringify({ id: "old", name: "Old", trigger: { label: "x" } });
  const d = disk({ "/app/workflows.local/old.json": old }), store = makeStore({ io: d.io, dirs: DIRS });
  assert.equal((await store.load("old")).workflow.strategy, "branch");
});
