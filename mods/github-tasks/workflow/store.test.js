import test from "node:test";
import { parse as parseYaml } from "../lib/index.js";
import assert from "node:assert/strict";
import { makeStore, StoreError, cloneWorkflow, replacementFromYaml, restorePlan, canRestoreDefaults, workflowRefreshState } from "./store.js";
import { blank, ROLES, serialize } from "./workflow-model.js";

const GLOBAL = "/home/me/.config/herdr-app/workflows", REPO = "/proj/.herdr/workflows";
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
      mkdir: async (dir) => { calls.push(["mkdir", dir]); },
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

test("cloneWorkflow gives a copy a unique name and slug id", () => {
  const original = wf("Bug", { id: "bug" });
  assert.deepEqual(cloneWorkflow(original, ["bug"]), { ...original, id: "bug-copy", name: "Bug copy" });
  assert.deepEqual(cloneWorkflow(original, ["bug", "bug-copy"]), { ...original, id: "bug-copy-2", name: "Bug copy 2" });
  assert.deepEqual(cloneWorkflow(original, ["bug", "bug-copy", "bug-copy-2"]), { ...original, id: "bug-copy-3", name: "Bug copy 3" });
  assert.equal(original.name, "Bug");
});

test("cloneWorkflow reserves room for a number when the copy slug is already 60 characters", () => {
  const original = wf("A".repeat(60));
  const first = cloneWorkflow(original, []);
  assert.equal(first.id, "a".repeat(60));
  const second = cloneWorkflow(original, [first.id]);
  assert.equal(second.name, `${"A".repeat(60)} copy 2`);
  assert.equal(second.id, `${"a".repeat(58)}-2`);
  assert.equal(second.id.length, 60);
});

test("clone saves copies in the source scope without changing the source", async () => {
  const { store } = setup();
  await store.save(wf("Bug", { worker: { ...wf().worker, model: "sonnet" } }), "repo");
  const first = await store.clone("repo", "bug"), second = await store.clone("repo", "bug");
  assert.deepEqual([first.item.id, first.item.name, first.scope], ["bug-copy", "Bug copy", "repo"]);
  assert.deepEqual([second.item.id, second.item.name, second.scope], ["bug-copy-2", "Bug copy 2", "repo"]);
  assert.equal(first.item.worker.model, "sonnet");
  assert.equal((await store.load("repo", "bug")).item.name, "Bug");
  assert.deepEqual((await store.list()).map((i) => i.id).sort(), ["bug", "bug-copy", "bug-copy-2"]);
});

test("clone keeps its unique id when a long name fills the slug limit", async () => {
  const { store } = setup();
  const name = "A".repeat(60), originalId = "a".repeat(60);
  await store.save(wf(name), "repo");
  const first = await store.clone("repo", originalId);
  const second = await store.clone("repo", originalId);
  assert.equal(first.item.id, `${"a".repeat(58)}-2`);
  assert.equal(second.item.id, `${"a".repeat(58)}-3`);
  assert.deepEqual((await store.list()).map((item) => item.id).sort(), [originalId, first.item.id, second.item.id].sort());
});

test("replacementFromYaml takes the clipboard workflow but keeps the destination id", () => {
  const pasted = wf("Pasted", { id: "clipboard-id", trigger: { labels: ["pasted"], match: "all" } });
  const replacement = replacementFromYaml(serialize(pasted), "destination-id");
  assert.equal(replacement.id, "destination-id");
  assert.equal(replacement.name, "Pasted");
  assert.deepEqual(replacement.trigger, { labels: ["pasted"], match: "all" });
});

test("replacementFromYaml refuses invalid YAML as an invalid paste", () => {
  assert.throws(() => replacementFromYaml("name: [", "destination"), (e) => e instanceof StoreError && e.kind === "invalid" && /not valid YAML/.test(e.message));
});

test("replacementFromYaml refuses a workflow that fails validation", () => {
  assert.throws(() => replacementFromYaml("name: Bad\nworker:\n  effort: extreme\n", "destination"), (e) =>
    e instanceof StoreError && e.kind === "invalid" && e.problems?.[0]?.field === "worker.effort" && /low, medium, high, xhigh, max/.test(e.message));
});

