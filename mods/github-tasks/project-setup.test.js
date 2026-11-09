import test from "node:test";
import assert from "node:assert/strict";
import { setupProject, setupNote, STATUS_FIELD_MUTATION, statusOptionsMutation } from "./project-setup.js";
import { STATUSES } from "./model.js";
import { LABEL_LIMIT } from "./labels.js";

const ok = (data) => ({ code: 0, stdout: JSON.stringify(data), stderr: "" });
const fail = (stderr) => ({ code: 1, stdout: "", stderr });
const project = { id: "P1", title: "app", url: "https://x/p" };
const wf = (...labels) => ({ id: "w", name: "w", trigger: { labels, match: "any" } });

// A fake gh: records every call, answers the Status field, the repo's labels, and label creates.
function fakeGh({ labels = [], statusField = { id: "F1", options: [{ id: "a", name: "Todo" }] }, failing = {} } = {}) {
  const calls = [];
  const gh = async (args, where) => {
    calls.push({ args, where });
    const joined = args.join(" ");
    if (args[0] === "api" && joined.includes("field(name:")) return failing.read ? fail("HTTP 500") : ok({ data: { node: { field: statusField } } });
    if (args[0] === "api" && joined.includes("updateProjectV2Field")) return failing.statuses ? fail("HTTP 403: forbidden") : ok({ data: {} });
    if (args[0] === "label" && args[1] === "list") return failing.list ? fail("HTTP 502") : ok(labels.map((name) => ({ name, color: "ededed" })));
    if (args[0] === "label" && args[1] === "create") return failing.create === args.find((a, i) => i > 1 && a !== "-R" && a !== "--" && args[i - 1] !== "-R") ? fail("could not create") : { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected gh ${joined}`);
  };
  return { gh, calls };
}
const created = (calls) => calls.filter((c) => c.args[0] === "label" && c.args[1] === "create").map((c) => c.args);
const run = (fake, workflows = [wf("bug")], extra = {}) =>
  setupProject(fake.gh, { repo: "acme/app", project, loadWorkflows: async () => ({ items: workflows, errors: [] }), where: { cwd: "/x" }, ...extra });

test("the Status field is replaced in one mutation with the six fixed statuses, in order, Won't Do last", async () => {
  const fake = fakeGh();
  const result = await run(fake);
  const mutation = fake.calls.filter((c) => c.args.join(" ").includes("updateProjectV2Field"));
  assert.equal(mutation.length, 1);
  const query = mutation[0].args.find((a) => a.startsWith("query="));
  const names = [...query.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, Object.values(STATUSES));
  assert.deepEqual(names, ["To Do", "Up Next", "In Progress", "In Review", "Done", "Won't Do"]);
  assert.ok(mutation[0].args.includes("field=F1"));
  assert.deepEqual(result.problems, []);
  assert.equal(mutation[0].where.cwd, "/x");
});

test("statusOptionsMutation gives every option a color and a description, which GitHub requires", () => {
  const q = statusOptionsMutation(["A", "B"]);
  assert.equal([...q.matchAll(/color: GRAY, description: ""/g)].length, 2);
  assert.ok(STATUS_FIELD_MUTATION.includes("updateProjectV2Field"));
});

test("a trigger label the repo lacks is created with plain gh label create, and an existing one is left alone", async () => {
  const fake = fakeGh({ labels: ["Bug", "other"] });
  const result = await run(fake, [wf("bug", "feature"), wf("FEATURE", "Story")]);
  assert.deepEqual(created(fake.calls), [["label", "create", "feature", "-R", "acme/app"], ["label", "create", "Story", "-R", "acme/app"]]);
  assert.deepEqual(result.created, ["feature", "Story"]);
  assert.deepEqual(result.problems, []);
});

test("a trigger label starting with a dash is created after --, so it isn't read as a flag", async () => {
  const fake = fakeGh();
  const result = await run(fake, [wf("-wip", "bug")]);
  assert.deepEqual(created(fake.calls), [["label", "create", "-R", "acme/app", "--", "-wip"], ["label", "create", "bug", "-R", "acme/app"]]);
  assert.deepEqual(result.created, ["-wip", "bug"]);
  assert.deepEqual(result.problems, []);
});

test("when the repo has every trigger label, none is created and no other label is", async () => {
  const fake = fakeGh({ labels: ["bug"] });
  await run(fake);
  assert.deepEqual(created(fake.calls), []);
  const none = fakeGh();
  await run(none, [wf()]); // a fallback workflow has no trigger label
  assert.deepEqual(created(none.calls), []);
});

test("a statuses failure is reported and the labels are still created", async () => {
  const fake = fakeGh({ failing: { statuses: true } });
  const result = await run(fake);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /statuses/i);
  assert.match(result.problems[0], /forbidden/);
  assert.deepEqual(created(fake.calls), [["label", "create", "bug", "-R", "acme/app"]]);
});

test("a project without a Status field is a statuses problem", async () => {
  const result = await run(fakeGh({ statusField: null }));
  assert.match(result.problems[0], /Status field/);
});

test("a label that fails to create is reported by name, and the rest are still tried", async () => {
  const fake = fakeGh({ failing: { create: "bug" } });
  const result = await run(fake, [wf("bug", "feature")]);
  assert.equal(created(fake.calls).length, 2);
  assert.deepEqual(result.created, ["feature"]);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /"bug"/);
});

test("failing to list the repo's labels or to read the workflows creates nothing and says so", async () => {
  const listing = fakeGh({ failing: { list: true } });
  const a = await run(listing);
  assert.deepEqual(created(listing.calls), []);
  assert.match(a.problems[0], /labels/i);
  const b = await run(fakeGh(), [], { loadWorkflows: async () => { throw new Error("no folder"); } });
  assert.match(b.problems[0], /workflows/i);
});

test("a repo with LABEL_LIMIT or more labels gets no label created, and a problem says they couldn't all be read", async () => {
  const labels = Array.from({ length: LABEL_LIMIT }, (_, i) => `l${i}`);
  const fake = fakeGh({ labels });
  const result = await run(fake, [wf("zzz-late", "bug")]);
  assert.deepEqual(created(fake.calls), []);
  assert.deepEqual(result.created, []);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /couldn't all be read/);
  assert.match(result.problems[0], /zzz-late/);
  assert.equal(result.doctorFixes, false);
  const below = fakeGh({ labels: labels.slice(1) });
  await run(below);
  assert.equal(created(below.calls).length, 1);
});

test("doctorFixes is true for a statuses failure or a label that failed to create, false for unreadable workflows or labels", async () => {
  assert.equal((await run(fakeGh())).doctorFixes, false);
  assert.equal((await run(fakeGh({ failing: { statuses: true } }))).doctorFixes, true);
  assert.equal((await run(fakeGh({ failing: { create: "bug" } }))).doctorFixes, true);
  assert.equal((await run(fakeGh({ failing: { list: true } }))).doctorFixes, false);
  assert.equal((await run(fakeGh(), [], { loadWorkflows: async () => { throw new Error("no folder"); } })).doctorFixes, false);
});

test("setupProject never throws, even when gh does", async () => {
  const result = await setupProject(async () => { throw new Error("gh is gone"); }, { repo: "a/b", project, loadWorkflows: async () => ({ items: [wf("bug")], errors: [] }), where: {} });
  assert.equal(result.problems.length, 2);
});

test("setupNote is empty when all went well, and otherwise says what failed and points at the Doctor", () => {
  assert.equal(setupNote([]), null);
  const text = setupNote(["The statuses weren't set: nope."], true);
  assert.match(text, /project was made/i);
  assert.match(text, /statuses weren't set/);
  assert.match(text, /Doctor/);
  const unreadable = setupNote(["The saved workflows couldn't be read, so their labels weren't checked: x."], false);
  assert.match(unreadable, /couldn't be read/);
  assert.doesNotMatch(unreadable, /Doctor/);
});
