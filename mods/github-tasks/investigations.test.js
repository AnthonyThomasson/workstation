import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INVESTIGATION_HOST_LABEL, INVESTIGATION_LABEL, INVESTIGATIONS_KEY, beginInvestigation, checkStart, deleteBranch, endInvestigation, firstLine, investigationBranch,
  investigationHostName, investigationId, investigationLabel, investigationRow, investigationRunArgs, investigationsFor, liveInvestigations, reapplyInvestigations, removeWorktree,
  prototypesOf, refactorBranch, refactorHostName, refactorLabel, savedList, sessionFolder, tabNameFor, unsafeToRemove, withEntry, withoutEntry,
} from "./investigations.js";
import { hostKey, placeholderArgv, slotKey } from "./bgrun.js";
import { mainCheckout, prepareWorktree } from "./worktree.js";
import { shQuote, worktreePath } from "./run.js";
import { slug } from "./workflow-model.js";

// ---- Naming -------------------------------------------------------------------------------------------

test("the label is the first line of the description with text in it", () => {
  assert.equal(firstLine("\n  Fix the login redirect  \nIt lands on /404"), "Fix the login redirect");
  assert.equal(investigationLabel("Fix the login redirect\nmore", "o/app"), "Fix the login redirect");
  assert.equal(investigationLabel("  \n ", "o/app"), "New task app", "no description: named for the repo, as New Task always was");
  assert.equal(investigationLabel("", ""), "New task");
});

test("the tab's name is the label cut at 40 characters", () => {
  assert.equal(tabNameFor("short"), "short");
  const long = "Investigate why the sidebar flickers when a run ends";
  assert.equal(tabNameFor(long).length <= 40, true);
  assert.equal(tabNameFor(long), long.slice(0, 40).trimEnd());
});

test("the branch is investigate/ plus the slug of the first line (40 at most) and the time in base 36", () => {
  const now = Date.UTC(2026, 10, 9, 12, 0, 0);
  const t = now.toString(36);
  assert.equal(investigationBranch("Fix the login redirect!\nand more", now), `investigate/fix-the-login-redirect-${t}`);
  const text = "A very long first line that goes on and on and on past forty characters";
  assert.equal(investigationBranch(text, now), `investigate/${slug(text, 40)}-${t}`);
  assert.ok(slug(text, 40).length <= 40 && !slug(text, 40).endsWith("-"));
  assert.equal(investigationBranch("!!!", now), `investigate/investigation-${t}`, "a first line with no letters or digits");
  assert.notEqual(investigationBranch("same", 1), investigationBranch("same", 2), "two on one subject never share a branch");
});

test("the id is short and made of the time", () => {
  assert.equal(investigationId(36), "inv-10");
});

test("the agent runs in the background with no parent, labelled with its id, role and folder, and no pane labels", () => {
  const args = investigationRunArgs({ id: "inv-x", key: "ignored", workDir: "/w", argv: ["claude", "--effort", "medium"] });
  assert.deepEqual(args.slice(0, 6), ["run", "--bg", "--json", "--no-parent", "--cwd", "/w"]);
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["claude", "--effort", "medium"]);
  const labels = args.flatMap((a, i) => (args[i - 1] === "--label" ? [a] : []));
  assert.deepEqual(labels.sort(), ["herdr.investigation=inv-x", "herdr.role=investigation", "herdr.workflow.folder=/w"]);
  assert.ok(!labels.some((l) => l.startsWith("herdr.space") || l.startsWith("herdr.tab")), "those would adopt it into a pane");
});

test("#57 with a parent the agent outlives it, types no notes into it, and has no --no-parent; its labels stay the same", () => {
  const args = investigationRunArgs({ id: "inv-x", workDir: "/w", argv: ["claude"], parent: "tH" });
  assert.ok(!args.includes("--no-parent"));
  assert.equal(args[args.indexOf("--parent") + 1], "tH");
  assert.ok(args.includes("--outlive-parent") && args.includes("--no-notify"));
  assert.deepEqual(args.slice(0, 3), ["run", "--bg", "--json"]);
  assert.equal(args[args.indexOf("--cwd") + 1], "/w");
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["claude"]);
  const labels = args.flatMap((a, i) => (args[i - 1] === "--label" ? [a] : []));
  assert.deepEqual(labels.sort(), ["herdr.investigation=inv-x", "herdr.role=investigation", "herdr.workflow.folder=/w"]);
});

test("#57 the host tab is named for the first line of the description cut at 40, or New task", () => {
  assert.equal(investigationHostName("Fix the login redirect\nmore"), "Fix the login redirect agents");
  assert.equal(investigationHostName("  \n\n  Second line first"), "Second line first agents");
  assert.equal(investigationHostName(""), "New task agents");
  assert.equal(investigationHostName(undefined), "New task agents");
  const long = "Investigate why the sidebar flickers when a run ends";
  assert.equal(investigationHostName(long), `${long.slice(0, 40).trimEnd()} agents`);
});

test("#57 start with no description: the host is New task agents", async () => {
  const f = fakeStart();
  await beginInvestigation(f.deps, { ...ARGS, description: "" });
  assert.equal(f.hostCalls[0].name, "New task agents");
});

test("#57 the host carries its own label, never the agent's", () => {
  assert.equal(INVESTIGATION_HOST_LABEL, "herdr.investigation.host");
  assert.notEqual(INVESTIGATION_HOST_LABEL, INVESTIGATION_LABEL);
});

test("#57 the host's record is kept in the shared key bgrun keeps a run's in, per session", () => {
  assert.equal(hostKey("inv-1"), "github-tasks.host.inv-1");
});

test("the saved state has one shared key", () => {
  assert.equal(INVESTIGATIONS_KEY, "github-tasks.investigations");
});

// ---- Which sessions to keep ---------------------------------------------------------------------------

const E = (id, repoRoot, agent) => ({ id, label: id, repoRoot, repo: "app", branch: `investigate/${id}`, workDir: `/wt/${id}`, agent });
const live = (id, address, extra = {}) => ({ address, state: "live", labels: { [INVESTIGATION_LABEL]: id }, ...extra });

test("investigationsFor keeps this repo's sessions, ended ones too, with each agent's status", () => {
  const saved = [E("a", "/r1", "t1"), E("b", "/r1", "t2"), E("c", "/r2", "t3"), E("d", "/r1", "t4")];
  const terminals = [live("a", "t1", { status: "working" }), { address: "t2", state: "ended", labels: { [INVESTIGATION_LABEL]: "b" } }, live("c", "t3")]; // b ended, d is gone from the core
  const got = investigationsFor(saved, "/r1", terminals);
  assert.deepEqual(got.map((e) => [e.id, e.live, e.status]), [["a", true, "working"], ["b", false, "finished"], ["d", false, "finished"]]);
  assert.deepEqual(investigationsFor(saved, "/r2", terminals).map((e) => e.id), ["c"]);
  assert.deepEqual(investigationsFor(saved, "/elsewhere", terminals), []);
});

test("a live agent with no status yet shows as running; an agent's own entry fields are kept", () => {
  const got = investigationsFor([E("a", "/r", "t1")], "/r", [live("a", "t1")]);
  assert.equal(got[0].status, "unknown");
  assert.equal(got[0].label, "a");
  assert.equal(got[0].workDir, "/wt/a");
  assert.equal(investigationsFor([E("a", "/r", "t1")], "/r", [live("a", "t1", { status: { state: "blocked", msg: "?" } })])[0].status, "blocked");
});

test("only Done removes an entry: an agent that ended, was closed or is gone from the core keeps its row", () => {
  const saved = [E("a", "/r", "t1"), E("b", "/r", "t2")];
  assert.deepEqual(investigationsFor(saved, "/r", [live("a", "t1"), live("b", "t2")]).map((e) => e.live), [true, true]);
  assert.deepEqual(investigationsFor(saved, "/r", [live("a", "t1")]).map((e) => [e.id, e.live]), [["a", true], ["b", false]]);
  assert.deepEqual(investigationsFor(saved, "/r", []).map((e) => [e.id, e.live, e.status]), [["a", false, "finished"], ["b", false, "finished"]]);
});

test("a terminal that took over an address but isn't the investigation's agent counts as an ended agent, not as its status", () => {
  const saved = [E("a", "/r", "t1")];
  assert.deepEqual(investigationsFor(saved, "/r", [{ address: "t1", state: "live", status: "working", labels: { [INVESTIGATION_LABEL]: "other" } }]).map((e) => [e.live, e.status]), [[false, "finished"]]);
  assert.deepEqual(investigationsFor(saved, "/r", [{ address: "t1", state: "live", status: "working" }]).map((e) => [e.live, e.status]), [[false, "finished"]]);
});