test("paste replaces the workflow in place, keeping its id and scope", async () => {
  const { d, store } = setup();
  await store.save(wf("Original"), "repo");
  const pasted = wf("From clipboard", { id: "different", worker: { ...wf().worker, model: "pasted-model" } });
  const saved = await store.paste("repo", "original", serialize(pasted));
  assert.deepEqual([saved.item.id, saved.item.name, saved.scope], ["original", "From clipboard", "repo"]);
  assert.equal(saved.item.worker.model, "pasted-model");
  assert.deepEqual([...d.fs.keys()], [`${REPO}/original.yaml`]);
});

test("invalid clipboard YAML or workflow content writes nothing", async () => {
  const { d, store } = setup();
  await store.save(wf("Original"), "global");
  const before = new Map(d.fs);
  d.calls.length = 0;
  await assert.rejects(store.paste("global", "original", "name: ["), (e) => e.kind === "invalid");
  await assert.rejects(store.paste("global", "original", "name: Bad\nworker:\n  effort: extreme\n"), (e) => e.kind === "invalid");
  assert.deepEqual(d.fs, before);
  assert.deepEqual(d.calls, []);
});

test("restorePlan captures the repo and deletes the selected tab's workflows", () => {
  const global = { id: "global-one", name: "Global one", scope: "global" };
  const repo = { id: "repo-one", name: "Repo one", scope: "repo" };
  const otherRepo = { id: "broken", name: "broken", scope: "repo", error: "bad YAML" };
  const repoRoot = "/proj";
  assert.deepEqual(restorePlan([global, repo, otherRepo], "repo", repoRoot), { repoRoot, deletions: [repo, otherRepo].map(({ id, name, scope }) => ({ id, name, scope })), createScope: "repo" });
  assert.deepEqual(restorePlan([global, repo], "global", repoRoot), { repoRoot, deletions: [{ ...global }], createScope: "global" });
  assert.deepEqual(restorePlan([global, repo], "all", repoRoot), { repoRoot, deletions: [{ ...global }, { ...repo }], createScope: "global" });
  assert.deepEqual(restorePlan([global], "all", null), { repoRoot: null, deletions: [{ ...global }], createScope: "global" });
});

test("Restore defaults is available only after the current place has loaded", () => {
  assert.equal(canRestoreDefaults({ loaded: false, placeChanged: false }), false);
  assert.equal(canRestoreDefaults({ loaded: true, placeChanged: true }), false);
  assert.equal(canRestoreDefaults({ loaded: false, placeChanged: true }), false);
  assert.equal(canRestoreDefaults({ loaded: true, placeChanged: false }), true);
});

test("a failed refresh does not make Restore defaults available", () => {
  const initial = workflowRefreshState({ loadedPlaceKey: null }, "global", false);
  assert.deepEqual(initial, { loaded: true, loadedPlaceKey: null });
  assert.equal(canRestoreDefaults({ loaded: initial.loaded, placeChanged: "global" !== initial.loadedPlaceKey }), false);

  const oldPlace = workflowRefreshState({ loadedPlaceKey: null }, "old", true);
  const newPlace = workflowRefreshState(oldPlace, "new", false);
  assert.deepEqual(newPlace, { loaded: true, loadedPlaceKey: "old" });
  assert.equal(canRestoreDefaults({ loaded: newPlace.loaded, placeChanged: "new" !== newPlace.loadedPlaceKey }), false);
});

test("restore replaces Project workflows with the shipped starter text, even when Global has Bug and Story", async () => {
  const { d, store } = setup();
  await store.save(wf("Bug"), "global");
  await store.save(wf("Story"), "global");
  await store.save(wf("Old project"), "repo");
  const bug = serialize(wf("Bug", { id: "bug" })), story = serialize(wf("Story", { id: "story" }));
  const items = await store.list();
  await store.restore(restorePlan(items, "repo", "/proj"), [bug, story]);
  assert.deepEqual([...d.fs.keys()].sort(), [`${GLOBAL}/bug.yaml`, `${GLOBAL}/story.yaml`, `${REPO}/bug.yaml`, `${REPO}/story.yaml`].sort());
  assert.equal(d.fs.get(`${REPO}/bug.yaml`), bug);
  assert.equal(d.fs.get(`${REPO}/story.yaml`), story);
});

