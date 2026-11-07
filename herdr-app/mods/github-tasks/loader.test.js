import test from "node:test";
import assert from "node:assert/strict";
import { findRepo, findProjects, loadItems, loadTask, loadStatusField, loadRepoLabels, saveTask, GitHubError, PAGE_SIZE, MAX_ITEMS } from "./loader.js";

const ok = (data) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
const page = (count, endCursor, hasNextPage) => ok({
  node: { items: { pageInfo: { hasNextPage, endCursor }, nodes: Array.from({ length: count }, (_, i) => ({ id: `${endCursor}-${i}` })) } },
});
const SCOPE_ERROR = "GraphQL: Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project']";

test("finds the repo from the folder gh is run in", async () => {
  let seen;
  const repo = await findRepo(async (args, where) => { seen = { args, where }; return { code: 0, stdout: '{"nameWithOwner":"me/app"}', stderr: "" }; }, { cwd: "/x", on: "box" });
  assert.equal(repo, "me/app");
  assert.deepEqual(seen.where, { cwd: "/x", on: "box" });
  assert.deepEqual(seen.args.slice(0, 2), ["repo", "view"]);
});

test("a folder that isn't a repo is named as such", async () => {
  await assert.rejects(findRepo(async () => ({ code: 1, stdout: "", stderr: "failed to run git: fatal: not a git repository\nmore" })), (e) => {
    assert.ok(e instanceof GitHubError);
    assert.equal(e.kind, "not-a-repo");
    assert.equal(e.message, "failed to run git: fatal: not a git repository");
    return true;
  });
});

test("skips closed projects and asks about the right repo", async () => {
  let args;
  const projects = await findProjects(async (a) => {
    args = a;
    return ok({ repository: { projectsV2: { nodes: [{ id: "a", closed: false }, { id: "b", closed: true }, null] } } });
  }, "me/app");
  assert.deepEqual(projects.map((p) => p.id), ["a"]);
  assert.ok(args.includes("owner=me"));
  assert.ok(args.includes("name=app"));
});

test("a missing scope is named even when GitHub answers in part", async () => {
  const gh = async () => ({ code: 1, stdout: JSON.stringify({ data: { repository: { projectsV2: null } } }), stderr: SCOPE_ERROR });
  await assert.rejects(findProjects(gh, "me/app"), (e) => e.kind === "no-scope");
});

test("uses a partial answer when the failure isn't about access", async () => {
  const gh = async () => ({ code: 1, stdout: JSON.stringify({ data: { repository: { projectsV2: { nodes: [{ id: "a", closed: false }] } } } }), stderr: "GraphQL: Something minor" });
  assert.equal((await findProjects(gh, "me/app")).length, 1);
});

test("a failure with no answer throws", async () => {
  await assert.rejects(findProjects(async () => ({ code: 1, stdout: "", stderr: "HTTP 502" }), "me/app"), (e) => e.kind === "other");
});

test("pages through a project with the cursor", async () => {
  const seen = [];
  const pages = [page(PAGE_SIZE, "c1", true), page(3, "c2", false)];
  const got = await loadItems(async (args) => { seen.push(args); return pages.shift(); }, "P1");
  assert.equal(got.nodes.length, PAGE_SIZE + 3);
  assert.equal(got.truncated, false);
  assert.equal(seen.length, 2);
  assert.ok(!seen[0].some((a) => a.startsWith("cursor=")));
  assert.ok(seen[1].includes("cursor=c1"));
});

test("stops at the item limit and says so", async () => {
  let calls = 0;
  const got = await loadItems(async () => { calls++; return page(PAGE_SIZE, `c${calls}`, true); }, "P1");
  assert.equal(got.nodes.length, MAX_ITEMS);
  assert.equal(got.truncated, true);
  assert.equal(calls, MAX_ITEMS / PAGE_SIZE);
});

test("stops when the load is no longer wanted", async () => {
  let calls = 0;
  await loadItems(async () => { calls++; return page(PAGE_SIZE, `c${calls}`, true); }, "P1", undefined, () => false);
  assert.equal(calls, 1);
});

test("asks for the duplicate close reason", async () => {
  let query;
  await loadItems(async (args) => { query = args.find((a) => a.startsWith("query=")); return page(0, "c", false); }, "P1");
  assert.ok(query.includes("stateReason(enableDuplicate: true)"));
});

// ---- one task ----

const issue = { draft: false, number: 7, key: "ITEM_7", title: "Old", status: "Todo" };
const draft = { draft: true, number: null, key: "ITEM_D", contentId: "DI_1", title: "Idea", status: null };
const project = { id: "P1", title: "Board" };
const field = { id: "F1", options: [{ id: "o1", name: "Todo" }, { id: "o2", name: "Done" }] };
const base = { title: "Old", body: "old body", labels: ["bug"], status: "Todo" };
const recorder = (reply = { code: 0, stdout: "", stderr: "" }) => {
  const calls = [];
  const gh = async (args, where) => { calls.push({ args, where }); return typeof reply === "function" ? reply(args) : reply; };
  return { gh, calls };
};
const input = (calls, i = 0) => Object.fromEntries(calls[i].args.filter((a) => a.includes("=") && !a.startsWith("query=")).map((a) => a.split(/=(.*)/s).slice(0, 2)));

test("reads an issue with gh issue view in its repo", async () => {
  const { gh, calls } = recorder({ code: 0, stdout: JSON.stringify({ title: "T", body: "B", labels: [{ name: "bug" }], updatedAt: "2026-03-01T00:00:00Z" }), stderr: "" });
  const got = await loadTask(gh, "me/app", issue, { cwd: "/x" });
  assert.deepEqual(got, { title: "T", body: "B", labels: ["bug"], updatedAt: "2026-03-01T00:00:00Z" });
  assert.deepEqual(calls[0].args.slice(0, 5), ["issue", "view", "7", "-R", "me/app"]);
  assert.deepEqual(calls[0].where, { cwd: "/x" });
});

