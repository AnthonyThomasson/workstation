import test from "node:test";
import assert from "node:assert/strict";
import { makeStore, StoreError } from "./store.js";
import { blank, ROLES } from "./model.js";

const GLOBAL = "/ws/herdr-app/workflows", REPO = "/proj/.herdr/workflows";
const ALL = { global: GLOBAL, repo: REPO };

// A disk in a Map. write() rejects like writeTextFile when the file is not what the caller expected.
function disk(files = {}) {
  const fs = new Map(Object.entries(files)), calls = [];
  return {
    fs, calls,
    io: {
      read: async (p) => fs.get(p) ?? null,
      write: async (p, text, expected) => {
        calls.push(["write", p]);
        if ((fs.get(p) ?? null) !== expected) throw new Error("stale snapshot");
        fs.set(p, text);
      },
      list: async (dir) => [...fs.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
      remove: async (p) => { calls.push(["remove", p]); fs.delete(p); },
      mkdir: async () => {},
    },
  };
}

const wf = (name, over = {}) => {
  const w = blank();
  w.name = name;
  w.trigger.labels = ["workflow:x"];
  for (const role of ROLES) w[role].prompt = "do it";
  return { ...w, ...over };
};
const setup = (dirs = ALL, files = {}) => { const d = disk(files); return { d, store: makeStore({ io: d.io, dirs }) }; };

test("a new workflow is written under its slug in the folder of the scope it is saved to", async () => {
  for (const [scope, dir] of Object.entries(ALL)) {
    const { d, store } = setup();
    const saved = await store.save(wf("Feature Work"), scope);
    assert.equal(saved.workflow.id, "feature-work");
    assert.equal(saved.scope, scope);
    assert.deepEqual([...d.fs.keys()], [`${dir}/feature-work.json`]);
  }
});

test("the file holds the workflow and not where it is kept", async () => {
  const { d, store } = setup();
  await store.save(wf("Plain"), "global");
  const file = JSON.parse(d.fs.get(`${GLOBAL}/plain.json`));
  assert.equal("global" in file, false);
  assert.equal("scope" in file, false);
  assert.deepEqual(file.trigger, { labels: ["workflow:x"], match: "any" });
});

test("the list is by name across the available scopes, each marked with its scope", async () => {
  const { store } = setup();
  await store.save(wf("beta"), "global");
  await store.save(wf("Alpha"), "repo");
  await store.save(wf("Gamma"), "global");
  assert.deepEqual((await store.list()).map((i) => [i.name, i.scope]), [["Alpha", "repo"], ["beta", "global"], ["Gamma", "global"]]);
});

test("a scope with no folder lists nothing, so repo workflows show only where there is a repo", async () => {
  const files = { [`${REPO}/in-repo.json`]: JSON.stringify({ name: "In repo" }), [`${GLOBAL}/mine.json`]: JSON.stringify({ name: "Mine" }) };
  // a space in that repo is open: its folder is given
  const open = setup(ALL, files);
  assert.deepEqual((await open.store.list()).map((i) => i.name), ["In repo", "Mine"]);
  // no such space is open: the files are there, and not listed
  const closed = setup({ global: GLOBAL }, files);
  assert.deepEqual((await closed.store.list()).map((i) => i.name), ["Mine"]);
  assert.deepEqual(closed.store.available, ["global"]);
  assert.deepEqual(open.store.available, ["global", "repo"]);
});

test("saving to a scope that is not available is refused, and writes nothing", async () => {
  const { d, store } = setup({});
  await assert.rejects(store.save(wf("Nope"), "repo"), (e) => e instanceof StoreError && e.kind === "unavailable" && /Repo/.test(e.message));
  await assert.rejects(store.save(wf("Nope"), "global"), (e) => e.kind === "unavailable");
  await assert.rejects(store.load("repo", "x"), (e) => e.kind === "unavailable");
  assert.equal(d.fs.size, 0);
});

test("a malformed file is listed with its error instead of breaking the list", async () => {
  const { store } = setup(ALL, { [`${GLOBAL}/broken.json`]: "{nope" });
  await store.save(wf("Fine"), "repo");
  const items = await store.list();
  assert.match(items.find((i) => i.id === "broken").error, /not valid JSON/);
  assert.equal(items.length, 2);
});

test("load finds a workflow in the scope asked for, and null when it is not there", async () => {
  const { store } = setup();
  await store.save(wf("Global one"), "global");
  await store.save(wf("Repo one"), "repo");
  assert.equal((await store.load("global", "global-one")).scope, "global");
  assert.equal((await store.load("repo", "repo-one")).workflow.id, "repo-one");
  assert.equal(await store.load("repo", "global-one"), null);
  assert.equal(await store.load("global", "repo-one"), null);
});

test("saving again replaces the file; the id stays when the name changes", async () => {
  const { store } = setup();
  await store.save(wf("First name"), "repo");
  const previous = await store.load("repo", "first-name");
  const saved = await store.save({ ...previous.workflow, name: "Second name" }, "repo", previous);
  assert.equal(saved.workflow.id, "first-name");
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.load("repo", "first-name")).workflow.name, "Second name");
});