test("restore Global leaves Project alone, and All leaves starters in Global only", async () => {
  const starters = [serialize(wf("Bug", { id: "bug" })), serialize(wf("Story", { id: "story" }))];
  for (const tab of ["global", "all"]) {
    const { d, store } = setup();
    await store.save(wf("Old global"), "global");
    await store.save(wf("Old project"), "repo");
    await store.restore(restorePlan(await store.list(), tab, "/proj"), starters);
    const expected = tab === "all" ? [`${GLOBAL}/bug.yaml`, `${GLOBAL}/story.yaml`]
      : [`${GLOBAL}/bug.yaml`, `${GLOBAL}/story.yaml`, `${REPO}/old-project.yaml`];
    assert.deepEqual([...d.fs.keys()].sort(), expected.sort());
  }
});

test("an invalid starter is refused before restore deletes anything", async () => {
  const { d, store } = setup();
  await store.save(wf("Keep me"), "global");
  const before = new Map(d.fs);
  d.calls.length = 0;
  const plan = restorePlan(await store.list(), "global", "/proj");
  await assert.rejects(store.restore(plan, ["name: [", serialize(wf("Story", { id: "story" }))]), (e) => e.kind === "invalid");
  await assert.rejects(store.restore(plan, ["name: Bad\nworker:\n  effort: extreme\n", serialize(wf("Story", { id: "story" }))]), (e) => e.kind === "invalid");
  assert.deepEqual(d.fs, before);
  assert.deepEqual(d.calls, []);
});

test("restore puts the original files back when a remove fails", async () => {
  const { d, store } = setup();
  await store.save(wf("First"), "global");
  await store.save(wf("Second"), "global");
  const before = new Map(d.fs), remove = d.io.remove;
  d.io.remove = async (path) => {
    if (path === `${GLOBAL}/second.yaml`) throw new Error("remove failed");
    await remove(path);
  };
  const plan = restorePlan(await store.list(), "global", "/proj");
  const starters = [serialize(wf("Bug", { id: "bug" })), serialize(wf("Story", { id: "story" }))];
  await assert.rejects(store.restore(plan, starters), /remove failed/);
  assert.deepEqual(d.fs, before);
});

test("restore removes partial starters and puts originals back when a write fails", async () => {
  const { d, store } = setup();
  await store.save(wf("Old global"), "global");
  await store.save(wf("Keep project"), "repo");
  const before = new Map(d.fs), writeFile = d.io.write;
  d.io.write = async (path, text, expected) => {
    if (path === `${GLOBAL}/story.yaml`) throw new Error("write failed");
    await writeFile(path, text, expected);
  };
  const plan = restorePlan(await store.list(), "global", "/proj");
  const starters = [serialize(wf("Bug", { id: "bug" })), serialize(wf("Story", { id: "story" }))];
  await assert.rejects(store.restore(plan, starters), /write failed/);
  assert.deepEqual(d.fs, before);
});

test("restore wipes malformed and legacy workflow files too", async () => {
  const { d, store } = setup(ALL, {
    [`${GLOBAL}/broken.yaml`]: "name: [",
    [`${GLOBAL}/old.json`]: JSON.stringify({ name: "Old" }),
    [`${REPO}/keep.yaml`]: serialize(wf("Keep", { id: "keep" })),
  });
  const plan = restorePlan(await store.list(), "global", "/proj");
  assert.deepEqual(plan.deletions.map((item) => item.id).sort(), ["broken", "old"]);
  await store.restore(plan, [serialize(wf("Bug", { id: "bug" })), serialize(wf("Story", { id: "story" }))]);
  assert.deepEqual([...d.fs.keys()].sort(), [`${GLOBAL}/bug.yaml`, `${GLOBAL}/story.yaml`, `${REPO}/keep.yaml`].sort());
});

test("loadText returns the exact stored file even when its workflow is malformed", async () => {
  const source = "name: [\n# kept exactly\n";
  const { store } = setup(ALL, { [`${GLOBAL}/broken.yaml`]: source });
  assert.deepEqual(await store.loadText("global", "broken"), { text: source, scope: "global", legacy: false });
  assert.equal(await store.loadText("global", "absent"), null);
});