test("#57 the host is not the agent: a session reports its agent's status, never its host's", () => {
  const host = { address: "tH", state: "live", status: "idle", labels: { [INVESTIGATION_HOST_LABEL]: "a", "herdr.role": "host" } };
  const saved = [E("a", "/r", "t1")];
  assert.deepEqual(investigationsFor(saved, "/r", [host, live("a", "t1", { status: "working" })]).map((e) => [e.live, e.status]), [[true, "working"]]);
  assert.deepEqual(investigationsFor(saved, "/r", [live("a", "t1", { status: "working" }), host]).map((e) => [e.live, e.status]), [[true, "working"]]);
  assert.deepEqual(investigationsFor(saved, "/r", [host]).map((e) => [e.live, e.status]), [[false, "finished"]], "a live host doesn't make an ended agent look alive");
  assert.deepEqual(liveInvestigations(saved, [host]), []);
  const ended = [{ address: "t1", state: "ended", labels: { [INVESTIGATION_LABEL]: "a" } }, host];
  assert.deepEqual(investigationsFor(saved, "/r", ended).map((e) => [e.live, e.status]), [[false, "finished"]], "an agent that ended on its own: finished, though its host lives on");
});

test("a session shows in any space of its repo: found by the main checkout, or by the repo's name for a GitHub repo", () => {
  const saved = [{ ...E("a", "/clone1", "t1"), repo: "o/app" }, { ...E("b", "/clone2", "t2"), repo: "o/other" }, { ...E("c", "/r3", "t3"), repo: "r3" }];
  const ts = [live("a", "t1"), live("b", "t2"), live("c", "t3")];
  assert.deepEqual(investigationsFor(saved, { repoRoot: "/clone1", repo: "o/app" }, ts).map((e) => e.id), ["a"]);
  assert.deepEqual(investigationsFor(saved, { repoRoot: "/elsewhere", repo: "o/app" }, ts).map((e) => e.id), ["a"], "another clone of the same GitHub repo");
  assert.deepEqual(investigationsFor(saved, { repoRoot: "/r3", repo: null }, ts).map((e) => e.id), ["c"], "local mode: by main checkout only");
  assert.deepEqual(investigationsFor(saved, { repoRoot: null, repo: null }, ts), [], "no place: nothing");
  assert.deepEqual(investigationsFor(saved, { repoRoot: "", repo: "" }, ts), []);
});

test("several sessions in one repo each keep their own entry, in the order they were saved", () => {
  const saved = [E("a", "/r", "t1"), E("b", "/r", "t2"), E("c", "/r", "t3")];
  const got = investigationsFor(saved, "/r", [live("c", "t3"), live("a", "t1"), live("b", "t2")]);
  assert.deepEqual(got.map((e) => e.id), ["a", "b", "c"]);
});

test("a row says the entry's first line, its status, whether it ended and what a click does", () => {
  const [on, off] = investigationsFor([{ ...E("a", "/r", "t1"), label: "Fix the login redirect" }, { ...E("b", "/r", "t2"), label: "  \nSecond line first" }], "/r", [live("a", "t1", { status: "working" })]);
  assert.deepEqual(investigationRow(on), { id: "a", text: "Fix the login redirect", status: "working", ended: false, tip: "Click to open this session." });
  const ended = investigationRow(off);
  assert.equal(ended.text, "Second line first");
  assert.equal(ended.ended, true);
  assert.equal(ended.status, "finished");
  assert.match(ended.tip, /ended.*Done/);
  assert.equal(investigationRow({ id: "x", label: "" }).text, "New task");
});

test("nothing saved, or something malformed saved, is no sessions", () => {
  assert.deepEqual(investigationsFor(undefined, "/r", []), []);
  assert.deepEqual(investigationsFor("nope", "/r", []), []);
  assert.deepEqual(savedList([null, 3, { id: "x" }, E("a", "/r", "t1")]).map((e) => e.id), ["a"]);
});

test("liveInvestigations is every repo's live sessions", () => {
  const saved = [E("a", "/r1", "t1"), E("c", "/r2", "t3"), E("z", "/r2", "t9")];
  assert.deepEqual(liveInvestigations(saved, [live("a", "t1"), live("c", "t3")]).map((e) => e.id), ["a", "c"]);
});

test("withEntry adds or replaces by id, withoutEntry removes", () => {
  const a = E("a", "/r", "t1"), b = E("b", "/r", "t2");
  assert.deepEqual(withEntry(undefined, a), [a]);
  assert.deepEqual(withEntry([a], b), [a, b]);
  assert.deepEqual(withEntry([a, b], { ...a, label: "renamed" }).map((e) => e.label), ["renamed", "b"]);
  assert.deepEqual(withoutEntry([a, b], "a"), [b]);
  assert.deepEqual(withoutEntry(undefined, "a"), []);
});

// ---- After an app restart -----------------------------------------------------------------------------

const SPACES = [{ id: "s1", tabs: [{ id: "tA" }] }, { id: "s2", tabs: [{ id: "tB" }] }];
const PANES = [{ pane: "pA", tab: "tA", terminal: "t8" }, { pane: "pP", tab: "tA", mod: "github-tasks" }, { pane: "pB", tab: "tB", terminal: "t9" }, { pane: "pQ", tab: "tB", mod: "github-tasks" }];

test("after a restart each live agent is shown again over the left pane of its own tab; ended ones and tab-less ones are left", async () => {
  const saved = [E("a", "/r", "t1"), E("b", "/r", "t2"), E("c", "/r", "t3")];
  const terminals = [live("a", "t1"), live("c", "t3")]; // b's agent is gone
  const slots = { a: { tab: "tA", left: "pA", space: "s1" }, b: { tab: "tB", left: "pB", space: "s2" }, c: null }; // c has no tab (it was closed)
  const shown = [];
  const n = await reapplyInvestigations({ saved, terminals, slot: (id) => slots[id], spaces: SPACES, panes: PANES, show: async (a) => { shown.push(a); } });
  assert.equal(n, 1);
  assert.deepEqual(shown, [{ terminal: "t1", pane: "pA" }]);
});

test("#57 after a restart only the agent is shown again; its host terminal (a tab's own, kept by the core) is left alone", async () => {
  const saved = [E("a", "/r", "t1")];
  const host = { address: "tH", state: "live", labels: { [INVESTIGATION_HOST_LABEL]: "a", "herdr.role": "host" } };
  const slots = { a: { tab: "tA", left: "pA", space: "s1" } };
  const shown = [];
  const n = await reapplyInvestigations({ saved, terminals: [host, live("a", "t1")], slot: (id) => slots[id], spaces: SPACES, panes: [...PANES, { pane: "pH", tab: "tH", terminal: "tH" }], show: async (a) => { shown.push(a); } });
  assert.equal(n, 1);
  assert.deepEqual(shown, [{ terminal: "t1", pane: "pA" }]);
});

test("one agent that can't be shown doesn't stop the rest", async () => {
  const saved = [E("a", "/r", "t1"), E("b", "/r", "t2")];
  const slots = { a: { tab: "tA", left: "pA", space: "s1" }, b: { tab: "tB", left: "pB", space: "s2" } };
  const n = await reapplyInvestigations({
    saved, terminals: [live("a", "t1"), live("b", "t2")], slot: (id) => slots[id], spaces: SPACES, panes: PANES,
    show: async (a) => { if (a.terminal === "t1") throw new Error("busy"); },
  });
  assert.equal(n, 1);
});

test("a run's tab finder and an investigation's placeholder agree: the placeholder says it is an investigation's", () => {
  assert.match(placeholderArgv("t7", "investigation")[2], /agent t7 of an investigation/);
  assert.match(placeholderArgv("t7")[2], /Task Orchestrator t7 of the run/, "a run's note is unchanged");
});

// ---- Starting ------------------------------------------------------------------------------------------

const AGENT = { key: "claude", run: ["claude"] };
const WHERE = { cwd: "/repo/app" };