test("moving a workflow to another scope writes the new file and removes the old one", async () => {
  const { d, store } = setup();
  await store.save(wf("Mover"), "global");
  let previous = await store.load("global", "mover");
  const moved = await store.save(previous.workflow, "repo", previous);
  assert.equal(moved.scope, "repo");
  assert.deepEqual([...d.fs.keys()], [`${REPO}/mover.json`]);

  previous = await store.load("repo", "mover");
  await store.save(previous.workflow, "global", previous);
  assert.deepEqual([...d.fs.keys()], [`${GLOBAL}/mover.json`]);
  assert.equal((await store.list()).length, 1);
});

test("a move onto a file already there is refused, and neither file is touched", async () => {
  const { d, store } = setup();
  await store.save(wf("Twin"), "repo");
  await store.save(wf("Other"), "global");
  // the same id in the global folder, put there by someone else (a pull)
  d.fs.set(`${GLOBAL}/twin.json`, JSON.stringify({ name: "Twin from elsewhere" }));
  const before = new Map(d.fs);
  const previous = await store.load("repo", "twin");
  await assert.rejects(store.save(previous.workflow, "global", previous), (e) => e.kind === "invalid" && /already exists in global/.test(e.message));
  assert.deepEqual(d.fs, before);
});

test("a file changed on disk since it was read is a conflict, and is not overwritten", async () => {
  const { d, store } = setup();
  await store.save(wf("Shared"), "global");
  const previous = await store.load("global", "shared");
  d.fs.set(`${GLOBAL}/shared.json`, previous.text.replace("do it", "someone else's edit"));
  await assert.rejects(store.save({ ...previous.workflow, name: "Mine" }, "global", previous), (e) => e instanceof StoreError && e.kind === "conflict");
  assert.match(d.fs.get(`${GLOBAL}/shared.json`), /someone else's edit/);
});

test("a new workflow cannot take another's name, in any scope", async () => {
  const { d, store } = setup();
  await store.save(wf("Same name"), "global");
  await assert.rejects(store.save(wf("same  NAME"), "repo"), (e) => e.kind === "invalid" && /already exists/.test(e.message));
  assert.equal(d.fs.size, 1);
});

test("an invalid workflow is refused with its problems and writes nothing", async () => {
  const { d, store } = setup();
  await assert.rejects(store.save(blank(), "global"), (e) => e.kind === "invalid" && e.problems.length === 4);
  assert.equal(d.fs.size, 0);
  assert.equal(d.calls.length, 0);
});

test("a write that fails for another reason is not called a conflict", async () => {
  const d = disk(), store = makeStore({ io: { ...d.io, write: async () => { throw new Error("disk full"); } }, dirs: ALL });
  await assert.rejects(store.save(wf("Nope"), "global"), (e) => e.kind === "other" && /disk full/.test(e.message));
});

test("remove deletes the file from its scope, and only that scope", async () => {
  const { d, store } = setup();
  await store.save(wf("Gone"), "repo");
  await store.save(wf("Kept"), "global");
  await store.remove("repo", "gone");
  assert.deepEqual([...d.fs.keys()], [`${GLOBAL}/kept.json`]);
  await assert.rejects(store.remove("repo", "gone"), (e) => e.kind === "missing");
  await assert.rejects(store.remove("repo", "kept"), (e) => e.kind === "missing");
});

test("the strategy, a custom agent's command and the trigger labels are saved and read back", async () => {
  const { d, store } = setup();
  const w = wf("Everything", { strategy: "worktree", trigger: { labels: ["a", "b"], match: "all" } });
  w.worker = { ...w.worker, agent: "custom", command: "my-agent --go" };
  await store.save(w, "repo");
  const back = (await store.load("repo", "everything")).workflow;
  assert.equal(back.strategy, "worktree");
  assert.deepEqual(back.trigger, { labels: ["a", "b"], match: "all" });
  assert.equal(back.worker.command, "my-agent --go");
  assert.equal(JSON.parse(d.fs.get(`${REPO}/everything.json`)).worker.command, "my-agent --go");
});

test("a custom agent without a command is refused and writes nothing", async () => {
  const { d, store } = setup();
  const w = wf("Custom");
  w.reviewer = { ...w.reviewer, agent: "custom", command: "" };
  await assert.rejects(store.save(w, "global"), (e) => e.kind === "invalid" && /command/.test(e.message));
  assert.equal(d.fs.size, 0);
});

test("files saved before scopes and before several labels still load", async () => {
  const old = JSON.stringify({ id: "old", name: "Old", global: true, trigger: { label: "x" } });
  const { store } = setup(ALL, { [`${GLOBAL}/old.json`]: old });
  const found = await store.load("global", "old");
  assert.deepEqual(found.workflow.trigger, { labels: ["x"], match: "any" });
  assert.equal(found.workflow.strategy, "branch");
  assert.equal("global" in found.workflow, false);
});
