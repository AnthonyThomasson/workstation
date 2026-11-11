import test from "node:test";
import assert from "node:assert/strict";
import { formatReply, mergeText, ticketRow } from "./format.js";
import { OPS, failReply, okReply } from "./protocol.js";

const ok = (op, data) => formatReply(op, okReply("a-b", data));
const TICKET = { key: "PVTI_1", number: 12, title: "Fix login", status: "Up Next", state: "OPEN", labels: ["bug"], draft: false, url: "https://github.com/me/app/issues/12" };

test("a ticket's row: its number (or draft), title, labels and its run", () => {
  assert.equal(ticketRow({ ...TICKET, run: null }), "#12    Fix login  [bug]");
  assert.equal(ticketRow({ title: "Idea", draft: true, labels: [] }), "draft  Idea");
  assert.equal(ticketRow({ ...TICKET, labels: [], run: { status: "blocked", waiting: 2 } }), "#12    Fix login  ▶ needs you (2 waiting for you)");
});

test("list prints the board and each section, empty ones too", () => {
  const text = ok("list", {
    repo: "me/app", project: { title: "Roadmap" }, truncated: false,
    sections: [
      { id: "investigations", label: "Investigations", items: [{ id: "inv-1", label: "Dark mode", status: "working", ended: false, waiting: 0 }] },
      { id: "next", label: "Up Next", items: [{ ...TICKET, run: { status: "working", waiting: 0 } }] },
      { id: "backlog", label: "Backlog", items: [] },
    ],
  });
  assert.equal(text, ["me/app · Roadmap", "", "Investigations · 1", "  inv-1  Dark mode  · working", "", "Up Next · 1", "  #12    Fix login  [bug]  ▶ working", "", "Backlog · 0", "  (nothing)"].join("\n"));
});

test("show prints the ticket, what Start would run, its run and its description", () => {
  const text = ok("show", {
    ticket: { ...TICKET, body: "It breaks.\n" },
    workflows: [{ id: "bug", name: "Bug" }],
    run: {
      id: "12-x", workflow: "Bug", branch: "workflow/12-fix-login", folder: "/wt", orchestrator: "t4", live: true, status: "working",
      agents: { workers: [{ name: "fix", status: "working", live: true, address: "t5", detail: null }], reviewers: [], investigators: [] },
      pr: null, merge: { mode: "hidden", label: "", enabled: false, wait: "Merge appears once the final review has started and every agent has ended." },
    },
  });
  assert.match(text, /^#12 Fix login\nStatus: Up Next\nLabels: bug\nhttps:\/\/github.com\/me\/app\/issues\/12\nStart would run: Bug \(bug\)\n/);
  assert.match(text, /Run 12-x · Bug · workflow\/12-fix-login\n {2}Task Orchestrator: working \(t4\)\n {2}Worktree: \/wt\n {2}Workers:\n {4}fix · working \(t5\)\n {2}Merge: Merge appears once/);
  assert.match(text, /\n\nIt breaks\.$/);
  assert.match(ok("show", { ticket: { ...TICKET, body: "" }, workflows: [], run: null }), /No workflow matches its labels[\s\S]*\(no description\)$/);
});

test("the Merge button in words", () => {
  assert.equal(mergeText({ mode: "normal", enabled: true, label: "Merge" }), "ready (merge --yes)");
  assert.equal(mergeText({ mode: "normal", enabled: false, label: "Merging…" }), "Merging…");
  assert.equal(mergeText({ mode: "hidden", wait: "later" }), "later");
  assert.match(mergeText({ mode: "red", label: "Fix conflicts", error: "conflicts" }), /failed: conflicts \(merge --yes hands it to the Task Orchestrator: Fix conflicts\)/);
  assert.match(mergeText({ mode: "fixing", note: "on it" }), /waiting for the Task Orchestrator to fix it: on it/);
});

test("a failure prints the error, and the choices when one is needed", () => {
  assert.equal(formatReply("show", failReply("a-b", "No such ticket.")), "herdr-tasks: No such ticket.");
  const text = formatReply("start", failReply("a-b", "2 workflows match", { code: "choose", data: { choices: [{ id: "bug", name: "Bug", scope: "global" }, { id: "story", name: "Story", scope: "repo" }] } }));
  assert.equal(text, ["herdr-tasks: 2 workflows match", "  bug                  Bug  · global", "  story                Story  · repo"].join("\n"));
});

test("every op has words of its own", () => {
  const samples = {
    create: { ticket: TICKET }, edit: { ticket: TICKET, changed: [] }, move: { ticket: TICKET, moved: false }, wontdo: { ticket: TICKET }, open: { ticket: TICKET },
    start: { ticket: TICKET, resumed: false, workflow: "Bug", run: { id: "12-x", orchestrator: "t4" } }, view: { ticket: TICKET }, runs: { runs: [] },
    merge: { outcome: "merged", pr: { url: "u" } }, "new-task": { investigation: { id: "inv-1", label: "x", branch: "b" } }, refactor: { types: [] },
    investigations: { investigations: [] }, "investigation-view": { investigation: { label: "x" } }, "investigation-done": { investigation: { label: "x" } },
    projects: { repo: "me/app", projects: [] }, "project-use": { repo: "me/app", project: { title: "R" } }, "project-create": { project: { title: "R", url: "u" }, note: null },
    workflows: { kind: "workflow", items: [], errors: [] }, doctor: { found: false, issues: [] }, refresh: {},
  };
  for (const op of OPS.filter((o) => o !== "list" && o !== "show")) {
    const text = ok(op, samples[op]);
    assert.equal(typeof text, "string", op);
    assert.ok(text.length && !text.startsWith("{"), `${op}: ${text}`);
  }
  assert.equal(ok("start", samples.start), "Started Bug on #12: run 12-x, Task Orchestrator t4.");
  assert.equal(ok("start", { ...samples.start, resumed: true }), "#12 is already running: its tab is in front.");
  assert.equal(ok("edit", { ticket: TICKET, changed: ["title", "labels"] }), "Saved #12: title, labels.");
  assert.equal(ok("workflows", { kind: "workflow", items: [{ id: "bug", name: "Bug", scope: "global", trigger: "Any of: bug" }], errors: ["x.yaml: bad"] }), "bug                  Bug  · global  · Any of: bug\n! can't read x.yaml: bad");
  assert.equal(ok("doctor", { found: true, issues: [{ message: "gh isn't signed in." }], place: { cwd: "/repo" } }), "! gh isn't signed in.\n(for /repo, the folder the Tasks sidebar shows)");
});