test("a space on another machine, no folder, and no agent are refused, each with its message", () => {
  assert.throws(() => checkStart({ agent: AGENT, where: { cwd: "/x", on: "box" } }), /This space is on box\. Tasks' agents only start on this computer for now\./);
  assert.throws(() => checkStart({ agent: AGENT, where: {} }), /This space has no folder to work in\./);
  assert.throws(() => checkStart({ agent: AGENT, where: null }), /no folder/);
  assert.throws(() => checkStart({ agent: null, where: WHERE }), /Pick an agent that is installed on this computer\./);
  assert.throws(() => checkStart({ agent: { key: "x", run: [] }, where: WHERE }), /Pick an agent/);
  assert.doesNotThrow(() => checkStart({ agent: AGENT, where: WHERE }));
  assert.throws(() => checkStart({ agent: null, where: { cwd: "/x", on: "box" } }), /This space is on box/, "the remote space is said first, as before");
});

// A fake core that records what is done, in order.
function fakeStart({ run = { code: 0, stdout: '{"address":"t9"}', stderr: "" }, ready = { code: 0, stdout: '{"status":"idle"}', stderr: "" }, send = { code: 0, stdout: "", stderr: "" }, connect, task, mainCheckout, hostFails = null } = {}) {
  const log = [], hcCalls = [], hostCalls = [];
  let saved = [];
  const deps = {
    now: () => 1_000_000, home: "/home/me",
    mainCheckout: async (cwd) => { log.push(`mainCheckout ${cwd}`); if (mainCheckout) throw mainCheckout; return "/repo/app"; },
    prepareWorktree: async (repoRoot, branch, target) => { log.push(`worktree ${repoRoot} ${branch} ${target}`); return target; },
    worktreePath: (repoRoot, branch, home) => worktreePath(repoRoot, branch, home),
    task: async () => { log.push("task"); if (task) throw task; return "THE PROMPT"; },
    knownAgents: async () => [],
    writeSession: async (dir) => { log.push(`write session ${dir}`); },
    removeSession: async (dir) => { log.push(`remove session ${dir}`); },
    hc: async (a) => { hcCalls.push(a); log.push(`hc ${a[0]}`); return a[0] === "run" ? run : a[0] === "wait" ? ready : a[0] === "send" ? send : { code: 0, stdout: "", stderr: "" }; },
    connect: async (props) => { log.push("connect"); return connect ? connect(props) : { tab: "tX", left: "pX", space: "s1" }; },
    openHost: async (a) => { hostCalls.push(a); log.push("open host"); if (hostFails) throw hostFails; return { address: "tH", tab: "tHT", space: "sR", created: false }; },
    closeHost: async (h) => { log.push(`close host ${h?.address}`); },
    closeTab: () => log.push("close tab"),
    load: () => saved, save: (list) => { saved = list; log.push(`save ${list.map((e) => e.id).join(",")}`); },
    cleanup: async (repoRoot, branch, workDir) => { log.push(`cleanup ${repoRoot} ${branch} ${workDir}`); },
  };
  return { deps, log, hcCalls, hostCalls, saved: () => saved };
}
const ARGS = { agent: AGENT, description: "Fix the login redirect\nIt lands on /404", repo: "o/app", groomer: { effort: "high" }, where: WHERE };

test("start: the worktree is made from the main checkout, the entry saved once the agent exists, then the tab, then the prompt sent", async () => {
  const f = fakeStart();
  const { entry, problems } = await beginInvestigation(f.deps, ARGS);
  const t = (1_000_000).toString(36);
  const workDir = `/home/me/.herdr/worktrees/app/investigate-fix-the-login-redirect-${t}`;
  assert.deepEqual(f.log, [
    "mainCheckout /repo/app", "task", `worktree /repo/app investigate/fix-the-login-redirect-${t} ${workDir}`,
    `write session /home/me/.herdr/investigations/inv-${t}`, "open host", "hc run", `save inv-${t}`, "connect", "hc wait", "hc send",
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(entry, { id: `inv-${t}`, label: "Fix the login redirect", repoRoot: "/repo/app", repo: "o/app", branch: `investigate/fix-the-login-redirect-${t}`, workDir, agent: "t9" });
  assert.deepEqual(f.saved(), [entry]);
  assert.deepEqual(f.hcCalls.at(-1), ["send", "t9", "THE PROMPT"], "its first message is the prompt");
});

test("#57 start: the host opens first, for this session, its worktree and repo, and the agent starts under it", async () => {
  const f = fakeStart();
  await beginInvestigation(f.deps, ARGS);
  const id = `inv-${(1_000_000).toString(36)}`;
  const workDir = `/home/me/.herdr/worktrees/app/investigate-fix-the-login-redirect-${(1_000_000).toString(36)}`;
  assert.deepEqual(f.hostCalls, [{ id, name: "Fix the login redirect agents", label: "Fix the login redirect", workDir, repoRoot: "/repo/app" }]);
  const run = f.hcCalls[0];
  assert.equal(run[run.indexOf("--parent") + 1], "tH");
  assert.ok(run.includes("--outlive-parent") && run.includes("--no-notify") && !run.includes("--no-parent"));
  assert.deepEqual(run, investigationRunArgs({ id, workDir: run[run.indexOf("--cwd") + 1], argv: run.slice(run.indexOf("--") + 1), parent: "tH" }));
  assert.deepEqual(run.slice(run.indexOf("--") + 1, run.indexOf("--") + 4), ["claude", "--effort", "high"]);
});

test("#57 start: a host that won't open fails the start with the reason; no agent, tab or entry, and the worktree and branch go", async () => {
  const f = fakeStart({ hostFails: new Error("the host tab couldn't be made (no room)") });
  await assert.rejects(beginInvestigation(f.deps, ARGS), /The agent didn't start: its host tab didn't open \(the host tab couldn't be made \(no room\)\)/);
  assert.ok(!f.hcCalls.length, "no agent was started");
  assert.ok(!f.log.includes("connect") && !f.log.includes("close tab") && !f.log.some((l) => l.startsWith("close host")), "no tab, nothing else to close");
  assert.deepEqual(f.saved(), []);
  assert.equal(f.log.at(-1).startsWith("cleanup /repo/app investigate/"), true, "the worktree and branch made for it are taken back");
});

test("#57 start: whichever step fails later, the host is ended again (and the agent, tab, entry and worktree go as before)", async () => {
  for (const [over, message] of [
    [{ run: { code: 1, stdout: "", stderr: "no such program" } }, /The agent didn't start: no such program/],
    [{ ready: { code: 0, stdout: '{"reason":"exit","exit_code":1}', stderr: "" } }, /didn't start properly/],
    [{ send: { code: 1, stdout: "", stderr: "busy" } }, /didn't take its task/],
  ]) {
    const f = fakeStart(over);
    await assert.rejects(beginInvestigation(f.deps, ARGS), message);
    assert.equal(f.log.filter((l) => l === "close host tH").length, 1, message.source);
    assert.ok(f.log.indexOf("close host tH") > f.log.indexOf("open host"));
    assert.deepEqual(f.saved(), []);
    assert.equal(f.log.at(-1).startsWith("cleanup "), true);
  }
});

test("#57 start: a good start keeps its host; a tab that won't open is still only a problem to say", async () => {
  const f = fakeStart();
  await beginInvestigation(f.deps, ARGS);
  assert.ok(!f.log.some((l) => l.startsWith("close host")));
  const g = fakeStart({ connect: async () => { throw new Error("no room"); } });
  await beginInvestigation(g.deps, ARGS);
  assert.ok(!g.log.some((l) => l.startsWith("close host")));
});

test("start: the agent is the chosen one with the groomer's effort, in the worktree, labelled for the investigation", async () => {
  const f = fakeStart();
  await beginInvestigation(f.deps, ARGS);
  const run = f.hcCalls[0];
  const sessionFolder = `/home/me/.herdr/investigations/inv-${(1_000_000).toString(36)}`;
  assert.deepEqual(run.slice(run.indexOf("--") + 1).slice(0, 3), ["claude", "--effort", "high"]);
  assert.ok(run.includes("--add-dir") && run.includes(sessionFolder), "and the right to use the session's helpers (investigation-spawn.test.js)");
  assert.equal(run[run.indexOf("--cwd") + 1].startsWith("/home/me/.herdr/worktrees/app/investigate-"), true);
  assert.ok(run.includes(`${INVESTIGATION_LABEL}=inv-${(1_000_000).toString(36)}`));
});

test("start: the page and tab are told the label (its title), branch, folder and repo, and the agent's address", async () => {
  let seen;
  const f = fakeStart({ connect: async (p) => { seen = p; return { tab: "t", left: "l", space: "s" }; } });
  await beginInvestigation(f.deps, ARGS);
  assert.equal(seen.role, "investigation");
  assert.equal(seen.orchestrator, "t9");
  assert.equal(seen.title, "Fix the login redirect");
  assert.equal(seen.repoRoot, "/repo/app");
  assert.match(seen.branch, /^investigate\/fix-the-login-redirect-/);
  assert.match(seen.folder, /\/investigate-fix-the-login-redirect-/);
});

test("start from a ticket's worktree: the branch is cut in the repo's main checkout, not in the worktree", async () => {
  const f = fakeStart();
  await beginInvestigation(f.deps, { ...ARGS, where: { cwd: "/home/me/.herdr/worktrees/app/workflow-12-x" } });
  assert.equal(f.log[0], "mainCheckout /home/me/.herdr/worktrees/app/workflow-12-x");
  assert.match(f.log[2], /^worktree \/repo\/app investigate\//);
});

test("start with no description: named for the repo, and the branch has a plain name", async () => {
  const f = fakeStart();
  const { entry } = await beginInvestigation(f.deps, { ...ARGS, description: "" });
  assert.equal(entry.label, "New task app");
  assert.match(entry.branch, /^investigate\/investigation-/);
});

test("start: the errors come before anything is made", async () => {
  for (const [args, message] of [
    [{ ...ARGS, where: { cwd: "/x", on: "box" } }, /This space is on box/],
    [{ ...ARGS, where: {} }, /no folder/],
    [{ ...ARGS, agent: null }, /Pick an agent/],
  ]) {
    const f = fakeStart();
    await assert.rejects(beginInvestigation(f.deps, args), message);
    assert.deepEqual(f.log, [], "no git, no agent, no tab");
  }
});

test("start: a prompt that can't be made leaves nothing behind", async () => {
  const f = fakeStart({ task: new Error("no tasks folder") });
  await assert.rejects(beginInvestigation(f.deps, ARGS), /no tasks folder/);
  assert.deepEqual(f.log, ["mainCheckout /repo/app", "task"]);
});

test("start: not in a git repo is said, with nothing made", async () => {
  const f = fakeStart({ mainCheckout: new Error("/repo/app isn't in a git repo") });
  await assert.rejects(beginInvestigation(f.deps, ARGS), /isn't in a git repo/);
  assert.deepEqual(f.log, ["mainCheckout /repo/app"]);
});

test("start: an agent that doesn't start takes back the worktree and branch it made", async () => {
  const f = fakeStart({ run: { code: 1, stdout: "", stderr: "no such program" } });
  await assert.rejects(beginInvestigation(f.deps, ARGS), /The agent didn't start: no such program/);
  assert.equal(f.log.at(-1).startsWith("cleanup /repo/app investigate/"), true);
  assert.deepEqual(f.saved(), []);
});

test("start: an agent that ends while starting is killed, its tab closed, its entry forgotten and its worktree removed", async () => {
  const f = fakeStart({ ready: { code: 0, stdout: '{"reason":"exit","exit_code":1}', stderr: "" } });
  await assert.rejects(beginInvestigation(f.deps, ARGS), /The agent didn't start properly, so it was ended/);
  assert.ok(f.log.includes("close tab"));
  assert.ok(f.log.includes("hc kill"));
  assert.equal(f.log.at(-1).startsWith("cleanup "), true);
  assert.deepEqual(f.saved(), [], "the entry went with it");
});

test("start: a prompt the agent doesn't take ends it and undoes the lot", async () => {
  const f = fakeStart({ send: { code: 1, stdout: "", stderr: "busy" } });
  await assert.rejects(beginInvestigation(f.deps, ARGS), /didn't take its task.*busy/);
  assert.ok(f.log.includes("close tab"));
  assert.deepEqual(f.saved(), []);
  assert.equal(f.log.at(-1).startsWith("cleanup "), true);
});

test("start: a tab that won't open is a problem to say, not a failure: the agent goes on and the entry stays", async () => {
  const f = fakeStart({ connect: async () => { throw new Error("no room"); } });
  const { entry, problems } = await beginInvestigation(f.deps, ARGS);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Its tab didn't open: no room/);
  assert.deepEqual(f.saved(), [entry]);
  assert.ok(!f.log.some((l) => l.startsWith("cleanup")));
});

// ---- Done ----------------------------------------------------------------------------------------------

// A real repo with the investigation's branch and worktree; the core's side is faked.
const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@t"];
const git = async (cwd, ...args) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
async function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "inv-")));
  const repo = join(dir, "app");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, ...ident, "commit", "-q", "--allow-empty", "-m", "first");
  const branch = "investigate/fix-it-abc";
  const home = join(dir, "home");
  const workDir = await prepareWorktree(git, repo, branch, worktreePath(repo, branch, home));
  const folder = join(home, ".herdr", "investigations", "inv-1"); // the session folder: spawn script and prompts
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "spawn"), "#!/bin/sh\n");
  return { dir, repo, branch, workDir, home, folder };
}

// A prototype worker's own worktree and branch, as `spawn worker` makes them: `<workDir>--<job>` on `<branch>--<job>`.
const prototype = (s, job) => prepareWorktree(git, s.repo, `${s.branch}--${job}`, `${s.workDir}--${job}`);

// `terms`: the live terminals of the core besides the agent (which `stillLive` keeps live); `stuck`: addresses that survive a kill.
function fakeDone(s, { killed = { code: 0, stdout: "", stderr: "" }, stillLive = false, own = true, slot = { tab: "tA", left: "pA", space: "s1" }, terms = [], stuck = [] } = {}) {
  const log = [];
  let ended = [];
  let saved = [{ id: "inv-1", label: "Fix it", repoRoot: s.repo, repo: "app", branch: s.branch, workDir: s.workDir, agent: "t1" }, E("other", "/r", "t5")];
  const spaces = own ? [{ id: "s1", tabs: [{ id: "tA" }] }, { id: "s0", tabs: [{ id: "tZ" }] }] : [{ id: "s0", tabs: [{ id: "tZ" }, { id: "tA" }] }];
  const panes = [{ pane: "pA", tab: "tA", terminal: "t8", cwd: s.workDir }, { pane: "pP", tab: "tA", mod: "github-tasks" }, { pane: "pZ", tab: "tZ", terminal: "t3", cwd: s.repo }];
  const deps = {
    hc: async (a) => {
      log.push(`hc ${a.join(" ")}`);
      if (a[0] !== "kill") return { code: 0, stdout: "", stderr: "" };
      if (stuck.includes(a[1])) return { code: 1, stdout: "", stderr: "terminal busy" };
      if (a[1] !== "t1") ended.push(a[1]);
      return a[1] === "t1" ? killed : { code: 0, stdout: "", stderr: "" };
    },
    terminals: () => [...(stillLive ? [{ address: "t1", state: "live" }] : []), ...terms.filter((k) => !ended.includes(k.address))],
    home: s.home, removeDir: async (path) => { log.push(`rm ${path.replace(s.home, "<home>")}`); const r = spawnSync("rm", ["-rf", path]); return { code: r.status, stdout: "", stderr: String(r.stderr) }; },
    spaces: () => spaces, panes: () => panes, slot: () => slot,
    git: async (cwd, ...args) => { log.push(`git ${args.join(" ")}`.replace(s.workDir, "<wt>")); return git(cwd, ...args); },
    run: (name, args) => log.push(`${name} ${JSON.stringify(args)}`),
    load: () => saved, save: (list) => { saved = list; log.push("save"); }, clearSlot: () => log.push("clear slot"),
    host: () => null, clearHost: () => log.push("clear host"), clearAgents: () => log.push("clear agents"),
  };
  return { deps, log, saved: () => saved, terms };
}
const entryOf = (s) => ({ id: "inv-1", label: "Fix it", repoRoot: s.repo, repo: "app", branch: s.branch, workDir: s.workDir, agent: "t1" });

test("Done ends the agent, removes the worktree, deletes the branch, forgets the entry and closes the space, in that order", async () => {
  const s = await scratch();
  const f = fakeDone(s);
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.deepEqual(got, { done: true, error: null, closed: true });
  assert.deepEqual(f.log, [
    "git worktree list --porcelain", "git worktree list --porcelain", "git rev-parse --show-toplevel", "git for-each-ref --format=%(refname) refs/heads/",
    "hc kill t1", "hc rm t1", "clear host", "rm <home>/.herdr/investigations/inv-1", "git worktree remove --force <wt>", "git branch -D investigate/fix-it-abc", "save", "clear slot", "clear agents",
    'space.close {"id":"s1","confirmed":true}',
  ]);
  assert.equal(existsSync(s.folder), false, "the session folder is gone");
  assert.equal(existsSync(s.workDir), false, "the worktree is gone");
  assert.equal(sh(s.repo, "branch", "--list", s.branch), "", "the branch is gone");
  assert.deepEqual(f.saved().map((e) => e.id), ["other"], "only its own entry was removed");
  assert.equal(sh(s.repo, "worktree", "list", "--porcelain").includes(s.workDir), false);
});

const hostTerm = (id = "inv-1", address = "tH") => ({ address, state: "live", labels: { [INVESTIGATION_HOST_LABEL]: id, "herdr.role": "host" } });

test("#57 Done ends the agent, THEN its host and the host's tab, then the worktree, branch, entry, slot and space", async () => {
  const s = await scratch();
  const f = fakeDone(s, { terms: [hostTerm()] });
  f.deps.host = () => ({ tab: "tH", space: "s0", created: false });
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.deepEqual(got, { done: true, error: null, closed: true });
  const order = ["hc kill t1", "hc kill tH", 'tab.close {"id":"tH","confirmed":true}', "clear host", "git worktree remove --force <wt>", "git branch -D investigate/fix-it-abc", "save", "clear slot", 'space.close {"id":"s1","confirmed":true}'];
  assert.deepEqual(f.log.filter((l) => order.includes(l)), order);
  assert.equal(existsSync(s.workDir), false);
});

test("#57 a host that is already gone counts as done: nothing is killed for it and Done finishes", async () => {
  const s = await scratch();
  const f = fakeDone(s);
  f.deps.host = () => ({ tab: "tH", space: "s0", created: false }); // its record is still saved, the terminal is not
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
  assert.ok(!f.log.some((l) => l.includes("tH ") || l === "hc kill tH"));
  assert.ok(f.log.includes("clear host"), "the record is cleared on success");
});

test("#57 a host still live after its kill stops Done with the reason: nothing after it is done, and pressing Done again finishes", async () => {
  const s = await scratch();
  const stuck = fakeDone(s, { terms: [hostTerm()], stuck: ["tH"] });
  const got = await endInvestigation(stuck.deps, entryOf(s));
  assert.equal(got.done, false);
  assert.match(got.error, /host tH: terminal busy/);
  assert.ok(!stuck.log.some((l) => l.includes("worktree remove") || l.includes("branch -D") || l === "clear host" || l === "save" || l.startsWith("space.close")), "no worktree, branch, entry, slot or space; the record stays");
  assert.equal(existsSync(s.workDir), true);
  assert.equal(stuck.saved().some((e) => e.id === "inv-1"), true);
  const again = fakeDone(s, { terms: [hostTerm()] }); // Done again, the host now ends
  assert.equal((await endInvestigation(again.deps, entryOf(s))).done, true);
  assert.equal(existsSync(s.workDir), false);
});

test("#57 Done doesn't end another session's host, nor a ticket run's: only the host labelled for this session", async () => {
  const s = await scratch();
  const f = fakeDone(s, { terms: [hostTerm(), hostTerm("inv-other", "tO"), { address: "tR", state: "live", labels: { "herdr.workflow.host": "inv-1" } }] });
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
  assert.ok(f.log.includes("hc kill tH"));
  assert.ok(!f.log.some((l) => l.includes("tO") || l.includes("tR")));
});

test("#57 an agent that ended on its own leaves its host until Done is pressed", async () => {
  const s = await scratch();
  const f = fakeDone(s, { terms: [hostTerm()] });
  // nothing in Done runs on its own: the host is still listed live while the agent is gone
  assert.deepEqual(f.deps.terminals().map((k) => k.address), ["tH"]);
  assert.deepEqual(f.log, []);
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
  assert.ok(f.log.includes("hc kill tH"));
});

test("Done removes the worktree even with uncommitted changes in it", async () => {
  const s = await scratch();
  execFileSync("sh", ["-c", `echo hi > "${s.workDir}/new.txt"`]);
  sh(s.workDir, "add", "new.txt");
  const f = fakeDone(s);
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
  assert.equal(existsSync(s.workDir), false);
});

test("Done deletes the branch even when it has commits no other branch has", async () => {
  const s = await scratch();
  sh(s.workDir, ...ident, "commit", "-q", "--allow-empty", "-m", "an idea");
  const f = fakeDone(s);
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
  assert.equal(sh(s.repo, "branch", "--list", s.branch), "");
});

test("Done closes only the tab when the tab was moved to a space that isn't its own", async () => {
  const s = await scratch();
  const f = fakeDone(s, { own: false });
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.deepEqual(got, { done: true, error: null, closed: true });
  assert.equal(f.log.at(-1), 'tab.close {"id":"tA"}');
});

test("Done with no tab and no space found still finishes, and says nothing was closed", async () => {
  const s = await scratch();
  const f = fakeDone(s, { own: false, slot: null });
  f.deps.panes = () => [];
  f.deps.spaces = () => [];
  assert.deepEqual(await endInvestigation(f.deps, entryOf(s)), { done: true, error: null, closed: false });
  assert.ok(!f.log.some((l) => l.startsWith("tab.close") || l.startsWith("space.close")));
});

test("Done refuses an entry that isn't an investigation's: a branch outside investigate/, or the main checkout as the folder; nothing is touched", async () => {
  const s = await scratch();
  for (const bad of [{ branch: "main" }, { branch: "workflow/43-x" }, { branch: "" }, { branch: undefined }, { workDir: s.repo }, { workDir: `${s.repo}/` }, { workDir: "" }]) {
    const f = fakeDone(s);
    const got = await endInvestigation(f.deps, { ...entryOf(s), ...bad });
    assert.equal(got.done, false, JSON.stringify(bad));
    assert.match(got.error, /^Done refused: .*Nothing was ended or removed/, JSON.stringify(bad));
    assert.deepEqual(f.log.filter((l) => !l.startsWith("git worktree list") && !l.startsWith("git for-each-ref") && !l.startsWith("git rev-parse")), [], `nothing done for ${JSON.stringify(bad)}`);
  }
  assert.equal(existsSync(s.workDir), true, "the worktree is still there");
  assert.notEqual(sh(s.repo, "branch", "--list", s.branch), "", "the branch is still there");
});

test("Done refuses a folder that git says is the main checkout even when the entry's repoRoot is another path to it", async () => {
  const s = await scratch();
  const f = fakeDone(s);
  assert.match((await unsafeToRemove(f.deps.git, { repoRoot: s.workDir, workDir: s.repo, branch: s.branch })) ?? "", /main checkout/);
  assert.equal(await unsafeToRemove(f.deps.git, entryOf(s)), null, "a real investigation's entry is fine");
  const got = await endInvestigation(f.deps, { ...entryOf(s), repoRoot: s.workDir, workDir: s.repo });
  assert.equal(got.done, false);
  assert.equal(existsSync(s.repo), true);
});

test("Done stops when the agent can't be ended, before anything else is ended or removed: sub-agents, host, prototypes and the folder stay", async () => {
  const s = await scratch();
  await prototype(s, "api");
  const f = fakeDone(s, { killed: { code: 1, stdout: "", stderr: "terminal busy" }, stillLive: true, terms: [sub("t2")] });
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.equal(got.done, false);
  assert.equal(got.error, "Couldn't end the agent t1: terminal busy. Nothing else was removed; end it with hc kill, then press Done again.");
  assert.equal(f.log.at(-1), "hc kill t1", "the agent is the first thing ended, and nothing follows");
  assert.ok(!f.log.some((l) => l.startsWith("hc kill t2") || l.startsWith("rm ") || l.includes("remove") || l.includes("branch -D") || l === "clear host"));
  assert.equal(existsSync(s.workDir), true);
  assert.equal(existsSync(`${s.workDir}--api`), true);
  assert.equal(existsSync(s.folder), true);
  assert.equal(f.saved().some((e) => e.id === "inv-1"), true, "still tracked");
});

test("Done goes on when the agent's kill exits 0 even if terminals() still lists it live (it may not have refreshed), and stops when the kill fails and it is live", async () => {
  const s = await scratch();
  const f = fakeDone(s, { stillLive: true, terms: [sub("t2")] }); // kill answers code 0, the listing still says live
  assert.deepEqual(await endInvestigation(f.deps, entryOf(s)), { done: true, error: null, closed: true });
  assert.ok(f.log.includes("hc kill t2"), "the sub-agents were ended too");
  const t = await scratch();
  const g = fakeDone(t, { stillLive: true, killed: { code: 1, stdout: "", stderr: "terminal busy" } });
  assert.match((await endInvestigation(g.deps, entryOf(t))).error, /^Couldn't end the agent t1: terminal busy\./);
});

test("Done ends the New Task Orchestrator before it lists the sub-agents, so one started a moment before the agent died is found too", async () => {
  const s = await scratch();
  const f = fakeDone(s, { terms: [sub("t2")] });
  const hc = f.deps.hc;
  f.deps.hc = async (a) => { const r = await hc(a); if (a.join(" ") === "kill t1") f.terms.push(sub("t4", "worker")); return r; }; // spawned just before it ended
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
  assert.deepEqual(f.log.filter((l) => l.startsWith("hc kill")), ["hc kill t1", "hc kill t2", "hc kill t4"]);
});

test("Done on an agent that is already gone goes on: a failed kill of a terminal that isn't live is fine", async () => {
  const s = await scratch();
  const f = fakeDone(s, { killed: { code: 1, stdout: "", stderr: "no such terminal" } });
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
});

test("Done can be pressed again after the worktree went by hand: the branch is deleted and the rest finishes", async () => {
  const s = await scratch();
  execFileSync("rm", ["-rf", s.workDir]);
  const f = fakeDone(s);
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.equal(got.done, true);
  assert.equal(sh(s.repo, "branch", "--list", s.branch), "");
});

test("Done says why when the worktree can't be removed, and keeps the entry and the space for another try", async () => {
  const s = await scratch();
  const f = fakeDone(s);
  f.deps.git = async (cwd, ...args) => (args[0] === "worktree" && args[1] === "remove" ? { code: 128, stdout: "", stderr: "fatal: locked" } : git(cwd, ...args));
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.equal(got.done, false);
  assert.equal(got.error, `Couldn't remove the worktree ${s.workDir}: fatal: locked. The agent was ended; press Done again once that is fixed.`);
  assert.equal(f.saved().some((e) => e.id === "inv-1"), true);
  assert.ok(!f.log.some((l) => l.startsWith("space.close")));
});

test("Done says why when the branch can't be deleted", async () => {
  const s = await scratch();
  const f = fakeDone(s);
  f.deps.git = async (cwd, ...args) => (args[0] === "branch" ? { code: 1, stdout: "", stderr: "error: cannot delete" } : git(cwd, ...args));
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.equal(got.done, false);
  assert.equal(got.error, "Couldn't delete the branch investigate/fix-it-abc: error: cannot delete. The worktree was removed; press Done again once that is fixed.");
  assert.equal(f.saved().some((e) => e.id === "inv-1"), true);
});

// ---- Done discards everything the session started --------------------------------------------------------

const sub = (address, role = "investigator", id = "inv-1") => ({ address, state: "live", labels: { [INVESTIGATION_LABEL]: id, "herdr.role": role } });

test("Done also removes the terminals of sub-agents that already finished, and no one else's", async () => {
  const s = await scratch();
  const done = (address, id = "inv-1") => ({ address, state: "finished", labels: { [INVESTIGATION_LABEL]: id, "herdr.role": "worker" } });
  const f = fakeDone(s, { terms: [done("t6"), done("t8", "inv-other"), { address: "t7", state: "finished", labels: {} }] });
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
  assert.ok(f.log.includes("hc rm t6"));
  assert.ok(!f.log.some((l) => l.startsWith("hc kill t6")), "nothing to kill");
  assert.ok(!f.log.includes("hc rm t8") && !f.log.includes("hc rm t7"));
});

test("Done ends every sub-agent of the session (found by label, not parentage), but no other session's and not a terminal it doesn't own", async () => {
  const s = await scratch();
  const terms = [sub("t2"), sub("t3", "worker"), sub("t9", "worker", "inv-other"), { address: "t7", state: "live", labels: {} }, { address: "t6", state: "ended", labels: { [INVESTIGATION_LABEL]: "inv-1" } }];
  const f = fakeDone(s, { terms });
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
  const kills = f.log.filter((l) => l.startsWith("hc kill"));
  assert.deepEqual(kills, ["hc kill t1", "hc kill t2", "hc kill t3"], "the New Task Orchestrator first, so it can't start more");
  assert.deepEqual(f.log.filter((l) => l.startsWith("hc rm")), ["hc rm t1", "hc rm t2", "hc rm t3", "hc rm t6"], "and the finished sub-agent's terminal is removed too");
});

test("Done ends the sub-agents even when the New Task Orchestrator has already ended", async () => {
  const s = await scratch();
  const f = fakeDone(s, { terms: [sub("t2"), sub("t3", "worker")], killed: { code: 1, stdout: "", stderr: "no such terminal" } });
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.deepEqual(got, { done: true, error: null, closed: true });
  assert.ok(f.log.includes("hc kill t2") && f.log.includes("hc kill t3"));
  assert.deepEqual(f.deps.terminals(), []);
});

test("Done leaves the New Task Orchestrator's own terminal to its own step: it isn't counted among the sub-agents", async () => {
  const s = await scratch();
  const agent = { address: "t1", state: "live", labels: { [INVESTIGATION_LABEL]: "inv-1", "herdr.role": "investigation" } };
  const f = fakeDone(s, { terms: [agent, sub("t2")] });
  await endInvestigation(f.deps, entryOf(s));
  assert.equal(f.log.filter((l) => l === "hc kill t1").length, 1);
});

test("Done stops when a sub-agent won't die, naming it: nothing else is removed, and pressing again resumes", async () => {
  const s = await scratch();
  await prototype(s, "api");
  const f = fakeDone(s, { terms: [sub("t2"), sub("t3", "worker")], stuck: ["t3"] });
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.equal(got.done, false);
  assert.match(got.error, /Couldn't end t3: terminal busy/);
  assert.ok(f.log.includes("hc kill t2"), "the other one was still ended");
  assert.ok(f.log.indexOf("hc kill t1") < f.log.indexOf("hc kill t2"), "the agent was ended first");
  assert.ok(!f.log.some((l) => l.startsWith("rm ") || l.includes("remove") || l.includes("branch -D")));
  assert.equal(existsSync(`${s.workDir}--api`), true);
  assert.equal(existsSync(s.folder), true);
  assert.equal(f.saved().some((e) => e.id === "inv-1"), true);
  const again = fakeDone(s, { terms: [sub("t3", "worker")] }); // t3 died meanwhile; t2 is gone already
  assert.equal((await endInvestigation(again.deps, entryOf(s))).done, true);
  assert.equal(existsSync(`${s.workDir}--api`), false);
});

test("Done ends the session's host through endHost, and a host that is already gone is done", async () => {
  const s = await scratch();
  const host = { address: "th", state: "live", labels: { [INVESTIGATION_HOST_LABEL]: "inv-1", "herdr.role": "host" } };
  const f = fakeDone(s, { terms: [host, sub("t2")] });
  f.deps.panes = () => [{ pane: "pH", tab: "tH", terminal: "th" }, ...fakeDone(s).deps.panes()];
  f.deps.host = () => ({ tab: "tH", space: "s1", created: false });
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
  assert.ok(f.log.indexOf("hc kill t1") < f.log.indexOf("hc kill t2") && f.log.indexOf("hc kill t2") < f.log.indexOf("hc kill th"), "the agent, sub-agents, then the host");
  assert.ok(f.log.includes('tab.close {"id":"tH","confirmed":true}'), "the host's tab is closed");
  assert.ok(f.log.includes("clear host"));
  const none = fakeDone(s); // no host at all this time (and its folder already gone)
  assert.equal((await endInvestigation(none.deps, entryOf(s))).done, true);
});

test("#57 Done with the host alone in a space Start made for it (created: true): the host's tab goes, that space, and the session's own space last", async () => {
  const s = await scratch();
  const host = { address: "th", state: "live", labels: { [INVESTIGATION_HOST_LABEL]: "inv-1", "herdr.role": "host" } };
  const f = fakeDone(s, { terms: [host] });
  const base = fakeDone(s).deps;
  f.deps.spaces = () => [{ id: "sH", tabs: [{ id: "tH" }] }, { id: "s1", tabs: [{ id: "tA" }] }, { id: "s0", tabs: [{ id: "tZ" }] }];
  f.deps.panes = () => [{ pane: "pH", tab: "tH", terminal: "th", cwd: s.repo }, ...base.panes()];
  f.deps.host = () => ({ tab: "tH", space: "sH", created: true }); // what investigate.js saves under hostKey(<id>)
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.deepEqual([got.done, got.closed], [true, true]);
  const closes = f.log.filter((l) => l.startsWith("tab.close") || l.startsWith("space.close"));
  assert.deepEqual(closes, ['tab.close {"id":"tH","confirmed":true}', 'space.close {"id":"sH","confirmed":true}', 'space.close {"id":"s1","confirmed":true}']);
  assert.equal(f.log.at(-1), 'space.close {"id":"s1","confirmed":true}', "the session's space is the last step, found by its worktree, not by the host");
});

test("#57 Done never closes the repo's space the host sat in (created: false), and keeps a space Start made when something else is in it", async () => {
  const s = await scratch();
  const host = { address: "th", state: "live", labels: { [INVESTIGATION_HOST_LABEL]: "inv-1", "herdr.role": "host" } };
  const open = fakeDone(s, { terms: [host] });
  open.deps.spaces = () => [{ id: "s1", tabs: [{ id: "tA" }] }, { id: "sR", tabs: [{ id: "tR" }, { id: "tH" }] }];
  open.deps.host = () => ({ tab: "tH", space: "sR", created: false });
  await endInvestigation(open.deps, entryOf(s));
  assert.ok(!open.log.some((l) => l.startsWith("space.close") && l.includes("sR")), "the repo's space stays");
  const made = fakeDone(s, { terms: [host] });
  made.deps.spaces = () => [{ id: "s1", tabs: [{ id: "tA" }] }, { id: "sH", tabs: [{ id: "tH" }, { id: "tMine" }] }];
  made.deps.host = () => ({ tab: "tH", space: "sH", created: true });
  await endInvestigation(made.deps, entryOf(s));
  assert.ok(!made.log.some((l) => l.includes("sH") && l.startsWith("space.close")), "a space the person added a tab to is kept");
});

test("Done stops when the host won't die", async () => {
  const s = await scratch();
  const host = { address: "th", state: "live", labels: { [INVESTIGATION_HOST_LABEL]: "inv-1" } };
  const f = fakeDone(s, { terms: [host], stuck: ["th"] });
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.equal(got.done, false);
  assert.match(got.error, /host th: terminal busy/);
  assert.equal(existsSync(s.workDir), true);
  assert.ok(!f.log.includes("clear host"));
});

test("Done removes every prototype worktree and every <branch>--* branch, leaving the session's own worktree for its usual step", async () => {
  const s = await scratch();
  const api = await prototype(s, "api"), ui = await prototype(s, "ui");
  assert.equal(api, `${s.workDir}--api`);
  assert.equal(sh(s.repo, "branch", "--list", `${s.branch}--*`).split("\n").length, 2);
  sh(api, ...ident, "commit", "-q", "--allow-empty", "-m", "prototype work");
  execFileSync("sh", ["-c", `echo hi > "${ui}/new.txt"`]); // uncommitted work goes too
  const f = fakeDone(s);
  assert.deepEqual(await endInvestigation(f.deps, entryOf(s)), { done: true, error: null, closed: true });
  assert.equal(existsSync(api), false);
  assert.equal(existsSync(ui), false);
  assert.equal(sh(s.repo, "branch", "--list", "investigate/*"), "", "no investigate branch is left");
  assert.equal(sh(s.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "only the main checkout is left");
});

test("Done deletes a prototype branch whose worktree is already gone, and one that never had a worktree", async () => {
  const s = await scratch();
  await prototype(s, "api");
  execFileSync("rm", ["-rf", `${s.workDir}--api`]);
  sh(s.repo, "branch", `${s.branch}--lonely`);
  const f = fakeDone(s);
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
  assert.equal(sh(s.repo, "branch", "--list", "investigate/*"), "");
});

test("Done leaves other branches and worktrees alone: a lookalike branch, another session's prototypes, the main checkout", async () => {
  const s = await scratch();
  sh(s.repo, "branch", "investigate/fix-it-abcd"); // shares the text but not the `--`
  sh(s.repo, "branch", "feature/keep");
  sh(s.repo, "branch", "investigate/fix-it-abc-2"); // another session whose name starts like this one
  const other = await prepareWorktree(git, s.repo, "investigate/other-zzz--api", `${s.dir}/other--api`);
  const f = fakeDone(s);
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
  const left = sh(s.repo, "branch", "--format=%(refname:short)").split("\n").sort();
  assert.deepEqual(left, ["feature/keep", "investigate/fix-it-abc-2", "investigate/fix-it-abcd", "investigate/other-zzz--api", "main"]);
  assert.equal(existsSync(other), true);
  assert.equal(existsSync(s.repo), true);
  assert.equal(sh(s.repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the main checkout is untouched");
});

test("Done refuses a worktree in the session's prototype folders that isn't on one of its branches, and removes nothing", async () => {
  const s = await scratch();
  await prototype(s, "api");
  sh(s.repo, "branch", "feature/mine");
  sh(s.repo, "worktree", "add", "-q", `${s.workDir}--mine`, "feature/mine");
  const f = fakeDone(s, { terms: [sub("t2")] });
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.equal(got.done, false);
  assert.equal(got.error, `Done refused: the worktree ${s.workDir}--mine is on feature/mine, not one of this session's ${s.branch}--... branches. To fix it by hand, switch it to one (git -C ${shQuote(`${s.workDir}--mine`)} switch ${shQuote(`${s.branch}--mine`)}) or remove it yourself (git -C ${shQuote(s.repo)} worktree remove --force ${shQuote(`${s.workDir}--mine`)}), then press Done again. Nothing was ended or removed.`);
  assert.ok(!f.log.some((l) => l.startsWith("hc kill") || l.startsWith("rm ") || l.includes("remove") || l.includes("branch -D")), "nothing was touched");
  assert.equal(existsSync(`${s.workDir}--api`), true);
  assert.equal(existsSync(`${s.workDir}--mine`), true);
  assert.equal(existsSync(s.folder), true);
});

test("Done refuses a detached worktree in the prototype folders, saying how to fix it, and a main checkout there", async () => {
  const s = await scratch();
  const asList = (text) => async (cwd, ...args) => (args[0] === "worktree" && args[1] === "list" ? { code: 0, stdout: text, stderr: "" } : git(cwd, ...args));
  const detached = await prototypesOf(asList(`worktree ${s.repo}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${s.workDir}--x\nHEAD abc\ndetached\n`), entryOf(s));
  assert.equal(detached.refused, `the worktree ${s.workDir}--x is on no branch (detached), not one of this session's ${s.branch}--... branches. To fix it by hand, switch it to one (git -C ${shQuote(`${s.workDir}--x`)} switch ${shQuote(`${s.branch}--x`)}) or remove it yourself (git -C ${shQuote(s.repo)} worktree remove --force ${shQuote(`${s.workDir}--x`)}), then press Done again`);
  const main = await prototypesOf(asList(`worktree ${s.workDir}--x\nHEAD abc\nbranch refs/heads/main\n`), entryOf(s));
  assert.match(main.refused, /--x is the repo's main checkout/);
});

test("prototypesOf never matches anything for a branch that isn't an investigate/ one", async () => {
  const s = await scratch();
  const got = await prototypesOf(git, { ...entryOf(s), branch: "main" });
  assert.match(got.refused, /^the branch main isn't an investigation's/);
  assert.deepEqual([got.worktrees, got.branches], [[], []]);
});

test("prototype worktrees are found when the entry's folder is a symlink to the real one (git lists real paths)", async () => {
  const s = await scratch();
  await prototype(s, "api");
  const link = join(s.dir, "link");
  symlinkSync(s.workDir, link);
  const got = await prototypesOf(git, { ...entryOf(s), workDir: link });
  assert.equal(got.refused, null);
  assert.deepEqual(got.worktrees, [`${s.workDir}--api`]);
});

test("Done says why when a prototype worktree or branch can't be removed, keeps the rest for another try, and works again after", async () => {
  const s = await scratch();
  const api = await prototype(s, "api");
  const ui = await prototype(s, "ui");
  const f = fakeDone(s);
  const real = f.deps.git;
  f.deps.git = async (cwd, ...args) => (args[0] === "worktree" && args[1] === "remove" && args[3] === ui ? { code: 128, stdout: "", stderr: "fatal: locked" } : real(cwd, ...args));
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.equal(got.done, false);
  assert.equal(got.error, `Couldn't remove the worktree ${ui}: fatal: locked. The agent and its sub-agents were ended; press Done again once that is fixed.`);
  assert.equal(existsSync(api), false, "what came first is gone");
  assert.equal(existsSync(ui), true);
  assert.equal(existsSync(s.workDir), true, "the session's own worktree waits");
  assert.equal(existsSync(s.folder), true);
  assert.equal(f.saved().some((e) => e.id === "inv-1"), true);
  const again = fakeDone(s);
  assert.deepEqual(await endInvestigation(again.deps, entryOf(s)), { done: true, error: null, closed: true });
  assert.equal(sh(s.repo, "branch", "--list", "investigate/*"), "");
});

test("Done says why when a prototype branch can't be deleted", async () => {
  const s = await scratch();
  await prototype(s, "api");
  const f = fakeDone(s);
  const real = f.deps.git;
  f.deps.git = async (cwd, ...args) => (args[0] === "branch" && args[2] === `${s.branch}--api` ? { code: 1, stdout: "", stderr: "error: cannot delete" } : real(cwd, ...args));
  const got = await endInvestigation(f.deps, entryOf(s));
  assert.equal(got.done, false);
  assert.equal(got.error, "Couldn't delete the branch investigate/fix-it-abc--api: error: cannot delete. The agent, its sub-agents and the prototype worktrees are gone; press Done again once that is fixed.");
  assert.equal(existsSync(s.folder), true);
  assert.equal(existsSync(s.workDir), true);
});

test("Done removes the session folder, ~/.herdr/investigations/<id>/, with what is in it, and nothing outside it", async () => {
  const s = await scratch();
  writeFileSync(join(s.folder, "worker.md"), "x");
  const neighbour = join(s.home, ".herdr", "investigations", "inv-2");
  mkdirSync(neighbour, { recursive: true });
  const f = fakeDone(s);
  assert.equal((await endInvestigation(f.deps, entryOf(s))).done, true);
  assert.equal(existsSync(s.folder), false);
  assert.equal(existsSync(neighbour), true, "another session's folder is not touched");
  assert.equal(existsSync(s.home), true);
  assert.equal(sessionFolder("/h/", "inv-abc1"), "/h/.herdr/investigations/inv-abc1");
  for (const bad of ["", "..", "../x", "inv-", "inv-a/b", "inv-1/..", undefined, "x"]) assert.equal(sessionFolder("/h", bad), null, String(bad));
  assert.equal(sessionFolder("", "inv-1"), null);
});

test("Done with the session folder already gone goes on; one that can't be removed is said, with the rest kept for another try", async () => {
  const s = await scratch();
  execFileSync("rm", ["-rf", s.folder]);
  assert.equal((await endInvestigation(fakeDone(s).deps, entryOf(s))).done, true, "gone counts as done");
  const t = await scratch();
  await prototype(t, "api");
  const f = fakeDone(t);
  f.deps.removeDir = async () => ({ code: 1, stdout: "", stderr: "rm: permission denied" });
  const got = await endInvestigation(f.deps, entryOf(t));
  assert.equal(got.done, false);
  assert.match(got.error, /Couldn't remove the session folder .*inv-1: rm: permission denied/);
  assert.equal(existsSync(t.workDir), true, "the session's own worktree waits");
  assert.equal(f.saved().some((e) => e.id === "inv-1"), true);
  const bad = await endInvestigation(fakeDone(t).deps, { ...entryOf(t), id: "../../x" });
  assert.equal(bad.done, false);
  assert.match(bad.error, /^Done refused: .*Nothing was ended or removed/);
});

test("removeWorktree and deleteBranch treat what is already gone as done", async () => {
  const s = await scratch();
  assert.equal(await removeWorktree(git, s.repo, s.workDir), null);
  assert.equal(await removeWorktree(git, s.repo, s.workDir), null, "again: it is gone");
  assert.equal(await deleteBranch(git, s.repo, s.branch), null);
  assert.equal(await deleteBranch(git, s.repo, s.branch), null, "again: it is gone");
});

test("the real helpers work on a worktree started from a ticket's worktree (the main checkout is found)", async () => {
  const s = await scratch();
  assert.equal(await mainCheckout(git, s.workDir), s.repo);
});

test("slots are kept per investigation id, like a run's", () => {
  assert.equal(slotKey("inv-1"), "github-tasks.runtab.inv-1");
});

// ---- A refactor session --------------------------------------------------------------------------------

const RTYPE = {
  id: "isolation", name: "Isolation",
  orchestrator: { agent: "claude", command: "", model: "opus", effort: "high", prompt: "Find modules that reach into each other." },
  investigator: { agent: "codex", command: "", model: "gpt-x", effort: "low", prompt: "INV TYPE PROMPT" },
  worker: { agent: "custom", command: "my-worker --go", model: "", effort: "medium", prompt: "WORKER TYPE PROMPT" },
};

test("a refactor session's label is Refactor · <Name>, with the first line of the focus when given; the tab and the host cut it at 40", () => {
  assert.equal(refactorLabel(RTYPE, ""), "Refactor · Isolation");
  assert.equal(refactorLabel(RTYPE, "  \n the sidebar \nand more"), "Refactor · Isolation: the sidebar");
  const long = refactorLabel(RTYPE, "the sidebar and everything the popup reaches into");
  assert.equal(tabNameFor(long), long.slice(0, 40).trimEnd());
  assert.equal(refactorHostName(RTYPE, ""), "Refactor · Isolation agents");
  assert.equal(refactorHostName(RTYPE, "the sidebar and everything the popup reaches into"), `${long.slice(0, 40).trimEnd()} agents`);
});

test("a refactor session's branch is investigate/refactor-<type id cut to fit 40>-<base 36 time>", () => {
  const t = (1_000_000).toString(36);
  assert.equal(refactorBranch(RTYPE, 1_000_000), `investigate/refactor-isolation-${t}`);
  const id = "a-very-long-refactor-type-name-that-goes-on-and-on";
  const branch = refactorBranch({ ...RTYPE, id }, 1_000_000);
  assert.equal(branch, `investigate/${slug(`refactor-${id}`, 40)}-${t}`);
  assert.equal(branch.slice("investigate/".length, -(t.length + 1)).length <= 40, true);
  assert.ok(!branch.slice(0, -(t.length + 1)).endsWith("--"), "no doubled hyphen where the cut fell");
  assert.equal(refactorBranch({ ...RTYPE, id: "" }, 1_000_000), `investigate/refactor-isolation-${t}`, "no id yet: the name's slug");
  assert.ok(branch.startsWith("investigate/"), "Done accepts it");
});

test("a refactor session needs no agent chosen, but still a folder on this computer", () => {
  assert.doesNotThrow(() => checkStart({ agent: null, where: WHERE, refactor: { type: RTYPE, focus: "" } }));
  assert.throws(() => checkStart({ agent: null, where: { cwd: "/x", on: "box" }, refactor: {} }), /This space is on box/);
  assert.throws(() => checkStart({ agent: null, where: {}, refactor: {} }), /no folder/);
});

// What a refactor start did: the first run's command, what was written to the session folder, the host's name.
async function startRefactor(refactor, extra = {}) {
  const f = fakeStart();
  let files = null;
  f.deps.writeSession = async (dir, got) => { files = got; f.log.push("write session"); };
  f.deps.knownAgents = async () => [{ key: "claude", run: ["claude"], installed: true }, { key: "codex", run: ["codex"], installed: true }];
  f.deps.task = async (dir) => { f.log.push(`task ${dir}`); return "REFACTOR PROMPT"; };
  const out = await beginInvestigation(f.deps, { agent: null, description: "", repo: "o/app", where: WHERE, groomer: { model: "NEWTASK-MODEL" }, ...extra, refactor });
  return { ...out, f, files };
}

test("start a refactor: its names, the type's orchestrator as the agent, its roles' commands and prompts in the session folder", async () => {
  const { entry, f, files } = await startRefactor({ type: RTYPE, focus: "the sidebar" });
  const t = (1_000_000).toString(36);
  assert.equal(entry.label, "Refactor · Isolation: the sidebar");
  assert.equal(entry.branch, `investigate/refactor-isolation-${t}`);
  assert.equal(entry.workDir, `/home/me/.herdr/worktrees/app/investigate-refactor-isolation-${t}`);
  assert.deepEqual(f.hostCalls.map((h) => h.name), ["Refactor · Isolation: the sidebar agents"]);
  const run = f.hcCalls[0], argv = run.slice(run.indexOf("--") + 1);
  assert.deepEqual(argv.slice(0, 5), ["claude", "--model", "opus", "--effort", "high"], "the type's orchestrator, not the New Task settings");
  assert.ok(!argv.includes("NEWTASK-MODEL"));
  assert.ok(argv.includes("--add-dir") && argv.includes("--allowedTools"));
  assert.equal(f.hcCalls.at(-1)[2], "REFACTOR PROMPT");
  assert.ok(files.spawn.includes(shQuote("codex")) && files.spawn.includes("-m") && files.spawn.includes("model_reasoning_effort=low"), "investigators run the type's investigator");
  assert.ok(files.spawn.includes(shQuote("my-worker --go")) && !files.spawn.includes("--permission-mode"), "workers run the type's custom worker command");
  assert.ok(files["investigator.md"].endsWith("## This refactor's instructions\n\nINV TYPE PROMPT"));
  assert.ok(files["worker.md"].endsWith("## This refactor's instructions\n\nWORKER TYPE PROMPT"));
  assert.match(files["investigator.md"], /Refactor Orchestrator/);
  assert.match(files.spawn, /The Refactor Orchestrator that started you/);
});

test("start a refactor: the New Task sub-agent settings are not used, and the focus may be missing", async () => {
  const { entry, files } = await startRefactor({ type: RTYPE }, { subAgents: { investigator: { agent: "kimi", model: "k" }, worker: { agent: "kimi" } } });
  assert.equal(entry.label, "Refactor · Isolation");
  assert.ok(!files.spawn.includes("kimi"));
});

test("start a refactor: a type that can't run is refused with nothing made", async () => {
  const f = fakeStart();
  await assert.rejects(beginInvestigation(f.deps, { agent: null, description: "", where: WHERE, refactor: { type: { ...RTYPE, orchestrator: { ...RTYPE.orchestrator, prompt: "  " } }, focus: "" } }), /The Isolation refactor can't start: Give the refactor a prompt\./);
  assert.deepEqual(f.log, [], "not even the main checkout was looked at");
});

test("without a refactor the start is a New Task session as before", async () => {
  const f = fakeStart();
  const { entry } = await beginInvestigation(f.deps, { ...ARGS, refactor: null });
  assert.equal(entry.label, "Fix the login redirect");
  assert.ok(entry.branch.startsWith("investigate/fix-the-login-redirect-"));
});
