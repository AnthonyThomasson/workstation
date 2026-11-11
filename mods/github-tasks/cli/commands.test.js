import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, GLOBAL_FLAGS, parseArgv, usage } from "./commands.js";
import { OPS } from "./protocol.js";

const parse = (line) => parseArgv(line);

test("every command sends an op the bridge knows, and every op has a command", () => {
  const ops = COMMANDS.filter((c) => c.words).map((c) => c.op);
  assert.deepEqual([...ops].sort(), [...OPS].sort());
});

test("no help, or help, prints every command; a command's --help prints its own", () => {
  for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
    const { help } = parse(argv);
    assert.match(help, /herdr-tasks: GitHub Tasks from the command line/, argv.join(" "));
    for (const c of COMMANDS.filter((x) => x.words)) assert.ok(help.includes(c.usage), c.usage);
  }
  assert.match(parse(["start", "--help"]).help, /^Usage: herdr-tasks start <ticket> \[--workflow <id\|name>\]/);
  assert.match(parse(["help", "merge"]).help, /^Usage: herdr-tasks merge <ticket> --yes[\s\S]*needs --yes/);
  assert.match(parse(["investigation", "done", "-h"]).help, /^Usage: herdr-tasks investigation done <id> --yes/);
});

test("a ticket command takes its ticket, and the global options anywhere", () => {
  const r = parse(["--cwd", "/repo", "start", "#12", "--workflow=bug", "--json", "--on", "vps", "--project", "Roadmap"]);
  assert.equal(r.op, "start");
  assert.deepEqual(r.args, { ticket: "#12", workflow: "bug" });
  assert.deepEqual(r.global, { cwd: "/repo", on: "vps", project: "Roadmap", json: true, timeout: 600 });
  assert.deepEqual(parse(["show", "12"]).global, { cwd: null, on: null, project: null, json: false, timeout: 120 });
  assert.equal(parse(["show", "12", "--timeout", "5"]).global.timeout, 5);
});

test("create takes repeated labels and a body or a body file, and needs a title", () => {
  const r = parse(["create", "--title", "Fix it", "--label", "bug", "--label=easy", "--body-file", "-", "--status", "Up Next"]);
  assert.deepEqual(r.args, { title: "Fix it", label: ["bug", "easy"], bodyFile: "-", status: "Up Next" });
  assert.deepEqual(parse(["create", "--title", "Draft", "--draft"]).args, { title: "Draft", draft: true });
  assert.match(parse(["create"]).error, /needs --title/);
  assert.match(parse(["create", "--title", "  "]).error, /needs --title/);
  assert.match(parse(["create", "--title", "x", "--body", "a", "--body-file", "f"]).error, /not both/);
  assert.match(parse(["create", "--title", "x", "--draft", "--label", "bug"]).error, /draft has no labels/);
});

test("edit needs something to change", () => {
  assert.deepEqual(parse(["edit", "12", "--add-label", "bug", "--remove-label", "easy", "--remove-label", "x"]).args, { ticket: "12", addLabel: ["bug"], removeLabel: ["easy", "x"] });
  assert.deepEqual(parse(["edit", "12", "--body", ""]).args, { ticket: "12", body: "" });
  assert.match(parse(["edit", "12"]).error, /Say what to change/);
});

test("move says where, one way", () => {
  assert.deepEqual(parse(["move", "12", "--to", "next"]).args, { ticket: "12", to: "next" });
  assert.deepEqual(parse(["move", "12", "--before", "#9"]).args, { ticket: "12", before: "#9" });
  assert.deepEqual(parse(["move", "12", "--to", "backlog", "--last"]).args, { ticket: "12", to: "backlog", last: true });
  assert.match(parse(["move", "12"]).error, /Say where/);
  assert.match(parse(["move", "12", "--to", "review"]).error, /next or backlog/);
  assert.match(parse(["move", "12", "--first", "--last"]).error, /one of/);
});

test("what can't be undone from here needs --yes", () => {
  for (const argv of [["wontdo", "12"], ["merge", "12"], ["investigation", "done", "inv-1"]]) {
    const r = parse(argv);
    assert.match(r.error, /add --yes/, argv.join(" "));
    assert.ok(r.command);
  }
  assert.deepEqual(parse(["merge", "12", "--yes"]).args, { ticket: "12" });
  assert.equal(parse(["investigation", "done", "inv-1", "--yes"]).op, "investigation-done");
  assert.match(parse(["show", "12", "--yes"]).error, /Unknown option --yes/);
});

test("two-word commands, and a first word alone says what may follow", () => {
  assert.deepEqual(parse(["project", "use", "Bugs"]), { command: COMMANDS.find((c) => c.op === "project-use"), op: "project-use", args: { project: "Bugs" }, global: { cwd: null, on: null, project: null, json: false, timeout: 120 } });
  assert.equal(parse(["project", "create"]).op, "project-create");
  assert.equal(parse(["investigation", "view", "inv-1"]).args.id, "inv-1");
  assert.match(parse(["project"]).error, /needs one of: use, create/);
  assert.match(parse(["investigation", "kill"]).error, /needs one of: view, done/);
});

test("new-task takes the rest of the words as its description, -- included", () => {
  assert.deepEqual(parse(["new-task", "Add", "dark", "mode"]).args, { description: "Add dark mode" });
  assert.deepEqual(parse(["new-task", "--", "--flags", "in", "text"]).args, { description: "--flags in text" });
  assert.match(parse(["new-task"]).error, /needs its description/);
  assert.equal(parse(["new-task", "x"]).global.timeout, 600);
});

test("refactor lists the types, or starts one with an optional focus", () => {
  assert.deepEqual(parse(["refactor"]).args, {});
  assert.deepEqual(parse(["refactor", "--type", "architecture", "--focus", "the run page"]).args, { type: "architecture", focus: "the run page" });
  assert.match(parse(["refactor", "--focus", "x"]).error, /needs --type/);
});

test("mistakes are usage errors that name the command", () => {
  assert.match(parse(["frobnicate"]).error, /Unknown command "frobnicate"/);
  assert.match(parse(["show"]).error, /show needs its ticket/);
  assert.match(parse(["show", "1", "2"]).error, /doesn't take "2"/);
  assert.match(parse(["show", "1", "--nope"]).error, /Unknown option --nope/);
  assert.match(parse(["list", "--json=yes"]).error, /takes no value/);
  assert.match(parse(["show", "1", "--cwd"]).error, /--cwd needs a value/);
  assert.match(parse(["list", "--section", "done"]).error, /--section is one of/);
  assert.match(parse(["list", "--timeout", "soon"]).error, /seconds/);
  assert.equal(parse(["show"]).command.op, "show");
});

test("the help names every global option", () => {
  const text = usage();
  for (const name of Object.keys(GLOBAL_FLAGS)) assert.ok(text.includes(`--${name}`), name);
  assert.match(text, /Exit codes: 0 done, 1 failed, 2 usage, 3 a choice is needed/);
});
