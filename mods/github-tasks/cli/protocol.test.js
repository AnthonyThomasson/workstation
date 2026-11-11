import test from "node:test";
import assert from "node:assert/strict";
import { CliError, EXIT, OPS, VERSION, checkRequest, claimedName, exitFor, failReply, fileName, findNamed, findTicket, isId, makeRequest, okReply, partName, pickProject, requestId, waitingId } from "./protocol.js";

const NOW = 1_800_000_000_000;
const request = (over = {}) => ({ ...makeRequest({ id: "abc-12345678", op: "list", args: {}, where: { cwd: "/repo", on: null }, project: null, at: NOW, timeout: 120 }), ...over });
const check = (over, now = NOW) => checkRequest(JSON.stringify(request(over)), now);

test("a request id is time and chance in base 36, safe as a file name, and sorts by time", () => {
  const a = requestId(NOW, 0.5), b = requestId(NOW + 1000, 0.5);
  assert.ok(isId(a) && isId(b));
  assert.ok(a < b);
  assert.notEqual(requestId(NOW, 0.1), requestId(NOW, 0.2));
  for (const bad of ["", "../x", "a/b-c", "ABC-def", "abc", null, 3]) assert.equal(isId(bad), false, String(bad));
});

test("the mailbox's names: a waiting request, the taken one, the reply being written", () => {
  assert.equal(fileName("a-b"), "a-b.json");
  assert.equal(claimedName("a-b"), "a-b.json.claimed");
  assert.equal(partName("a-b"), "a-b.json.part");
  assert.equal(waitingId("abc-123.json"), "abc-123");
  for (const other of ["abc-123.json.claimed", "abc-123.json.part", "abc-123.json.99.tmp", ".DS_Store", "x.json", ""]) assert.equal(waitingId(other), null, other);
});

test("a well-formed request is acted on, with an empty machine and project as none", () => {
  const { request: r } = check({ where: { cwd: "/repo", on: "" }, project: "" });
  assert.equal(r.op, "list");
  assert.deepEqual(r.where, { cwd: "/repo", on: null });
  assert.equal(r.project, null);
  assert.equal(r.v, VERSION);
});

test("a request the bridge can't trust is refused with a reason, and with its id when it has one", () => {
  assert.deepEqual(checkRequest("{nope", NOW), { error: "The request isn't JSON.", id: null });
  assert.equal(checkRequest("[]", NOW).id, null);
  assert.equal(check({ id: "../../etc" }).id, null);
  const cases = [
    [{ v: 99 }, /version/],
    [{ op: "rm" }, /no "rm" operation/],
    [{ args: [] }, /args/],
    [{ where: { cwd: "relative" } }, /folder/],
    [{ where: null }, /folder/],
    [{ where: { cwd: "/x", on: 3 } }, /machine/],
    [{ project: 5 }, /project/],
    [{ timeout: 0 }, /time/],
    [{ at: "soon" }, /time/],
  ];
  for (const [over, why] of cases) {
    const r = check(over);
    assert.match(r.error, why, JSON.stringify(over));
    assert.equal(r.id, "abc-12345678");
  }
});

test("a request whose command has stopped waiting is dropped without a reply", () => {
  assert.deepEqual(check({}, NOW + 121_000), { expired: "abc-12345678" });
  assert.ok(check({}, NOW + 119_000).request);
});

test("every op the commands send is one the bridge knows", () => {
  assert.equal(new Set(OPS).size, OPS.length);
  assert.ok(OPS.includes("start") && OPS.includes("merge") && OPS.includes("create"));
});

test("replies, and the exit code each gives", () => {
  assert.deepEqual(okReply("a-b", { x: 1 }), { v: VERSION, id: "a-b", ok: true, data: { x: 1 } });
  assert.deepEqual(failReply("a-b", "nope"), { v: VERSION, id: "a-b", ok: false, error: "nope", code: null, data: null });
  assert.equal(exitFor(okReply("a-b")), EXIT.ok);
  assert.equal(exitFor(failReply("a-b", "x")), EXIT.failed);
  assert.equal(exitFor(failReply("a-b", "x", { code: "choose", data: { choices: [] } })), EXIT.choose);
  const e = new CliError("pick", { code: "choose", data: { choices: [1] } });
  assert.equal(e.message, "pick");
  assert.equal(e.code, "choose");
  assert.deepEqual(e.data, { choices: [1] });
});

const TICKETS = [
  { key: "PVTI_1", number: 12, title: "Fix login" },
  { key: "PVTI_2", number: 13, title: "Same name" },
  { key: "PVTI_3", number: 14, title: "same NAME" },
  { key: "PVTI_4", number: null, title: "A draft", draft: true },
];

test("a ticket is found by number, #number, item key or whole title", () => {
  assert.equal(findTicket(TICKETS, "12").ticket.key, "PVTI_1");
  assert.equal(findTicket(TICKETS, "#12").ticket.key, "PVTI_1");
  assert.equal(findTicket(TICKETS, " PVTI_4 ").ticket.title, "A draft");
  assert.equal(findTicket(TICKETS, "fix LOGIN").ticket.number, 12);
  assert.equal(findTicket(TICKETS, "a draft").ticket.key, "PVTI_4");
});

test("a ticket that isn't there, or a title two tickets share, says so", () => {
  assert.match(findTicket(TICKETS, "#99").error, /no ticket #99/);
  assert.match(findTicket(TICKETS, "nothing like it").error, /no ticket "nothing like it"/);
  assert.match(findTicket(TICKETS, "same name").error, /2 tickets.*#13, #14/);
  assert.match(findTicket(TICKETS, "").error, /Name a ticket/);
  assert.match(findTicket(null, "1").error, /no ticket #1/);
});

const WORKFLOWS = [{ id: "bug", name: "Bug" }, { id: "story", name: "Story" }, { id: "bug-kimi", name: "Bug (Kimi)" }];

test("a named thing is found by id first, then by name, ignoring case", () => {
  assert.equal(findNamed(WORKFLOWS, "BUG", "workflow").item.id, "bug");
  assert.equal(findNamed(WORKFLOWS, "bug (kimi)", "workflow").item.id, "bug-kimi");
  assert.equal(findNamed([{ key: "global:arch", id: "arch", name: "Architecture" }], "global:arch", "type").item.id, "arch");
  const missing = findNamed(WORKFLOWS, "chore", "workflow");
  assert.match(missing.error, /no workflow "chore"\. There are: Bug \(bug\), Story \(story\), Bug \(Kimi\) \(bug-kimi\)/);
  assert.match(findNamed([{ id: "a", name: "X" }, { id: "b", name: "x" }], "x", "workflow").error, /More than one/);
  assert.match(findNamed([], "x", "workflow").error, /^There is no workflow "x"\.$/);
});

test("the project is the one named, else the sidebar's pick, else there is none to use", () => {
  const projects = [{ id: "P1", title: "Roadmap" }, { id: "P2", title: "Bugs" }];
  assert.equal(pickProject(projects, null, projects[1]).project.id, "P2");
  assert.equal(pickProject(projects, "roadmap", projects[1]).project.id, "P1");
  assert.equal(pickProject(projects, "P2", projects[0]).project.id, "P2");
  assert.match(pickProject(projects, "Other", projects[0]).error, /no project linked to this repo "Other"/);
  assert.match(pickProject([], null, null).error, /project create/);
});
