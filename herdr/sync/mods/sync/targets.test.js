// Targets: the rows built from skillshare's JSON, their states and wording, and the sync/diff commands
// against a fake machine. The JSON shapes follow real `skillshare diff|mcp list|plugin list|hooks list --json`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildItems, rowSub, detailLines, groupItems, needsSync, scopesToSync, hasDiff, diffArgs, noticeText, parseSnapshot, driftFrom,
  syncCommands, syncDone, failure, FIND_PROJECT, SNAPSHOT,
} from "./targets.js";
import { findProject, loadTargets, syncTargets, diffText, hasSkillshare } from "./targets-ops.js";

const list = [
  { name: "alpha", kind: "skill", relPath: "alpha" },
  { name: "beta", kind: "skill", relPath: "mine/beta" },
  { name: "gamma", kind: "skill", relPath: "gamma", disabled: true },
  { name: "helper.md", kind: "agent", relPath: "helper.md" },
  { name: "stable", kind: "skill", relPath: "stable" },
];
const diff = { targets: [
  { name: "claude", items: [
    { action: "add", name: "alpha", kind: "skill", reason: "new", is_sync: true },
    { action: "modify", name: "beta", kind: "skill", reason: "content changed", is_sync: true },
    { action: "remove", name: "stray", kind: "skill", reason: "local only", is_sync: false },
    { action: "add", name: "helper.md", kind: "agent", reason: "new", is_sync: true },
  ] },
  { name: "codex", items: [{ action: "add", name: "alpha", kind: "skill", reason: "new", is_sync: true }] },
] };

test("diff items become missing (add) and sync (modify) rows, with the reason and targets; local-only ones are ignored", () => {
  const items = buildItems("global", { list, diff });
  const by = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(by.alpha.state, "missing");
  assert.deepEqual(by.alpha.targets, ["claude", "codex"]);
  assert.equal(by.beta.state, "sync");
  assert.equal(by.beta.reason, "content changed");
  assert.equal(by.helper.state, "missing");
  assert.equal(by.helper.kind, "agents");
  assert.equal(by.gamma.state, "off");
  assert.equal(by.stable.state, "ok");
  assert.equal(by.stray, undefined);
});

test("a modify on any target outranks an add for the same item", () => {
  const d = driftFrom({ targets: [
    { name: "a", items: [{ action: "modify", name: "x", kind: "skill", reason: "r", is_sync: true }] },
    { name: "b", items: [{ action: "add", name: "x", kind: "skill", reason: "n", is_sync: true }] },
  ] });
  assert.equal(d.get("skills:x").action, "modify");
});

test("row sublines say not synced yet, the reason, or the source", () => {
  const by = Object.fromEntries(buildItems("global", { list, diff }).map((i) => [i.name, i]));
  assert.equal(rowSub(by.alpha, false), "not synced yet");
  assert.equal(rowSub(by.beta, true), "global · content changed");
  assert.equal(rowSub(by.gamma, false), "disabled");
  assert.equal(rowSub(by.stable, false), "local");
  assert.match(detailLines(by.alpha).join("\n"), /Not synced yet\. The next sync gives it to every target/);
  assert.match(detailLines(by.beta).join("\n"), /Changed since the last sync \(content changed\)\. The next sync updates your targets\./);
});

test("Diff is offered for changed or missing skills and agents only, with the right command", () => {
  const by = Object.fromEntries(buildItems("project", { list, diff }).map((i) => [i.name, i]));
  assert.ok(hasDiff(by.alpha) && hasDiff(by.beta) && hasDiff(by.helper));
  assert.ok(!hasDiff(by.stable) && !hasDiff(by.gamma));
  assert.deepEqual(diffArgs(by.beta), ["diff", "--stat", "--no-tui", "-p"]);
  assert.deepEqual(diffArgs(by.helper), ["diff", "agents", "--stat", "--no-tui", "-p"]);
});