test("copyText keeps YAML exact but converts a legacy JSON workflow to YAML", async () => {
  const exact = `${serialize(wf("Exact", { id: "exact" }))}# kept exactly\n`;
  const legacy = wf("Legacy", { id: "legacy" });
  const { store } = setup(ALL, {
    [`${GLOBAL}/exact.yaml`]: exact,
    [`${GLOBAL}/legacy.json`]: JSON.stringify(legacy),
  });
  assert.equal(await store.copyText("global", "exact"), exact);
  assert.equal(await store.copyText("global", "legacy"), serialize(legacy));
});

test("a valid paste can replace a malformed listed file without taking its id from the clipboard", async () => {
  const { d, store } = setup(ALL, { [`${REPO}/broken.yaml`]: "name: [" });
  await store.paste("repo", "broken", serialize(wf("Fixed", { id: "other" })));
  assert.deepEqual([...d.fs.keys()], [`${REPO}/broken.yaml`]);
  assert.equal((await store.load("repo", "broken")).item.name, "Fixed");
});

test("a new workflow is written under its slug in the folder of the scope it is saved to", async () => {
  for (const [scope, dir] of Object.entries(ALL)) {
    const { d, store } = setup();
    const saved = await store.save(wf("Feature Work"), scope);
    assert.equal(saved.item.id, "feature-work");
    assert.equal(saved.scope, scope);
    assert.deepEqual([...d.fs.keys()], [`${dir}/feature-work.yaml`]);
  }
});

test("saving a global workflow makes its folder first, since it may not exist yet", async () => {
  const { d, store } = setup({ global: GLOBAL });
  await store.save(wf("First"), "global");
  assert.deepEqual(d.calls.slice(0, 2), [["mkdir", GLOBAL], ["write", `${GLOBAL}/first.yaml`]]);
});

test("the file holds the workflow and not where it is kept", async () => {
  const { d, store } = setup();
  await store.save(wf("Plain"), "global");
  const file = parseYaml(d.fs.get(`${GLOBAL}/plain.yaml`));
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
  assert.equal((await store.load("repo", "repo-one")).item.id, "repo-one");
  assert.equal(await store.load("repo", "global-one"), null);
  assert.equal(await store.load("global", "repo-one"), null);
});

test("saving again replaces the file; the id stays when the name changes", async () => {
  const { store } = setup();
  await store.save(wf("First name"), "repo");
  const previous = await store.load("repo", "first-name");
  const saved = await store.save({ ...previous.item, name: "Second name" }, "repo", previous);
  assert.equal(saved.item.id, "first-name");
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.load("repo", "first-name")).item.name, "Second name");
});

test("moving a workflow to another scope writes the new file and removes the old one", async () => {
  const { d, store } = setup();
  await store.save(wf("Mover"), "global");
  let previous = await store.load("global", "mover");
  const moved = await store.save(previous.item, "repo", previous);
  assert.equal(moved.scope, "repo");
  assert.deepEqual([...d.fs.keys()], [`${REPO}/mover.yaml`]);

  previous = await store.load("repo", "mover");
  await store.save(previous.item, "global", previous);
  assert.deepEqual([...d.fs.keys()], [`${GLOBAL}/mover.yaml`]);
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
  await assert.rejects(store.save(previous.item, "global", previous), (e) => e.kind === "invalid" && /already exists in global/.test(e.message));
  assert.deepEqual(d.fs, before);
});

