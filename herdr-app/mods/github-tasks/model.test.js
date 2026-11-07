import test from "node:test";
import assert from "node:assert/strict";
import { normalizeItems, groupTickets, chooseProject, classifyError, age, ticketLine, signInFrom, snapshot, labelDiff, changes, isDirty, checkTask } from "./model.js";

test("reads gh's one-time code and page from its sign-in output", () => {
  const out = "\n! One-time code (AA8B-5FB7) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
  assert.deepEqual(signInFrom(out), { code: "AA8B-5FB7", url: "https://github.com/login/device" });
  assert.deepEqual(signInFrom(""), { code: null, url: null });
  assert.deepEqual(signInFrom("! One-time code (6D7D-8CDC)"), { code: "6D7D-8CDC", url: null });
});

const REPO = "me/app";
const issue = (id, over = {}) => ({
  id,
  isArchived: false,
  status: { name: "Todo" },
  content: { __typename: "Issue", number: Number(id), title: `Issue ${id}`, url: `https://x/${id}`, state: "OPEN", stateReason: null, createdAt: "2026-01-01T00:00:00Z", repository: { nameWithOwner: REPO }, ...over },
});
const ticket = (key, createdAt, over = {}) => ({ key, draft: false, number: 1, title: key, url: "u", state: "OPEN", reason: null, createdAt, status: null, ...over });

test("keeps only this repo's issues and drafts", () => {
  const got = normalizeItems([
    issue("1"),
    issue("2", { repository: { nameWithOwner: "me/other" } }),
    { id: "pr", isArchived: false, content: { __typename: "PullRequest", repository: { nameWithOwner: REPO } } },
    { id: "draft", isArchived: false, status: null, content: { __typename: "DraftIssue", title: "Idea", createdAt: "2026-02-01T00:00:00Z" } },
    { ...issue("3"), isArchived: true },
    { id: "hidden", isArchived: false, content: null },
    null,
  ], REPO);
  assert.deepEqual(got.map((t) => t.key), ["1", "draft"]);
  assert.equal(got[1].draft, true);
  assert.equal(got[1].url, null);
  assert.equal(got[1].state, "OPEN");
});

test("matches the repo whatever its case", () => {
  assert.equal(normalizeItems([issue("1")], "ME/App").length, 1);
});

test("carries the project status and the close reason", () => {
  const [t] = normalizeItems([issue("1", { state: "CLOSED", stateReason: "NOT_PLANNED" })], REPO);
  assert.equal(t.status, "Todo");
  assert.equal(t.reason, "NOT_PLANNED");
});

test("orders open tickets newest first", () => {
  const { open } = groupTickets([ticket("old", "2026-01-01T00:00:00Z"), ticket("new", "2026-03-01T00:00:00Z"), ticket("mid", "2026-02-01T00:00:00Z")]);
  assert.deepEqual(open.map((t) => t.key), ["new", "mid", "old"]);
});

test("a reopened issue and a draft are open", () => {
  const { open, closed } = groupTickets([ticket("re", "2026-01-01T00:00:00Z", { reason: "REOPENED" }), ticket("d", "2026-01-02T00:00:00Z", { draft: true })]);
  assert.equal(open.length, 2);
  assert.equal(closed.length, 0);
});

test("splits closed tickets by reason, in a fixed order, newest first, without empty sections", () => {
  const closed = (key, createdAt, reason) => ticket(key, createdAt, { state: "CLOSED", reason });
  const got = groupTickets([
    closed("none", "2026-01-01T00:00:00Z", null),
    closed("dupe", "2026-01-01T00:00:00Z", "DUPLICATE"),
    closed("done-old", "2026-01-01T00:00:00Z", "COMPLETED"),
    closed("done-new", "2026-02-01T00:00:00Z", "COMPLETED"),
    closed("odd", "2026-02-01T00:00:00Z", "SOMETHING_NEW"),
  ]);
  assert.deepEqual(got.closed.map((s) => s.label), ["Completed", "Duplicate", "Closed"]);
  assert.deepEqual(got.closed[0].tickets.map((t) => t.key), ["done-new", "done-old"]);
  assert.deepEqual(got.closed[2].tickets.map((t) => t.key), ["odd", "none"]);
  assert.equal(got.open.length, 0);
});