test("MCP and plugins need sync when a change or a binding is pending", () => {
  const items = buildItems("global", {
    list: [],
    mcp: { changes: [{ target: "claude", name: "godot", action: "unchanged" }, { target: "codex", name: "godot", action: "add" }, { target: "claude", name: "fine", action: "unchanged" }] },
    plugins: { packages: { p1: { source: "https://github.com/x/p1.git", bindings: { claude: { pending: true }, codex: {} } }, p2: { bindings: {} }, p3: { bindings: { claude: {} } } } },
  });
  const by = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(by.godot.state, "sync");
  assert.equal(by.godot.reason, "codex: add");
  assert.equal(by.fine.state, "ok");
  assert.equal(by.p1.state, "sync");
  assert.equal(by.p1.reason, "pending in claude");
  assert.equal(by.p1.src, "github.com/x/p1");
  assert.equal(by.p2.state, "missing");
  assert.equal(by.p3.state, "ok");
  assert.equal(rowSub(by.godot, false), "changed since last sync");
});

test("hooks: a plan change makes the hook need sync, with change lines; no plan means sync status unknown", () => {
  const source = { entries: { lint: { enabled: true, bindings: { claude: {} } }, old: { enabled: false, bindings: {} } } };
  const plan = { changes: [{ target: "claude", name: "lint", action: "update", message: "command changed" }], warnings: [] };
  const items = buildItems("global", { list: [], hooks: { source, plan } });
  const by = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(by.lint.state, "sync");
  assert.equal(rowSub(by.lint, false), "claude: update · command changed");
  assert.equal(by.old.state, "off");
  assert.ok(detailLines(by.lint).includes("claude: update · command changed"));
  const unknown = buildItems("global", { list: [], hooks: { source } });
  assert.equal(unknown[0].state, "unknown");
  assert.equal(rowSub(unknown[0], false), "sync status unknown");
});

test("hook plan warnings and conflicts become Hook status notices; a blocker says Sync validates again", () => {
  const plan = { changes: [{ action: "conflict", message: "~/.claude/settings.json was edited", root: "" }, { action: "add", target: "codex" }], warnings: ["hooks.json is not trusted"] };
  const items = buildItems("global", { list: [], hooks: { source: { entries: {} }, plan } });
  const notices = items.filter((i) => i.notice);
  assert.equal(notices.length, 3);
  const blocker = notices.find((i) => i.blocker);
  assert.match(noticeText(blocker), /^global: conflict · ~\/\.claude\/settings\.json was edited Resolve with the CLI or dashboard; Sync validates again before applying changes\.$/);
  assert.ok(notices.some((i) => i.warnings?.[0] === "hooks.json is not trusted" && !i.blocker));
  assert.equal(groupItems(items).pendingNotices.length, 1, "the add with no name is a native hook file that needs sync");
  assert.equal(needsSync(items), 1);
});

test("a hooks error with a readable list is a notice, not a pending sync", () => {
  const items = buildItems("global", { list: [], hooks: { error: "hooks failed to load" } });
  assert.equal(items.length, 1);
  assert.equal(items[0].blocker, true);
  assert.equal(items[0].state, "unknown");
  assert.equal(needsSync(items), 0);
});

test("needsSync counts changed rows and pending native hook files; scopesToSync names the scopes with work", () => {
  const g = buildItems("global", { list, diff });
  const p = buildItems("project", { list: [{ name: "q", kind: "skill", relPath: "q" }], diff: { targets: [] } });
  assert.equal(needsSync(g), 3);
  assert.deepEqual(scopesToSync([...g, ...p], "/proj"), ["global"]);
  assert.deepEqual(scopesToSync(p, "/proj"), ["project", "global"]);
  assert.deepEqual(scopesToSync([], null), ["global"]);
});

test("snapshots parse by section; sync commands and the done text", () => {
  const s = parseSnapshot('@@list 1\n[{"name":"a"}]\n@@diff 0\n{"targets":[]}\n@@mcp 0\n\n');
  assert.deepEqual(s.list, [{ name: "a" }]);
  assert.deepEqual(s.diff, { targets: [] });
  assert.equal(s.mcp, null);
  assert.equal(s.took.list, 1);
  assert.deepEqual(syncCommands("project"), [["sync", "--all", "--json", "-p"], ["sync", "plugins", "--json", "-p"]]);
  assert.deepEqual(syncCommands("global", false), [["sync", "--all", "--json", "-g"]]);
  assert.equal(syncDone(["project", "global"]), "Synced project and global");
  assert.equal(syncDone(["global"]), "Synced global");
  assert.equal(failure({ code: 2, stdout: '{"error":"bad config"}' }, "x"), "bad config");
  assert.equal(failure({ code: 2, stdout: "", stderr: "a\nb\n" }, "x"), "b");
});

