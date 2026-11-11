import test from "node:test";
import assert from "node:assert/strict";
import { normalizeItems, groupTickets, chooseProject, age, ticketLine, recentlyDone, middleEllipsis } from "./tickets.js";

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

test("keeps open tickets in the project's own order, whatever their age", () => {
  const { open } = groupTickets([ticket("old", "2026-01-01T00:00:00Z"), ticket("new", "2026-03-01T00:00:00Z"), ticket("mid", "2026-02-01T00:00:00Z")]);
  assert.deepEqual(open.map((t) => t.key), ["old", "new", "mid"]);
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
  const done = (key, createdAt) => ticket(key, createdAt, { state: "CLOSED", reason: "COMPLETED" });
  const { closed } = groupTickets([done("bad", "nope"), done("good", "2026-01-01T00:00:00Z")]);
  assert.deepEqual(closed[0].tickets.map((t) => t.key), ["good", "bad"]);
});

test("chooses the saved project, else the first", () => {
  const projects = [{ id: "a" }, { id: "b" }];
  assert.equal(chooseProject(projects, "b").id, "b");
  assert.equal(chooseProject(projects, "gone").id, "a");
  assert.equal(chooseProject(projects).id, "a");
  assert.equal(chooseProject([], "a"), null);
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

test("a draft keeps the id its mutation needs", () => {
  const [draft] = normalizeItems([{ id: "item", isArchived: false, status: null, content: { __typename: "DraftIssue", id: "DI_1", title: "Idea", createdAt: "2026-02-01T00:00:00Z" } }], REPO);
  assert.equal(draft.contentId, "DI_1");
});

test("recentlyDone: only what was closed as done in the last day, newest first", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const done = (key, closedAt) => ticket(key, "2026-01-01T00:00:00Z", { state: "CLOSED", reason: "COMPLETED", closedAt });
  const sections = [
    { key: "COMPLETED", tickets: [done("old", "2026-11-05T12:00:00Z"), done("a", "2026-11-07T01:00:00Z"), done("b", "2026-11-07T09:00:00Z")] },
    { key: "NOT_PLANNED", tickets: [done("no", "2026-11-07T09:00:00Z")] },
  ];
  assert.deepEqual(recentlyDone(sections, now).map((t) => t.key), ["b", "a"]);
  assert.deepEqual(recentlyDone([], now), []);
});

test("middleEllipsis keeps both ends of a long name and leaves a short one alone", () => {
  assert.equal(middleEllipsis("Short", 20), "Short");
  const cut = middleEllipsis("Some big name of the task that goes on", 20);
  assert.ok(cut.length <= 20, cut);
  assert.ok(cut.startsWith("Some") && cut.includes(" ... ") && cut.endsWith("on"));
});