test("reads a draft through the project by its content id", async () => {
  const { gh, calls } = recorder(() => ok({ node: { title: "Idea", body: "b", updatedAt: "u" } }));
  assert.deepEqual(await loadTask(gh, "me/app", draft), { title: "Idea", body: "b", labels: [], updatedAt: "u" });
  assert.ok(calls[0].args.includes("id=DI_1"));
  await assert.rejects(loadTask(async () => ok({ node: null }), "me/app", draft), /gone/);
});

test("reads the Status field's options, and nothing when there is none", async () => {
  assert.deepEqual(await loadStatusField(async () => ok({ node: { field: field } }), "P1"), field);
  assert.equal(await loadStatusField(async () => ok({ node: { field: {} } }), "P1"), null);
});

test("lists the repo's labels", async () => {
  const { gh, calls } = recorder({ code: 0, stdout: '[{"name":"bug","color":"d73a4a"}]', stderr: "" });
  assert.deepEqual(await loadRepoLabels(gh, "me/app"), [{ name: "bug", color: "d73a4a" }]);
  assert.deepEqual(calls[0].args.slice(0, 4), ["label", "list", "-R", "me/app"]);
  await assert.rejects(loadRepoLabels(async () => ({ code: 1, stdout: "", stderr: "HTTP 404" }), "me/app"), GitHubError);
});

test("sends nothing when nothing changed", async () => {
  const { gh, calls } = recorder();
  assert.deepEqual(await saveTask(gh, { repo: "me/app", ticket: issue, project, statusField: field, before: base, after: base }), []);
  assert.equal(calls.length, 0);
});

test("edits an issue's title, body and labels in one gh issue edit", async () => {
  const { gh, calls } = recorder();
  const after = { title: "New", body: "new body", labels: ["ui"], status: "Todo" };
  assert.deepEqual(await saveTask(gh, { repo: "me/app", ticket: issue, project, statusField: field, before: base, after }, { cwd: "/x" }), ["title", "body", "labels"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["issue", "edit", "7", "-R", "me/app", "--title=New", "--body=new body", "--add-label=ui", "--remove-label=bug"]);
  assert.deepEqual(calls[0].where, { cwd: "/x" });
});

test("sends only the field that changed, even if its text starts with a dash or is empty", async () => {
  const { gh, calls } = recorder();
  await saveTask(gh, { repo: "me/app", ticket: issue, project, statusField: field, before: base, after: { ...base, body: "" } });
  assert.deepEqual(calls[0].args.slice(5), ["--body="]);
  await saveTask(gh, { repo: "me/app", ticket: issue, project, statusField: field, before: base, after: { ...base, title: "--force" } });
  assert.deepEqual(calls[1].args.slice(5), ["--title=--force"]);
});

test("a status change is one project mutation by item, field and option id", async () => {
  const { gh, calls } = recorder();
  assert.deepEqual(await saveTask(gh, { repo: "me/app", ticket: issue, project, statusField: field, before: base, after: { ...base, status: "Done" } }), ["status"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(input(calls), { project: "P1", item: "ITEM_7", field: "F1", option: "o2" });
  assert.ok(calls[0].args.find((a) => a.startsWith("query=")).includes("updateProjectV2ItemFieldValue"));
});

test("a draft is edited through the project, and its labels are ignored", async () => {
  const { gh, calls } = recorder();
  const before = { title: "Idea", body: "", labels: [], status: null };
  await saveTask(gh, { repo: "me/app", ticket: draft, project, statusField: field, before, after: { ...before, title: "Idea 2", body: "more", labels: ["x"] } });
  assert.equal(calls.length, 1);
  assert.deepEqual(input(calls), { id: "DI_1", title: "Idea 2", body: "more" });
  assert.ok(calls[0].args.find((a) => a.startsWith("query=")).includes("updateProjectV2DraftIssue"));
});

test("writes in order, and stops at the first failure with its kind", async () => {
  const { gh, calls } = recorder((args) => (args[0] === "issue" ? { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" } : { code: 0, stdout: "", stderr: "" }));
  await assert.rejects(saveTask(gh, { repo: "me/app", ticket: issue, project, statusField: field, before: base, after: { ...base, title: "New", status: "Done" } }), (e) => e instanceof GitHubError && e.kind === "other");
  assert.equal(calls.length, 1);
});

test("a mutation that GitHub answers in part is a failure, and a missing write scope is named", async () => {
  const gh = async () => ({ code: 1, stdout: JSON.stringify({ data: { updateProjectV2ItemFieldValue: null } }), stderr: "The 'updateProjectV2ItemFieldValue' field requires one of the following scopes: ['project']" });
  await assert.rejects(saveTask(gh, { repo: "me/app", ticket: issue, project, statusField: field, before: base, after: { ...base, status: "Done" } }), (e) => e.kind === "no-write-scope");
});

test("refuses an empty title or an unknown status before sending anything", async () => {
  const { gh, calls } = recorder();
  await assert.rejects(saveTask(gh, { repo: "me/app", ticket: issue, project, statusField: field, before: base, after: { ...base, title: " " } }), /title/);
  await assert.rejects(saveTask(gh, { repo: "me/app", ticket: issue, project, statusField: field, before: base, after: { ...base, status: "Nope" } }), /Nope/);
  assert.equal(calls.length, 0);
});