// A fake machine: records every command, answers from a table.
const machine = (answers = {}) => {
  const calls = [];
  const ans = (key, args) => answers[key]?.(args) ?? { code: 0, stdout: "", stderr: "" };
  return {
    calls,
    sh: async (script, args, on) => { calls.push({ kind: "sh", script, args, on }); return ans(script === FIND_PROJECT ? "project" : "sh", args); },
    run: async (args, o) => { calls.push({ kind: "run", args, ...o }); return ans("run", args); },
    job: async (args, o) => { calls.push({ kind: "job", args, ...o }); return ans(o.script === SNAPSHOT ? "snapshot" : "job", args); },
  };
};

test("findProject and hasSkillshare read the machine", async () => {
  const m = machine({ project: () => ({ code: 0, stdout: "/p\n" }), sh: () => ({ code: 1, stdout: "" }) });
  assert.equal(await findProject(m, "box", ["", "/p"]), "/p");
  assert.deepEqual(m.calls[0].args, ["", "/p"]);
  assert.equal(await hasSkillshare(m, null), false);
});

test("loadTargets reads each scope in the project folder and global, and reports an unreadable one", async () => {
  const m = machine({ snapshot: (args) => ({ code: 0, stdout: args[1] === "-p" ? "garbage" : `@@list 0\n${JSON.stringify(list)}\n@@diff 0\n${JSON.stringify(diff)}\n` }) });
  const r = await loadTargets(m, "box", "/proj");
  assert.deepEqual(m.calls.map((c) => [c.args, c.on]).sort(), [[["", "-g"], "box"], [["/proj", "-p"], "box"]].sort());
  assert.equal(r.items.filter((i) => i.scope === "global").length, 5);
  assert.ok(r.raw.project.error);
  assert.equal(r.error, r.raw.project.error);
});

test("syncTargets runs sync --all then sync plugins for each scope, in the scope's folder, and stops at a failure", async () => {
  const m = machine();
  const steps = [];
  const r = await syncTargets(m, { on: null, project: "/proj", scopes: ["project", "global"], step: (s) => steps.push(s) });
  assert.deepEqual(r, { kind: "done", text: "Synced project and global" });
  assert.deepEqual(m.calls.map((c) => [c.args.join(" "), c.cwd]), [
    ["sync --all --json -p", "/proj"], ["sync plugins --json -p", "/proj"], ["sync --all --json -g", null], ["sync plugins --json -g", null],
  ]);
  assert.deepEqual(steps, ["Syncing project…", "Syncing global…"]);
  const bad = machine({ job: (args) => (args[1] === "plugins" ? { code: 1, stdout: '{"error":"plugin x failed"}' } : { code: 0, stdout: "" }) });
  assert.deepEqual(await syncTargets(bad, { scopes: ["global", "project"], project: "/proj" }), { kind: "error", text: "plugin x failed" });
  assert.equal(bad.calls.length, 2, "nothing runs after the failure");
});

test("diffText runs skillshare diff for the item's kind and scope and strips colour codes", async () => {
  const m = machine({ run: () => ({ code: 0, stdout: "\x1b[32mclaude\x1b[0m\n  + beta\n" }) });
  const item = buildItems("project", { list, diff }).find((i) => i.name === "helper");
  const r = await diffText(m, item, { on: "box", project: "/proj" });
  assert.deepEqual(m.calls[0].args, ["diff", "agents", "--stat", "--no-tui", "-p"]);
  assert.equal(m.calls[0].cwd, "/proj");
  assert.equal(m.calls[0].on, "box");
  assert.equal(r.title, "What sync would change (project)");
  assert.equal(r.text, "claude\n  + beta\n");
});