test("a file changed on disk since it was read is a conflict, and is not overwritten", async () => {
  const { d, store } = setup();
  await store.save(wf("Shared"), "global");
  const previous = await store.load("global", "shared");
  d.fs.set(`${GLOBAL}/shared.yaml`, previous.text.replace("do it", "someone else's edit"));
  await assert.rejects(store.save({ ...previous.item, name: "Mine" }, "global", previous), (e) => e instanceof StoreError && e.kind === "conflict");
  assert.match(d.fs.get(`${GLOBAL}/shared.yaml`), /someone else's edit/);
});

test("a new workflow cannot take another's name, in any scope", async () => {
  const { d, store } = setup();
  await store.save(wf("Same name"), "global");
  await assert.rejects(store.save(wf("same  NAME"), "repo"), (e) => e.kind === "invalid" && /already exists/.test(e.message));
  assert.equal(d.fs.size, 1);
});

test("an invalid workflow is refused with its problems and writes nothing", async () => {
  const { d, store } = setup();
  await assert.rejects(store.save(blank(), "global"), (e) => e.kind === "invalid" && e.problems.length === 1);
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
  assert.deepEqual([...d.fs.keys()], [`${GLOBAL}/kept.yaml`]);
  await assert.rejects(store.remove("repo", "gone"), (e) => e.kind === "missing");
  await assert.rejects(store.remove("repo", "kept"), (e) => e.kind === "missing");
});

test("a custom agent's command and the trigger labels are saved and read back", async () => {
  const { d, store } = setup();
  const w = wf("Everything", { trigger: { labels: ["a", "b"], match: "all" } });
  w.worker = { ...w.worker, agent: "custom", command: "my-agent --go" };
  await store.save(w, "repo");
  const back = (await store.load("repo", "everything")).item;
  assert.deepEqual(back.trigger, { labels: ["a", "b"], match: "all" });
  assert.equal(back.worker.command, "my-agent --go");
  assert.equal(parseYaml(d.fs.get(`${REPO}/everything.yaml`)).worker.command, "my-agent --go");
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
  assert.deepEqual(found.item.trigger, { labels: ["x"], match: "any" });
  assert.equal("strategy" in found.item, false);
  assert.equal("global" in found.item, false);
});

test("a workflow saved as JSON is rewritten as YAML, and the JSON file goes", async () => {
  const old = JSON.stringify({ id: "old", name: "Old", worker: { prompt: "p" } });
  const { d, store } = setup(ALL, { [`${GLOBAL}/old.json`]: old });
  const found = await store.load("global", "old");
  assert.equal(found.legacy, true);
  assert.deepEqual((await store.list()).map((i) => i.id), ["old"]);
  const saved = await store.save({ ...found.item, orchestrator: { ...found.item.orchestrator, prompt: "o" }, reviewer: { ...found.item.reviewer, prompt: "r" } }, "global", found);
  assert.deepEqual([...d.fs.keys()], [`${GLOBAL}/old.yaml`]);
  assert.equal(saved.legacy, false);
  assert.equal(parseYaml(d.fs.get(`${GLOBAL}/old.yaml`)).name, "Old");
});

test("removing a workflow that is still JSON removes that file", async () => {
  const { d, store } = setup(ALL, { [`${GLOBAL}/old.json`]: JSON.stringify({ name: "Old" }) });
  await store.remove("global", "old");
  assert.equal(d.fs.size, 0);
});

test("loadAll reads every workflow whole, with its scope, by name, and reports the files it cannot read", async () => {
  const { store } = setup(ALL, {
    [`${GLOBAL}/b.yaml`]: "name: Bravo\ntrigger:\n  labels:\n    - bug\n  match: all\nworker:\n  permissions: ask\n",
    [`${GLOBAL}/old.json`]: '{"name":"Alpha","trigger":{"label":"feature"}}',
    [`${REPO}/c.yaml`]: "name: Charlie\n",
    [`${REPO}/broken.yaml`]: "- a list\n",
  });
  const { items, errors } = await store.loadAll();
  assert.deepEqual(items.map((i) => [i.id, i.name, i.scope]), [["old", "Alpha", "global"], ["b", "Bravo", "global"], ["c", "Charlie", "repo"]]);
  assert.deepEqual(items[1].trigger, { labels: ["bug"], match: "all" });
  assert.equal(items[1].worker.permissions, "ask");
  assert.deepEqual(items[0].trigger.labels, ["feature"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^broken\.yaml: not a workflow object/);
});

test("loadAll without a repo reads only the global folder", async () => {
  const { store } = setup({ global: GLOBAL }, { [`${GLOBAL}/g.yaml`]: "name: G\n", [`${REPO}/r.yaml`]: "name: R\n" });
  assert.deepEqual((await store.loadAll()).items.map((i) => i.id), ["g"]);
});

// ---- the refactor kind: the same store over the refactors folders and refactor-model.js ----

import { readFileSync } from "node:fs";
import { REFACTOR, WORKFLOW } from "./kinds.js";
import * as refactorModel from "./refactor-model.js";

const R_GLOBAL = "/home/me/.config/herdr-app/refactors", R_REPO = "/proj/.herdr/refactors";
const R_ALL = { global: R_GLOBAL, repo: R_REPO };
const rf = (name, over = {}) => {
  const r = refactorModel.blank();
  r.name = name;
  r.orchestrator.prompt = "Find it.";
  return { ...r, ...over };
};
const rsetup = (dirs = R_ALL, files = {}) => { const d = disk(files); return { d, store: makeStore({ io: d.io, dirs, kind: REFACTOR }) }; };
const starterText = (name) => readFileSync(new URL(`../starters/${name}.yaml`, import.meta.url), "utf8");

test("the default kind is the workflow one", () => {
  assert.equal(WORKFLOW.folder, "workflows");
  assert.equal(REFACTOR.folder, "refactors");
});

test("a refactor type is saved under its slug in the refactors folder, serialized by refactor-model", async () => {
  const { d, store } = rsetup();
  const saved = await store.save(rf("Redundant tests"), "global");
  assert.deepEqual([...d.fs.keys()], [`${R_GLOBAL}/redundant-tests.yaml`]);
  assert.equal(d.fs.get(`${R_GLOBAL}/redundant-tests.yaml`), refactorModel.serialize({ ...rf("Redundant tests"), id: "redundant-tests" }));
  assert.equal(saved.item.id, "redundant-tests");
  assert.equal(saved.item, saved.item);
  assert.equal(saved.scope, "global");
  await store.save(rf("Repo only"), "repo");
  assert.ok(d.fs.has(`${R_REPO}/repo-only.yaml`));
});

test("a refactor type with no prompt, or a name taken in any scope, is refused with the refactor wording", async () => {
  const { d, store } = rsetup();
  await assert.rejects(store.save(rf("No prompt", { orchestrator: { ...rf("x").orchestrator, prompt: "" } }), "global"),
    (e) => e.kind === "invalid" && e.message === "Give the refactor a prompt.");
  await store.save(rf("Taken"), "global");
  await assert.rejects(store.save(rf("Taken"), "repo"), (e) => e.kind === "invalid" && e.message === "A refactor with that name already exists.");
  assert.deepEqual([...d.fs.keys()], [`${R_GLOBAL}/taken.yaml`]);
});

test("the refactor list and loadAll are by name with scopes, repo only with a repo, and a bad file shows its error", async () => {
  const { d, store } = rsetup(R_ALL, { [`${R_GLOBAL}/broken.yaml`]: "- a" });
  await store.save(rf("Zeta"), "global");
  await store.save(rf("Alpha"), "repo");
  assert.deepEqual(await store.list(), [
    { id: "alpha", name: "Alpha", scope: "repo" },
    { id: "broken", name: "broken", scope: "global", error: "not a refactor object" },
    { id: "zeta", name: "Zeta", scope: "global" },
  ]);
  const all = await store.loadAll();
  assert.deepEqual(all.items.map((i) => [i.id, i.scope]), [["alpha", "repo"], ["zeta", "global"]]);
  assert.deepEqual(all.errors, ["broken.yaml: not a refactor object"]);
  const noRepo = makeStore({ io: d.io, dirs: { global: R_GLOBAL }, kind: REFACTOR });
  assert.deepEqual((await noRepo.list()).map((i) => i.id), ["broken", "zeta"]);
  assert.deepEqual(noRepo.available, ["global"]);
  await assert.rejects(noRepo.save(rf("Nope"), "repo"), (e) => e.kind === "unavailable" && e.message === "Repo refactors aren't available here.");
});

test("a workflow store never lists the refactors folder, nor a refactor store the workflows one", async () => {
  const d = disk();
  const workflows = makeStore({ io: d.io, dirs: { global: GLOBAL } });
  const refactors = makeStore({ io: d.io, dirs: { global: R_GLOBAL }, kind: REFACTOR });
  await workflows.save(wf("A workflow"), "global");
  await refactors.save(rf("A refactor"), "global");
  assert.deepEqual((await workflows.list()).map((i) => i.id), ["a-workflow"]);
  assert.deepEqual((await refactors.list()).map((i) => i.id), ["a-refactor"]);
});

test("load, save again, move, conflict and remove work for refactor types", async () => {
  const { d, store } = rsetup();
  await store.save(rf("Move me"), "global");
  const found = await store.load("global", "move-me");
  assert.equal(found.item.name, "Move me");
  assert.equal(await store.load("repo", "move-me"), null);
  const edited = { ...found.item, name: "Moved", investigator: { ...found.item.investigator, prompt: "Look." } };
  const again = await store.save(edited, "global", found);
  assert.equal(again.item.id, "move-me"); // the id stays when the name changes
  assert.equal(again.item.investigator.prompt, "Look.");
  const moved = await store.save(again.item, "repo", again);
  assert.deepEqual([...d.fs.keys()], [`${R_REPO}/move-me.yaml`]);
  d.fs.set(`${R_REPO}/move-me.yaml`, "changed elsewhere");
  await assert.rejects(store.save(moved.item, "repo", moved), (e) => e.kind === "conflict" && e.message === "This refactor changed on disk after you opened it.");
  d.fs.set(`${R_REPO}/move-me.yaml`, moved.text);
  await store.remove("repo", "move-me");
  assert.equal(d.fs.size, 0);
  await assert.rejects(store.remove("repo", "move-me"), (e) => e.kind === "missing" && e.message === "That refactor is already gone.");
});

test("clone and paste work for refactor types, and paste validates as a refactor", async () => {
  const { d, store } = rsetup();
  await store.save(rf("Tidy"), "global");
  const copy = await store.clone("global", "tidy");
  assert.deepEqual([copy.item.id, copy.item.name], ["tidy-copy", "Tidy copy"]);
  assert.equal(cloneWorkflow(rf("Tidy", { id: "tidy" }), ["tidy"], REFACTOR).id, "tidy-copy");
  assert.ok(await store.copyText("global", "tidy"));
  await assert.rejects(store.paste("global", "tidy", "- a"), (e) => e.kind === "invalid" && /Clipboard is not a valid refactor: not a refactor object/.test(e.message));
  await assert.rejects(store.paste("global", "tidy", refactorModel.serialize(rf("No prompt", { orchestrator: { ...rf("x").orchestrator, prompt: "" } }))),
    (e) => e.kind === "invalid" && e.message === "Give the refactor a prompt.");
  const pasted = await store.paste("global", "tidy", refactorModel.serialize(rf("Other name", { id: "ignored" })));
  assert.deepEqual([pasted.item.id, pasted.item.name], ["tidy", "Other name"]);
  assert.deepEqual([...d.fs.keys()].sort(), [`${R_GLOBAL}/tidy-copy.yaml`, `${R_GLOBAL}/tidy.yaml`]);
  assert.throws(() => replacementFromYaml("- a", "x", REFACTOR), /Clipboard is not a valid refactor/);
});

test("restore puts the four shipped refactor starters in the plan's scope, replacing what was there", async () => {
  const starters = REFACTOR.starters.map(starterText);
  const { d, store } = rsetup();
  await store.save(rf("Old global"), "global");
  await store.save(rf("Old project"), "repo");
  await store.restore(restorePlan(await store.list(), "repo", "/proj"), starters);
  assert.deepEqual([...d.fs.keys()].sort(), [`${R_GLOBAL}/old-global.yaml`, ...REFACTOR.starters.map((n) => `${R_REPO}/${n}.yaml`)].sort());
  assert.equal(d.fs.get(`${R_REPO}/architecture.yaml`), starterText("architecture"));
  await store.restore(restorePlan(await store.list(), "all", "/proj"), starters);
  assert.deepEqual([...d.fs.keys()].sort(), REFACTOR.starters.map((n) => `${R_GLOBAL}/${n}.yaml`).sort());
  const names = (await store.list()).map((i) => i.name);
  assert.deepEqual(names, ["Architecture", "Clean the backlog", "Isolation", "Redundant tests"]);
});

test("an invalid refactor starter is refused before restore deletes anything, and a workflow is not a refactor starter", async () => {
  const { d, store } = rsetup();
  await store.save(rf("Keep me"), "global");
  const before = new Map(d.fs);
  const plan = restorePlan(await store.list(), "global", "/proj");
  const good = starterText("isolation");
  await assert.rejects(store.restore(plan, [good, "name: ["]), (e) => e.kind === "invalid");
  await assert.rejects(store.restore(plan, [good, "name: No prompt\n"]), (e) => e.kind === "invalid" && /Give the refactor a prompt/.test(e.message));
  await assert.rejects(store.restore(plan, [good, readFileSync(new URL("../starters/bug.yaml", import.meta.url), "utf8")]), (e) => e.kind === "invalid");
  assert.deepEqual(d.fs, before);
});
