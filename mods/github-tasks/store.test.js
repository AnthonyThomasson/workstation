import test from "node:test";
import { parse as parseYaml } from "./yaml.js";
import assert from "node:assert/strict";
import { makeStore, StoreError, cloneWorkflow, replacementFromYaml, restorePlan } from "./store.js";
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
  assert.deepEqual([first.workflow.id, first.workflow.name, first.scope], ["bug-copy", "Bug copy", "repo"]);
  assert.deepEqual([second.workflow.id, second.workflow.name, second.scope], ["bug-copy-2", "Bug copy 2", "repo"]);
  assert.equal(first.workflow.worker.model, "sonnet");
  assert.equal((await store.load("repo", "bug")).workflow.name, "Bug");
  assert.deepEqual((await store.list()).map((i) => i.id).sort(), ["bug", "bug-copy", "bug-copy-2"]);
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
  assert.deepEqual([saved.workflow.id, saved.workflow.name, saved.scope], ["original", "From clipboard", "repo"]);
  assert.equal(saved.workflow.worker.model, "pasted-model");
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
  assert.equal((await store.load("repo", "broken")).workflow.name, "Fixed");
});

test("a new workflow is written under its slug in the folder of the scope it is saved to", async () => {
  for (const [scope, dir] of Object.entries(ALL)) {
    const { d, store } = setup();
    const saved = await store.save(wf("Feature Work"), scope);
    assert.equal(saved.workflow.id, "feature-work");
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
  assert.deepEqual([...d.fs.keys()], [`${REPO}/mover.yaml`]);

  previous = await store.load("repo", "mover");
  await store.save(previous.workflow, "global", previous);
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
  await assert.rejects(store.save(previous.workflow, "global", previous), (e) => e.kind === "invalid" && /already exists in global/.test(e.message));
  assert.deepEqual(d.fs, before);
});

test("a file changed on disk since it was read is a conflict, and is not overwritten", async () => {
  const { d, store } = setup();
  await store.save(wf("Shared"), "global");
  const previous = await store.load("global", "shared");
  d.fs.set(`${GLOBAL}/shared.yaml`, previous.text.replace("do it", "someone else's edit"));
  await assert.rejects(store.save({ ...previous.workflow, name: "Mine" }, "global", previous), (e) => e instanceof StoreError && e.kind === "conflict");
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
  const back = (await store.load("repo", "everything")).workflow;
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
  assert.deepEqual(found.workflow.trigger, { labels: ["x"], match: "any" });
  assert.equal("strategy" in found.workflow, false);
  assert.equal("global" in found.workflow, false);
});

test("a workflow saved as JSON is rewritten as YAML, and the JSON file goes", async () => {
  const old = JSON.stringify({ id: "old", name: "Old", worker: { prompt: "p" } });
  const { d, store } = setup(ALL, { [`${GLOBAL}/old.json`]: old });
  const found = await store.load("global", "old");
  assert.equal(found.legacy, true);
  assert.deepEqual((await store.list()).map((i) => i.id), ["old"]);
  const saved = await store.save({ ...found.workflow, orchestrator: { ...found.workflow.orchestrator, prompt: "o" }, reviewer: { ...found.workflow.reviewer, prompt: "r" } }, "global", found);
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