test("a ticket with no readable date sorts last", () => {
  const { open } = groupTickets([ticket("bad", "nope"), ticket("good", "2026-01-01T00:00:00Z")]);
  assert.deepEqual(open.map((t) => t.key), ["good", "bad"]);
});

test("chooses the saved project, else the first", () => {
  const projects = [{ id: "a" }, { id: "b" }];
  assert.equal(chooseProject(projects, "b").id, "b");
  assert.equal(chooseProject(projects, "gone").id, "a");
  assert.equal(chooseProject(projects).id, "a");
  assert.equal(chooseProject([], "a"), null);
});

test("names gh's failures", () => {
  assert.equal(classifyError("GraphQL: Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project']"), "no-scope");
  assert.equal(classifyError("To get started with GitHub CLI, please run:  gh auth login"), "no-auth");
  assert.equal(classifyError("HTTP 401: Bad credentials"), "no-auth");
  assert.equal(classifyError("failed to run git: fatal: not a git repository (or any of the parent directories): .git"), "not-a-repo");
  assert.equal(classifyError("no git remotes found"), "not-a-repo");
  assert.equal(classifyError("none of the git remotes configured for this repository point to a known GitHub host"), "not-a-repo");
  assert.equal(classifyError("HTTP 502: Bad gateway"), "other");
  assert.equal(classifyError(undefined), "other");
});

test("says how old a ticket is", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  assert.equal(age("2026-11-06T11:59:30Z", now), "just now");
  assert.equal(age("2026-11-06T11:15:00Z", now), "45m ago");
  assert.equal(age("2026-11-06T09:00:00Z", now), "3h ago");
  assert.equal(age("2026-11-03T12:00:00Z", now), "3d ago");
  assert.equal(age("2026-08-06T12:00:00Z", now), "3mo ago");
  assert.equal(age("2024-11-06T12:00:00Z", now), "2y ago");
  assert.equal(age("nope", now), "");
});

test("writes the line under a title, skipping what's missing", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  assert.equal(ticketLine(ticket("a", "2026-11-03T12:00:00Z", { number: 12, status: "In progress" }), now), "#12 · In progress · 3d ago");
  assert.equal(ticketLine(ticket("b", "2026-11-03T12:00:00Z", { draft: true }), now), "Draft · 3d ago");
});

const WRITE_SCOPE_ERROR = "GraphQL: Your token has not been granted the required scopes to execute this query. The 'updateProjectV2ItemFieldValue' field requires one of the following scopes: ['project'], but your token has only been granted the: ['read:project', 'repo'] scopes.";

test("tells a missing write scope from a missing read scope", () => {
  assert.equal(classifyError(WRITE_SCOPE_ERROR), "no-write-scope");
  assert.equal(classifyError("The 'projectsV2' field requires one of the following scopes: ['read:project']"), "no-scope");
});

test("a draft keeps the id its mutation needs", () => {
  const [draft] = normalizeItems([{ id: "item", isArchived: false, status: null, content: { __typename: "DraftIssue", id: "DI_1", title: "Idea", createdAt: "2026-02-01T00:00:00Z" } }], REPO);
  assert.equal(draft.contentId, "DI_1");
});

test("a snapshot sorts and de-duplicates labels and fills what's missing", () => {
  assert.deepEqual(snapshot({ title: "T", labels: ["b", "a", "b"] }), { title: "T", body: "", labels: ["a", "b"], status: null });
  assert.deepEqual(snapshot(undefined), { title: "", body: "", labels: [], status: null });
});

test("says which labels to add and remove", () => {
  assert.deepEqual(labelDiff(["a", "b"], ["b", "c"]), { add: ["c"], remove: ["a"] });
  assert.deepEqual(labelDiff([], []), { add: [], remove: [] });
  assert.deepEqual(labelDiff(undefined, ["x"]), { add: ["x"], remove: [] });
});

test("changes names only what differs, and drafts have no labels", () => {
  const before = { title: "A", body: "x", labels: ["bug"], status: "Todo" };
  assert.deepEqual(changes(before, before), {});
  assert.deepEqual(changes(before, { ...before, title: "B", status: "Done", labels: ["bug", "ui"] }), { title: "B", status: "Done", labels: { add: ["ui"], remove: [] } });
  assert.deepEqual(changes(before, { ...before, body: "" }), { body: "" });
  assert.deepEqual(changes(before, { ...before, labels: [] }, { draft: true }), {});
  assert.equal(isDirty(before, { ...before, labels: ["bug"] }), false);
  assert.equal(isDirty(before, { ...before, body: "y" }), true);
});

