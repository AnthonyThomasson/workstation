import test from "node:test";
import assert from "node:assert/strict";
import { findRepo, findProjects, createProject, createTicket, loadItems, loadTask, loadStatusField, saveTask, markWontDo, moveItem, moveTicket, POSITION_MUTATION, STATUS_MUTATION, GitHubError, PAGE_SIZE, MAX_ITEMS } from "./loader.js";

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

test("findRepo names why gh failed, and refuses an answer it can't read", async () => {
  await assert.rejects(findRepo(async () => ({ code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" })), (e) => e.kind === "no-auth");
  await assert.rejects(findRepo(async () => ({ code: 1, stdout: "", stderr: "boom\nmore" })), (e) => e.kind === "other" && e.message === "boom");
  await assert.rejects(findRepo(async () => ({ code: 0, stdout: "not json", stderr: "" })), (e) => e instanceof GitHubError && e.kind === "other");
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

// ---- making a project for a repo ----

test("makes a project titled with the repo's name, owned by the repo's owner and linked to the repo", async () => {
  const { gh, calls } = recorder((args) => (args.some((a) => a.includes("createProjectV2"))
    ? ok({ createProjectV2: { projectV2: { id: "P9", title: "app", url: "https://github.com/users/me/projects/9", closed: false } } })
    : ok({ repository: { id: "R1", owner: { id: "O1" } } })));
  const made = await createProject(gh, "me/app", { cwd: "/x" });
  assert.deepEqual(made, { id: "P9", title: "app", url: "https://github.com/users/me/projects/9", closed: false });
  assert.deepEqual(input(calls, 0), { owner: "me", name: "app" });
  assert.deepEqual(input(calls, 1), { owner: "O1", repo: "R1", title: "app" });
  assert.deepEqual(calls[1].where, { cwd: "/x" });
});

test("a project can't be made without the project scope, and that is named", async () => {
  const { gh } = recorder((args) => (args.some((a) => a.includes("createProjectV2"))
    ? { code: 1, stdout: "", stderr: "The 'createProjectV2' field requires one of the following scopes: ['project']" }
    : ok({ repository: { id: "R1", owner: { id: "O1" } } })));
  await assert.rejects(createProject(gh, "me/app"), (e) => e.kind === "no-write-scope");
});

test("a repo GitHub doesn't know makes no project", async () => {
  const { gh, calls } = recorder(ok({ repository: null }));
  await assert.rejects(createProject(gh, "me/app"), /no repo called me\/app/);
  assert.equal(calls.length, 1);
});

// ---- Won't Do ----

const wontField = { id: "F1", options: [{ id: "o1", name: "Todo" }, { id: "o2", name: "Done" }, { id: "o3", name: "Won't Do" }] };
const wontArgs = { repo: "me/app", ticket: issue, project, statusField: wontField };

test("Won't Do sets the project Status first, then closes the issue as not planned", async () => {
  const { gh, calls } = recorder();
  await markWontDo(gh, wontArgs, { cwd: "/x", on: "box" });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.find((a) => a.startsWith("query=")).includes("updateProjectV2ItemFieldValue"));
  assert.deepEqual(input(calls, 0), { project: "P1", item: "ITEM_7", field: "F1", option: "o3" });
  assert.deepEqual(calls[1].args, ["issue", "close", "7", "-R", "me/app", "--reason", "not planned"]);
  assert.deepEqual(calls.map((c) => c.where), [{ cwd: "/x", on: "box" }, { cwd: "/x", on: "box" }]);
});

test("Won't Do finds a loosely spelled option, preferring the exact one", async () => {
  const loose = { id: "F1", options: [{ id: "a", name: "Wont Do" }] };
  const { gh, calls } = recorder();
  await markWontDo(gh, { ...wontArgs, statusField: loose });
  assert.equal(input(calls, 0).option, "a");
});

test("Won't Do sends nothing when the project has no such option, no Status field, or the ticket is a draft", async () => {
  const { gh, calls } = recorder();
  await assert.rejects(markWontDo(gh, { ...wontArgs, statusField: field }), (e) => e instanceof GitHubError && /Won't Do/.test(e.message));
  await assert.rejects(markWontDo(gh, { ...wontArgs, statusField: null }), /Won't Do/);
  await assert.rejects(markWontDo(gh, { ...wontArgs, ticket: draft }), (e) => e instanceof GitHubError && /draft/i.test(e.message));
  assert.equal(calls.length, 0);
});

test("when setting the Status fails, the issue is not closed and the error has its kind", async () => {
  const { gh, calls } = recorder({ code: 1, stdout: "", stderr: "The 'updateProjectV2ItemFieldValue' field requires one of the following scopes: ['project']" });
  await assert.rejects(markWontDo(gh, wontArgs), (e) => e instanceof GitHubError && e.kind === "no-write-scope" && !/status was set/i.test(e.message));
  assert.equal(calls.length, 1);
});

test("when the Status was set but closing failed, the message says so and keeps GitHub's reason", async () => {
  const { gh, calls } = recorder((args) => (args[0] === "issue" ? { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by integration\nmore" } : { code: 0, stdout: "", stderr: "" }));
  await assert.rejects(markWontDo(gh, wontArgs), (e) => {
    assert.ok(e instanceof GitHubError);
    assert.equal(e.message, "The status was set to Won't Do, but closing the issue failed: HTTP 403: Resource not accessible by integration");
    return true;
  });
  assert.equal(calls.length, 2);
});

test("a close that fails with no words still says the Status was set", async () => {
  const { gh } = recorder((args) => (args[0] === "issue" ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" }));
  await assert.rejects(markWontDo(gh, wontArgs), /^Error: The status was set to Won't Do, but closing the issue failed: GitHub didn't answer\.$/);
});

test("a close that fails keeps the failure's kind, so a missing sign-in is still named", async () => {
  const { gh } = recorder((args) => (args[0] === "issue" ? { code: 1, stdout: "", stderr: "gh auth login required" } : { code: 0, stdout: "", stderr: "" }));
  await assert.rejects(markWontDo(gh, wontArgs), (e) => e.kind === "no-auth");
});

// ---- moving an item ----

test("moveItem sends updateProjectV2ItemPosition with the item and the one it goes after", async () => {
  const { gh, calls } = recorder();
  await moveItem(gh, { projectId: "P1", itemId: "ITEM_7", afterId: "ITEM_3" }, { cwd: "/x" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ["api", "graphql", "-f"]);
  assert.equal(calls[0].args[3], `query=${POSITION_MUTATION}`);
  assert.ok(POSITION_MUTATION.includes("updateProjectV2ItemPosition"));
  assert.deepEqual(input(calls), { project: "P1", item: "ITEM_7", after: "ITEM_3" });
  assert.deepEqual(calls[0].where, { cwd: "/x" });
});

test("moveItem to the top leaves the after variable out: gh would send an empty string, not null", async () => {
  for (const afterId of [null, undefined]) {
    const { gh, calls } = recorder();
    await moveItem(gh, { projectId: "P1", itemId: "ITEM_7", afterId });
    assert.deepEqual(input(calls), { project: "P1", item: "ITEM_7" });
    assert.ok(!calls[0].args.some((a) => a.startsWith("after=")));
  }
});

test("moveItem throws GitHubError when gh fails", async () => {
  const { gh } = recorder({ code: 1, stdout: "", stderr: "gh auth login required" });
  await assert.rejects(moveItem(gh, { projectId: "P1", itemId: "I", afterId: null }), (e) => e instanceof GitHubError && e.kind === "no-auth");
});

// ---- moving a ticket: its Status (when the section changes), then its position ----

const statusField = { id: "F1", options: [{ id: "o-todo", name: "Todo" }, { id: "o-next", name: "Up Next" }] };

test("moveTicket sets the Status, in the project's spelling, then the position", async () => {
  const { gh, calls } = recorder();
  await moveTicket(gh, { projectId: "P1", itemId: "I7", afterId: "I3", status: "To Do", statusField }, { cwd: "/x" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[3], `query=${STATUS_MUTATION}`);
  assert.deepEqual(input(calls, 0), { project: "P1", item: "I7", field: "F1", option: "o-todo" });
  assert.equal(calls[1].args[3], `query=${POSITION_MUTATION}`);
  assert.deepEqual(input(calls, 1), { project: "P1", item: "I7", after: "I3" });
  assert.deepEqual(calls[1].where, { cwd: "/x" });
});

test("moveTicket with no status only moves the position, to the top when nothing precedes", async () => {
  const { gh, calls } = recorder();
  await moveTicket(gh, { projectId: "P1", itemId: "I7", afterId: null, status: null, statusField: null });
  assert.equal(calls.length, 1);
  assert.deepEqual(input(calls), { project: "P1", item: "I7" });
});

test("moveTicket moves nothing when the project has no such status", async () => {
  const { gh, calls } = recorder();
  await assert.rejects(moveTicket(gh, { projectId: "P1", itemId: "I7", afterId: "I3", status: "In Review", statusField }), (e) => e instanceof GitHubError && /In Review/.test(e.message));
  await assert.rejects(moveTicket(gh, { projectId: "P1", itemId: "I7", afterId: "I3", status: "Up Next", statusField: null }), GitHubError);
  assert.equal(calls.length, 0);
});

test("moveTicket stops at a failed Status write and never sends the position", async () => {
  const { gh, calls } = recorder({ code: 1, stdout: "", stderr: "boom" });
  await assert.rejects(moveTicket(gh, { projectId: "P1", itemId: "I7", afterId: "I3", status: "Up Next", statusField }), GitHubError);
  assert.equal(calls.length, 1);
});

// ---- createTicket (herdr-tasks create) ----

const ISSUE_URL = "https://github.com/me/app/issues/31";
const issueGh = (over = {}) => recorder((args) => {
  if (args[0] === "issue" && args[1] === "create") return over.create ?? { code: 0, stdout: `Creating issue in me/app\n\n${ISSUE_URL}\n`, stderr: "" };
  if (args[0] === "issue" && args[1] === "view") return over.view ?? { code: 0, stdout: JSON.stringify({ id: "I_31", number: 31, title: "New", url: ISSUE_URL, state: "OPEN", createdAt: "2026-11-11T00:00:00Z", labels: [{ name: "bug" }] }), stderr: "" };
  const query = args.find((a) => a.startsWith("query=")) ?? "";
  if (query.includes("addProjectV2ItemById")) return over.add ?? ok({ addProjectV2ItemById: { item: { id: "ITEM_31" } } });
  if (query.includes("addProjectV2DraftIssue")) return ok({ addProjectV2DraftIssue: { projectItem: { id: "ITEM_D2", content: { id: "DI_2", title: "Idea", createdAt: "2026-11-11T00:00:00Z" } } } });
  if (query.includes("updateProjectV2ItemFieldValue")) return over.status ?? { code: 0, stdout: "{}", stderr: "" };
  return { code: 0, stdout: "{}", stderr: "" };
});

test("createTicket makes an issue, adds it to the project and sets its status, in the project's spelling", async () => {
  const { gh, calls } = issueGh();
  const ticket = await createTicket(gh, { repo: "me/app", project, title: "New", body: "Why", labels: ["bug"], status: "To Do", statusField: field }, { cwd: "/x" });
  assert.deepEqual(calls[0].args, ["issue", "create", "-R", "me/app", "--title=New", "--body=Why", "--label=bug"]);
  assert.deepEqual(calls[1].args.slice(0, 3), ["issue", "view", ISSUE_URL]);
  assert.deepEqual(input(calls, 2), { project: "P1", content: "I_31" });
  assert.deepEqual(input(calls, 3), { project: "P1", item: "ITEM_31", field: "F1", option: "o1" });
  assert.deepEqual(calls.map((c) => c.where), Array(4).fill({ cwd: "/x" }));
  assert.deepEqual(ticket, { key: "ITEM_31", draft: false, number: 31, title: "New", url: ISSUE_URL, state: "OPEN", reason: null, createdAt: "2026-11-11T00:00:00Z", closedAt: null, status: "Todo", labels: ["bug"] });
});

test("createTicket with no status leaves the item without one, and always sends a body", async () => {
  const { gh, calls } = issueGh();
  const ticket = await createTicket(gh, { repo: "me/app", project, title: "New" });
  assert.ok(calls[0].args.includes("--body="));
  assert.equal(calls.length, 3);
  assert.equal(ticket.status, null);
});

test("createTicket makes a draft, then its description, then its status", async () => {
  const { gh, calls } = issueGh();
  const ticket = await createTicket(gh, { project, title: "Idea", body: "More", status: "Done", statusField: field, draft: true });
  assert.ok(calls[0].args.find((a) => a.startsWith("query=")).includes("addProjectV2DraftIssue"));
  assert.deepEqual(input(calls, 1), { id: "DI_2", title: "Idea", body: "More" });
  assert.deepEqual(input(calls, 2), { project: "P1", item: "ITEM_D2", field: "F1", option: "o2" });
  assert.equal(ticket.draft, true);
  assert.equal(ticket.status, "Done");
});

test("createTicket checks the title and the status before it makes anything", async () => {
  const { gh, calls } = issueGh();
  await assert.rejects(createTicket(gh, { repo: "me/app", project, title: " " }), /needs a title/);
  await assert.rejects(createTicket(gh, { repo: "me/app", project, title: "T", status: "Up Next", statusField: field }), (e) => e instanceof GitHubError && /no "Up Next" status/.test(e.message));
  await assert.rejects(createTicket(gh, { repo: "me/app", project, title: "T", status: "Todo", statusField: null }), /no "Todo" status/);
  assert.equal(calls.length, 0);
});

test("createTicket says what was made when a later step fails", async () => {
  const refused = issueGh({ create: { code: 1, stdout: "", stderr: "could not add label: 'nope' not found" } });
  await assert.rejects(createTicket(refused.gh, { repo: "me/app", project, title: "T", labels: ["nope"] }), /could not add label/);
  assert.equal(refused.calls.length, 1);
  const notAdded = issueGh({ add: { code: 1, stdout: "", stderr: "GraphQL: Something went wrong" } });
  await assert.rejects(createTicket(notAdded.gh, { repo: "me/app", project, title: "T" }), (e) => /^#31 was made, but adding it to the project failed: GraphQL: Something went wrong/.test(e.message));
  const noStatus = issueGh({ status: { code: 1, stdout: "", stderr: "boom" } });
  await assert.rejects(createTicket(noStatus.gh, { repo: "me/app", project, title: "T", status: "Done", statusField: field }), /#31 was made, but its status wasn't set to Done: boom/);
});
