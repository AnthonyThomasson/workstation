import test from "node:test";
import assert from "node:assert/strict";
import { findRepo, findProjects, loadItems, GitHubError, PAGE_SIZE, MAX_ITEMS } from "./loader.js";

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