test("a save needs a title and a status the project has", () => {
  const options = [{ id: "1", name: "Todo" }];
  assert.equal(checkTask({ title: "  " }, options), "A task needs a title.");
  assert.equal(checkTask({ title: "T", status: "Nope" }, options), 'The project has no "Nope" status.');
  assert.equal(checkTask({ title: "T", status: "Todo" }, options), null);
  assert.equal(checkTask({ title: "T", status: null }, options), null);
});

import { normalizeSettings, groupByStage, groomPrompt, groomArgv, normalizeGroomer, DEFAULT_STATUSES } from "./model.js";

test("grooming statuses default to To Do and Up Next", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_STATUSES);
  assert.deepEqual(normalizeSettings({ backlog: " Ideas ", groomed: "" }), { backlog: "Ideas", groomed: "Up Next" });
});

test("groups open tickets by stage, newest first, dropping other statuses", () => {
  const open = [
    ticket("a", "2026-01-01T00:00:00Z", { status: "To Do" }),
    ticket("b", "2026-03-01T00:00:00Z", { status: "to do" }),
    ticket("c", "2026-02-01T00:00:00Z", { status: "Up Next" }),
    ticket("d", "2026-02-01T00:00:00Z", { status: "In Progress" }),
    ticket("e", "2026-02-01T00:00:00Z", { status: "In review" }),
    ticket("f", "2026-02-01T00:00:00Z", { status: null }),
  ];
  const g = groupByStage(open);
  assert.deepEqual(g.backlog.map((t) => t.key), ["b", "a"]);
  assert.deepEqual(g.groomed.map((t) => t.key), ["c"]);
  assert.deepEqual(g.inProgress.map((t) => t.key), ["d"]);
  assert.deepEqual(groupByStage(open, { backlog: "In review", groomed: "To Do" }).groomed.map((t) => t.key), ["b", "a"]);
});

test("the grooming prompt names the repo, project and both statuses", () => {
  const p = groomPrompt({ repo: "me/app", project: { title: "Roadmap", url: "https://x/p" }, backlog: "Ideas", groomed: "Ready" });
  for (const s of ["me/app", "Roadmap", "https://x/p", '"Ideas"', '"Ready"']) assert.ok(p.includes(s), s);
});

test("status names match ignoring case, spaces and punctuation", () => {
  const g = groupByStage([ticket("a", "2026-01-01T00:00:00Z", { status: "Todo" }), ticket("b", "2026-01-01T00:00:00Z", { status: "Up next" })]);
  assert.deepEqual(g.backlog.map((t) => t.key), ["a"]);
  assert.deepEqual(g.groomed.map((t) => t.key), ["b"]);
});

test("the grooming prompt has the agent ask the person how to clean up and prioritize before changing anything", () => {
  const p = groomPrompt({ repo: "me/app", project: { title: "Roadmap", url: "https://x/p" }, backlog: "Todo", groomed: "Up Next" });
  assert.match(p, /grill the person/);
  for (const s of ["Audit the codebase", "Clean up old tickets", "Prepare tickets for new work"]) assert.ok(p.includes(s), s);
  assert.match(p, /Don't change anything yet/);
});

test("the grooming agent's command carries the chosen model and effort", () => {
  assert.deepEqual(groomArgv("claude", ["claude"], { model: "opus", effort: "high" }), ["claude", "--model", "opus", "--effort", "high"]);
  assert.deepEqual(groomArgv("claude", ["claude"], {}), ["claude", "--effort", "medium"]);
  assert.deepEqual(groomArgv("codex", ["codex"], { model: "gpt-x", effort: "low" }), ["codex", "-m", "gpt-x", "-c", "model_reasoning_effort=low"]);
  assert.deepEqual(groomArgv("kimi", ["kimi"], { model: "k" }), ["kimi", "--model", "k"]);
  assert.deepEqual(normalizeGroomer({ agent: " codex ", effort: "bogus" }), { agent: "codex", model: "", effort: "medium" });
});
