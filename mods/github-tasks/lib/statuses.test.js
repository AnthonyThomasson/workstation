import test from "node:test";
import assert from "node:assert/strict";
import { groupByStage, STATUSES, spelled, sameStatus, pickableStatuses, wontDoOption, wontDoDisabledReason } from "./statuses.js";

const ticket = (key, createdAt, over = {}) => ({ key, draft: false, number: 1, title: key, url: "u", state: "OPEN", reason: null, createdAt, status: null, ...over });

test("the statuses are fixed", () => {
  assert.deepEqual(STATUSES, { backlog: "To Do", groomed: "Up Next", inProgress: "In Progress", inReview: "In Review", done: "Done", wontDo: "Won't Do" });
  assert.deepEqual(Object.values(STATUSES).at(-1), "Won't Do"); // after Done
});

test("Won't Do tickets are in no sidebar stage", () => {
  const open = [{ number: 1, status: "Won't Do" }, { number: 2, status: "Up Next" }];
  assert.deepEqual(Object.values(groupByStage(open)).flat().map((t) => t.number), [2]);
});

test("pickableStatuses hides Won't Do from a status picker, however it is spelled, and keeps the rest in order", () => {
  const options = [{ id: "a", name: "Todo" }, { id: "b", name: "Won't Do" }, { id: "c", name: "Done" }, { id: "d", name: "Wont do" }];
  assert.deepEqual(pickableStatuses(options), [{ id: "a", name: "Todo" }, { id: "c", name: "Done" }]);
  assert.deepEqual(pickableStatuses(undefined), []);
  assert.deepEqual(pickableStatuses(null), []);
});

test("wontDoOption finds the project's Won't Do option, exact spelling first", () => {
  assert.deepEqual(wontDoOption([{ id: "a", name: "Wont Do" }, { id: "b", name: "Won't Do" }]), { id: "b", name: "Won't Do" });
  assert.deepEqual(wontDoOption([{ id: "a", name: "Wont Do" }]), { id: "a", name: "Wont Do" });
  assert.equal(wontDoOption([{ id: "a", name: "Done" }]), null);
  assert.equal(wontDoOption(undefined), null);
});

test("the Won't Do button's disabled reason, or null", () => {
  const github = { statusOptions: [{ id: "a", name: "Done" }, { id: "b", name: "Won't Do" }] };
  assert.equal(wontDoDisabledReason(github), null);
  assert.equal(wontDoDisabledReason({ ...github, draft: true }), "Create the ticket first");
  assert.equal(wontDoDisabledReason({ ...github, saving: true }), "Saving…");
  assert.equal(wontDoDisabledReason({ ...github, dirty: true }), "Save or revert first");
  assert.equal(wontDoDisabledReason({ ...github, statusOptions: [{ id: "a", name: "Done" }] }), "Add a Won't Do status to the project; see Task settings");
  assert.equal(wontDoDisabledReason({ ...github, statusOptions: [] }), "Add a Won't Do status to the project; see Task settings");
  assert.equal(wontDoDisabledReason({ ...github, statusOptions: null }), "Add a Won't Do status to the project; see Task settings");
  // the earliest reason wins: a draft is told to create it before anything else
  assert.equal(wontDoDisabledReason({ ...github, draft: true, saving: true, dirty: true, statusOptions: [] }), "Create the ticket first");
  assert.equal(wontDoDisabledReason({ ...github, saving: true, dirty: true, statusOptions: [] }), "Saving…");
  assert.equal(wontDoDisabledReason({ ...github, dirty: true, statusOptions: [] }), "Save or revert first");
});

test("spelled gives a status as the project spells it, else the fixed name", () => {
  const options = [{ name: "Todo" }, { name: "In-Progress" }];
  assert.equal(spelled(options, STATUSES.backlog), "Todo");
  assert.equal(spelled(options, STATUSES.inProgress), "In-Progress");
  assert.equal(spelled(options, STATUSES.groomed), "Up Next");
  assert.equal(spelled(undefined, STATUSES.done), "Done");
  assert.ok(sameStatus("To Do", "todo"));
});

test("groups open tickets by stage, dropping other statuses; Up Next and Backlog keep the project's order, In Progress and In Review are newest first", () => {
  const open = [
    ticket("a", "2026-01-01T00:00:00Z", { status: "To Do" }),
    ticket("b", "2026-03-01T00:00:00Z", { status: "to do" }),
    ticket("c", "2026-02-01T00:00:00Z", { status: "Up Next" }),
    ticket("d", "2026-02-01T00:00:00Z", { status: "In Progress" }),
    ticket("e", "2026-02-01T00:00:00Z", { status: "In review" }),
    ticket("f", "2026-02-01T00:00:00Z", { status: null }),
  ];
  const g = groupByStage(open);
  assert.deepEqual(g.backlog.map((t) => t.key), ["a", "b"], "the project's order, not newest first");
  assert.deepEqual(g.groomed.map((t) => t.key), ["c"]);
  assert.deepEqual(g.inProgress.map((t) => t.key), ["d"]);
  assert.deepEqual(g.inReview.map((t) => t.key), ["e"]);
});

test("In Progress and In Review stay newest first; Up Next and Backlog keep the order they arrive in", () => {
  const at = (status, ...keys) => keys.map(([k, created]) => ticket(k, created, { status }));
  const open = [
    ...at("In Progress", ["p-old", "2026-01-01T00:00:00Z"], ["p-new", "2026-03-01T00:00:00Z"]),
    ...at("In Review", ["r-old", "2026-01-01T00:00:00Z"], ["r-new", "2026-03-01T00:00:00Z"]),
    ...at("Up Next", ["n-old", "2026-01-01T00:00:00Z"], ["n-new", "2026-03-01T00:00:00Z"]),
  ];
  const g = groupByStage(open);
  assert.deepEqual(g.inProgress.map((t) => t.key), ["p-new", "p-old"]);
  assert.deepEqual(g.inReview.map((t) => t.key), ["r-new", "r-old"]);
  assert.deepEqual(g.groomed.map((t) => t.key), ["n-old", "n-new"]);
});

test("status names match ignoring case, spaces and punctuation", () => {
  const g = groupByStage([ticket("a", "2026-01-01T00:00:00Z", { status: "Todo" }), ticket("b", "2026-01-01T00:00:00Z", { status: "Up next" })]);
  assert.deepEqual(g.backlog.map((t) => t.key), ["a"]);
  assert.deepEqual(g.groomed.map((t) => t.key), ["b"]);
});

test("groupByStage finds In review whatever its spelling", () => {
  const open = [ticket("r", "2026-01-01T00:00:00Z", { status: "In Review" }), ticket("p", "2026-01-01T00:00:00Z", { status: "In progress" })];
  const g = groupByStage(open);
  assert.deepEqual(g.inReview.map((t) => t.key), ["r"]);
  assert.deepEqual(g.inProgress.map((t) => t.key), ["p"]);
});
