import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NEW_TASK_PLUMBING, investigationSpawnScript, newTaskAgentArgv, newTaskInvestigatorPrompt, newTaskWorkerPrompt, refactorAgentArgv, sessionFiles, subAgentArgv,
} from "./investigation-spawn.js";
import { beginInvestigation, investigationRunArgs } from "./investigations.js";
import { shQuote } from "../runs/index.js";
import { worktreePath } from "../workflow/index.js";
import { newTaskPrompt, refactorPrompt, ASK_WITH_TOOL, hostKey } from "../lib/index.js";

const DIR = "/home/me/.herdr/investigations/inv-x";
// The values of a flag that takes any number of them, up to the next flag.
const values = (argv, flag) => {
  const from = argv.indexOf(flag) + 1;
  const to = argv.findIndex((a, i) => i >= from && a.startsWith("--"));
  return argv.slice(from, to === -1 ? undefined : to);
};

// ---- The sub-agents' commands ------------------------------------------------------------------------

const settings = (extra = {}) => ({ agent: "claude", model: "", effort: "medium", ...extra });

test("an investigator runs read-only with the investigator settings: the folder to read, hc send and read-only git, no edit tools", () => {
  const argv = subAgentArgv("investigator", settings({ model: "opus", effort: "high" }), [{ key: "claude", run: ["claude"], installed: true }], DIR);
  assert.equal(argv[0], "claude");
  assert.deepEqual(values(argv, "--add-dir"), [DIR]);
  assert.ok(values(argv, "--allowedTools").includes("Bash(hc send:*)"));
  assert.ok(values(argv, "--allowedTools").includes("Bash(git diff:*)"));
  assert.deepEqual(values(argv, "--disallowedTools"), ["Edit,Write,NotebookEdit,MultiEdit"]);
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "auto");
  assert.equal(argv[argv.indexOf("--model") + 1], "opus");
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
});

test("a prototype worker runs in auto mode with the worker settings, hc send and the session folder, and may edit", () => {
  const argv = subAgentArgv("worker", settings({ effort: "low" }), [{ key: "claude", run: ["claude"], installed: true }], DIR);
  assert.deepEqual(argv, ["claude", "--add-dir", DIR, "--allowedTools", "Bash(hc send:*)", "--permission-mode", "auto", "--effort", "low"]);
  assert.ok(!argv.includes("--disallowedTools"));
  assert.ok(!argv.includes("--model"), "the agent's own default model: no flag");
});

test("the sub-agents' agent comes from their own settings: a codex worker, an agent the core doesn't list", () => {
  const known = [{ key: "codex", run: ["codex", "--x"], installed: true }];
  assert.deepEqual(subAgentArgv("worker", settings({ agent: "codex", model: "gpt-x", effort: "low" }), known, DIR), ["codex", "--x", "-m", "gpt-x", "-c", "model_reasoning_effort=low"]);
  assert.equal(subAgentArgv("investigator", settings({ agent: "claude" }), [], DIR)[0], "claude", "no entry: the agent's key is its command");
  assert.equal(subAgentArgv("worker", settings({ agent: "claude" }), undefined, DIR)[0], "claude");
});

test("the New Task Orchestrator, when it is Claude, may run the spawn script and hc send, read, wait, ls and kill, and may read the session folder; it keeps edit tools", () => {
  const argv = newTaskAgentArgv({ key: "claude", run: ["claude"] }, { model: "opus", effort: "high" }, DIR);
  assert.deepEqual(argv.slice(0, 5), ["claude", "--model", "opus", "--effort", "high"], "the groomer's own flags come first, as before");
  assert.deepEqual(values(argv, "--add-dir"), [DIR]);
  assert.deepEqual(values(argv, "--allowedTools"), [`Bash(${DIR}/spawn:*)`, "Bash(hc send:*)", "Bash(hc read:*)", "Bash(hc wait:*)", "Bash(hc ls:*)", "Bash(hc kill:*)"]);
  assert.deepEqual(NEW_TASK_PLUMBING(DIR), values(argv, "--allowedTools"));
  assert.ok(!argv.includes("--disallowedTools") && !argv.includes("--permission-mode"), "nothing else is restricted or changed");
  assert.ok(!argv.some((a) => /^Bash\(hc:\*\)$|Bash\(\*\)/.test(a)), "bare hc would run anything");
});

test("the New Task Orchestrator keeps its command when it is not Claude, and with no directory", () => {
  assert.deepEqual(newTaskAgentArgv({ key: "codex", run: ["codex"] }, { model: "m", effort: "low" }, DIR), ["codex", "-m", "m", "-c", "model_reasoning_effort=low"]);
  assert.deepEqual(newTaskAgentArgv({ key: "kimi", run: ["kimi"] }, { model: "k" }, DIR), ["kimi", "--model", "k"]);
  assert.deepEqual(newTaskAgentArgv({ key: "claude", run: ["claude"] }, {}, null), ["claude", "--effort", "medium"]);
});

// ---- The prompts -------------------------------------------------------------------------------------

const P = { workDir: "/wt/investigate-x", repoRoot: "/src/app", branch: "investigate/x" };
const bodyOf = (text) => text.split("\n\n")[1];

test("each sub-agent prompt is a header, a body of exactly three sentences, then a bulleted list", () => {
  for (const [name, text] of [["investigator", newTaskInvestigatorPrompt(P)], ["worker", newTaskWorkerPrompt(P)]]) {
    const [header, body, bullets] = text.split("\n\n");
    assert.match(header, new RegExp(`^# You are an? ${name === "worker" ? "prototype worker" : "investigator"}`), name);
    assert.equal(body.match(/[.!?](\s|$)/g).length, 3, `${name} body must be three sentences: ${body}`);
    assert.ok(bullets.split("\n").every((l) => l.startsWith("- ")), name);
  }
});

test("the investigator is read-only, explores the session worktree, reports with hc send, and never pushes, merges or opens a pull request", () => {
  const text = newTaskInvestigatorPrompt(P);
  assert.match(bodyOf(text), /read-only: edit nothing, commit nothing/);
  assert.match(bodyOf(text), /hc send/);
  assert.match(bodyOf(text), /New Task Orchestrator's brief/);
  assert.ok(text.includes("/wt/investigate-x") && text.includes("investigate/x"));
  assert.ok(text.includes("`git show <commit>:<path>`"));
  assert.match(text, /Never push, merge or open a pull request/);
  assert.ok(text.includes("main checkout /src/app"));
  assert.match(text, /don't start other agents/);
});

test("the prototype worker builds a throwaway in its own worktree, commits there, reports with hc send; its code is discarded and never the ticket's", () => {
  const text = newTaskWorkerPrompt(P);
  assert.match(bodyOf(text), /throwaway prototype/);
  assert.match(bodyOf(text), /commit/i);
  assert.match(bodyOf(text), /hc send/);
  assert.match(bodyOf(text), /never push, merge or open a pull request/);
  assert.doesNotMatch(text, /<job>/, "no placeholder for the agent to take literally");
  assert.match(text, /You start in your own worktree/);
  assert.ok(text.includes("begins with /wt/investigate-x)") && text.includes("begins with investigate/x)"), "says where its worktree and branch begin");
  assert.match(text, /ends in `--` and your job's name/);
  assert.match(text, /cut from the session branch investigate\/x/);
  assert.match(text, /discarded/);
  assert.match(text, /never becomes the ticket's work/);
  assert.ok(text.includes("main checkout /src/app"));
  assert.match(text, /Don't start other agents/);
});

test("both sub-agent prompts name the folder their files are in only through the agent that reads them; no workflow sections", () => {
  for (const text of [newTaskInvestigatorPrompt(P), newTaskWorkerPrompt(P)]) assert.doesNotMatch(text, /This workflow's instructions|(?<!New Task )orchestrator/i);
});

test("the New Task prompt tells the agent how to start investigators and workers, and that prototype code is thrown away", () => {
  const github = newTaskPrompt({ repo: "o/app", agentsDir: DIR });
  for (const text of [github]) {
    assert.ok(text.includes(`\`${DIR}/spawn investigator <name> '<brief>'\``));
    assert.ok(text.includes(`\`${DIR}/spawn worker <job> '<brief>'\``));
    assert.match(text, /only when (you )?need/i);
    assert.match(text, /really complex/);
    assert.match(text, /thrown away/);
    assert.match(text, /never becomes the ticket's work/);
    assert.match(text, /Don't write code/);
    assert.ok(text.includes("`hc kill <the name spawn prints>`"), "the name the script printed, not the <name> the agent gave");
    assert.ok(!text.includes("hc kill <name>"));
    assert.match(text, /prints the helper's terminal name/);
  }
});

test("without a session folder the New Task prompt is as before (no sub-agents)", () => {
  assert.doesNotMatch(newTaskPrompt({ repo: "o/app" }), /spawn/);
  assert.equal(newTaskPrompt({ repo: "o/app", agentsDir: "" }), newTaskPrompt({ repo: "o/app" }));
});

// ---- The spawn script, for real ----------------------------------------------------------------------

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const ID = "inv-abc123";

// A scratch repo whose investigate/ branch is checked out in the session's worktree, and a stand-in hc on PATH that records what it is asked.
function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ispawn-")));
  const repo = join(dir, "my app"); // a space, to be sure everything is quoted
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first");
  const branch = "investigate/fix-it-abc123";
  const workDir = worktreePath(repo, branch, join(dir, "home"));
  git(repo, "worktree", "add", "-q", "-b", branch, workDir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  return { dir, repo, branch, workDir, bin, log: join(dir, "log") };
}

function runSpawn(args, { failSend = false, setup = () => {}, id = ID, remove = false } = {}) {
  const w = scratch();
  writeFileSync(join(w.bin, "hc"), `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a" >> ${shQuote(w.log)}; done; echo >> ${shQuote(w.log)}\n${failSend ? 'case "$1" in send) exit 1 ;; esac\n' : ""}exit 0\n`);
  chmodSync(join(w.bin, "hc"), 0o755);
  setup(w);
  if (remove) git(w.repo, "worktree", "remove", "--force", w.workDir);
  const script = join(w.dir, "spawn");
  writeFileSync(script, investigationSpawnScript({ id, dir: "/sessions/it's", workDir: w.workDir, branch: w.branch, argv: { investigator: ["claude", "--effort", "low"], worker: ["claude", "--model", "a b"] } }));
  chmodSync(script, 0o755);
  const r = spawnSync(script, args, { env: { PATH: `${w.bin}:${process.env.PATH}`, HC_TERMINAL_ID: "t7" }, encoding: "utf8" });
  let calls = [];
  try { calls = readFileSync(w.log, "utf8").trim().split("\n"); } catch { /* it never called hc */ }
  return { ...r, calls, ...w, jobDir: `${w.workDir}--auth` };
}

test("spawn investigator runs in the session worktree, named <id>-<name>, labelled for the session, and sends its brief with the parent's terminal", () => {
  const r = runSpawn(["investigator", "Auth Flow!", "look at 'this' $now"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${ID}-auth-flow`);
  const [start, wait, send] = r.calls;
  assert.ok(start.startsWith(`[run][--bg][--name][${ID}-auth-flow][--cwd][${r.workDir}]`), start);
  assert.ok(start.includes(`[--label][herdr.investigation=${ID}]`));
  assert.ok(start.includes("[--label][herdr.role=investigator]"));
  assert.ok(start.includes("[--label][herdr.workflow.name=auth-flow]"));
  assert.ok(start.includes(`[--label][herdr.workflow.folder=${r.workDir}]`));
  assert.ok(!start.includes("herdr.workflow.run") && !start.includes("herdr.workflow.final"), "those are a ticket run's");
  assert.ok(start.endsWith("[--][claude][--effort][low]"));
  assert.match(wait, new RegExp(`^\\[wait\\]\\[${ID}-auth-flow\\]`));
  assert.match(send, new RegExp(`^\\[send\\]\\[${ID}-auth-flow\\]`));
  const all = r.calls.join("\n");
  assert.ok(all.includes("/sessions/it's/investigator.md") && all.includes("look at 'this' $now") && all.includes("terminal t7"));
  assert.ok(!existsSync(r.jobDir), "an investigator makes no worktree");
});

test("spawn worker makes <workDir>--<job> on <branch>--<job>, cut from the session branch, and works there", () => {
  const r = runSpawn(["worker", "Auth!", "do 'this' $now"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${ID}-auth`);
  assert.equal(git(r.jobDir, "branch", "--show-current"), "investigate/fix-it-abc123--auth");
  assert.equal(git(r.jobDir, "rev-parse", "HEAD"), git(r.workDir, "rev-parse", "HEAD"));
  const [start, , send] = r.calls;
  assert.ok(start.startsWith(`[run][--bg][--name][${ID}-auth][--cwd][${r.jobDir}]`), start);
  assert.ok(start.includes(`[--label][herdr.investigation=${ID}]`));
  assert.ok(start.includes("[--label][herdr.role=worker]"));
  assert.ok(start.includes("[--label][herdr.workflow.name=auth]"));
  assert.ok(start.includes(`[--label][herdr.workflow.folder=${r.jobDir}]`));
  assert.ok(start.endsWith("[--][claude][--model][a b]"));
  const all = r.calls.join("\n");
  assert.ok(send.includes("/sessions/it's/worker.md") && all.includes("do 'this' $now") && all.includes("terminal t7"));
});

test("spawn worker uses the job's worktree again, with what was committed in it, and picks the branch back up when only the folder is gone", () => {
  const again = runSpawn(["worker", "auth", "again"], {
    setup: (w) => {
      git(w.workDir, "worktree", "add", "-q", "-b", `${w.branch}--auth`, `${w.workDir}--auth`);
      git(`${w.workDir}--auth`, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "earlier work");
    },
  });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(git(again.jobDir, "log", "-1", "--format=%s"), "earlier work");
  const back = runSpawn(["worker", "auth", "again"], { setup: (w) => git(w.workDir, "branch", `${w.branch}--auth`) });
  assert.equal(back.status, 0, back.stderr);
  assert.equal(git(back.jobDir, "branch", "--show-current"), "investigate/fix-it-abc123--auth");
});

test("spawn worker refuses a folder that is on another branch, or is not a worktree", () => {
  const other = runSpawn(["worker", "auth", "b"], { setup: (w) => git(w.workDir, "worktree", "add", "-q", "-b", "elsewhere", `${w.workDir}--auth`) });
  assert.equal(other.status, 1);
  assert.match(other.stderr, /is on 'elsewhere', not investigate\/fix-it-abc123--auth/);
  assert.equal(other.calls.length, 0);
  const plain = runSpawn(["worker", "auth", "b"], { setup: (w) => mkdirSync(`${w.workDir}--auth`) });
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /exists and is not a worktree/);
});

test("spawn takes exactly a role, a name and a brief, and a role it knows", () => {
  for (const args of [[], ["investigator"], ["investigator", "a"], ["worker", "a"], ["investigator", "a", "b", "c"], ["worker", "a", "b", "c"]]) {
    const r = runSpawn(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /usage: spawn worker <job> <brief>/);
    assert.equal(r.calls.length, 0);
  }
  const reviewer = runSpawn(["reviewer", "a", "b"]);
  assert.equal(reviewer.status, 2);
  assert.match(reviewer.stderr, /the role must be investigator or worker, not reviewer/);
  assert.equal(runSpawn(["investigator", "!!!", "b"]).status, 2, "a name with no letter or number");
  assert.equal(runSpawn(["worker", "???", "b"]).status, 2);
});

test("spawn says when the session's worktree is gone, and starts nothing", () => {
  const r = runSpawn(["investigator", "a", "b"], { remove: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the session's worktree .* is gone/);
  assert.equal(r.calls.length, 0);
});

test("spawn cuts a terminal's name so <id>-<name> fits in 32, and a job at 40 for its branch", () => {
  const r = runSpawn(["investigator", "a".repeat(60), "b"]);
  assert.equal(r.stdout.trim().length, 32);
  assert.ok(r.stdout.trim().startsWith(`${ID}-a`));
  const w = runSpawn(["worker", "j".repeat(60), "b"]);
  assert.equal(w.stdout.trim().length, 32);
  assert.equal(git(`${w.workDir}--${"j".repeat(40)}`, "branch", "--show-current"), `${w.branch}--${"j".repeat(40)}`);
});

test("spawn says when the agent didn't take its brief", () => {
  const r = runSpawn(["investigator", "a", "b"], { failSend: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not take its brief/);
});

test("the script is safe to read back: an id, folder or branch with quotes and spaces is quoted, never run", () => {
  const nasty = "it's `x` $(y)";
  const text = investigationSpawnScript({ id: "inv-1", dir: nasty, workDir: `/w/${nasty}`, branch: `investigate/${nasty}`, argv: { investigator: ["claude", nasty], worker: ["claude"] } });
  assert.ok(text.includes(`session_dir=${shQuote(nasty)}`));
  assert.ok(text.includes(`work_dir=${shQuote(`/w/${nasty}`)}`));
  assert.ok(text.includes(`session_branch=${shQuote(`investigate/${nasty}`)}`));
  assert.ok(text.includes(`set -- ${shQuote("claude")} ${shQuote(nasty)}`));
  assert.equal(spawnSync("sh", ["-n"], { input: text }).status, 0, "it parses");
});

// ---- The session folder's files ----------------------------------------------------------------------

test("the session folder holds the spawn script, investigator.md and worker.md", () => {
  const files = sessionFiles({ id: "inv-x", dir: DIR, workDir: "/wt/x", repoRoot: "/src/app", branch: "investigate/x", argv: { investigator: ["claude"], worker: ["claude"] } });
  assert.deepEqual(Object.keys(files).sort(), ["investigator.md", "spawn", "worker.md"]);
  assert.equal(files.spawn, investigationSpawnScript({ id: "inv-x", dir: DIR, workDir: "/wt/x", branch: "investigate/x", argv: { investigator: ["claude"], worker: ["claude"] } }));
  assert.equal(files["investigator.md"], newTaskInvestigatorPrompt({ workDir: "/wt/x", repoRoot: "/src/app", branch: "investigate/x" }));
  assert.equal(files["worker.md"], newTaskWorkerPrompt({ workDir: "/wt/x", repoRoot: "/src/app", branch: "investigate/x" }));
});

// ---- The agent's command, with its parent ------------------------------------------------------------

test("with a host the agent is started under it, outliving it, with its labels; without one it has no parent", () => {
  const base = { id: "inv-x", workDir: "/w", argv: ["claude"] };
  const labelsOf = (args) => args.flatMap((a, i) => (args[i - 1] === "--label" ? [a] : []));
  const under = investigationRunArgs({ ...base, parent: "tH" });
  assert.deepEqual(under.slice(0, 8), ["run", "--bg", "--json", "--parent", "tH", "--outlive-parent", "--no-notify", "--cwd"]);
  assert.ok(!under.includes("--no-parent"));
  assert.deepEqual(labelsOf(under).sort(), ["herdr.investigation=inv-x", "herdr.role=investigation", "herdr.workflow.folder=/w"]);
  assert.deepEqual(under.slice(under.indexOf("--") + 1), ["claude"]);
  const bare = investigationRunArgs(base);
  assert.ok(bare.includes("--no-parent") && !bare.includes("--parent") && !bare.includes("--outlive-parent"));
});

// ---- Starting: the folder and the host -----------------------------------------------------------------

const AGENT = { key: "claude", run: ["claude"] };
const ARGS = { agent: AGENT, description: "Fix the login redirect", repo: "o/app", groomer: { effort: "high" }, where: { cwd: "/repo/app" } };
const T = (1_000_000).toString(36);

function fakeStart({ run, writeFails, hostFails, ready = { code: 0, stdout: '{"status":"idle"}', stderr: "" } } = {}) {
  const log = [], hcCalls = [], written = [];
  let saved = [];
  const deps = {
    now: () => 1_000_000, home: "/home/me",
    mainCheckout: async () => "/repo/app",
    prepareWorktree: async (repoRoot, branch, target) => { log.push("worktree"); return target; },
    worktreePath,
    task: async (dir) => { log.push(`task ${dir}`); return "THE PROMPT"; },
    knownAgents: async () => [{ key: "claude", run: ["claude"], installed: true }],
    writeSession: async (dir, files) => { log.push("write session"); written.push({ dir, files }); if (writeFails) throw new Error("disk full"); },
    removeSession: async (dir) => { log.push(`remove session ${dir}`); },
    openHost: async (info) => { log.push("open host"); written.push({ host: info }); if (hostFails) throw new Error("no room"); return { address: "tH", tab: "tHT", space: "sH", created: true }; },
    closeHost: async (host) => { log.push(`close host ${host.address}`); },
    hc: async (a) => { hcCalls.push(a); log.push(`hc ${a[0]}`); return a[0] === "run" ? (run ?? { code: 0, stdout: '{"address":"t9"}', stderr: "" }) : a[0] === "wait" ? ready : { code: 0, stdout: "", stderr: "" }; },
    connect: async () => { log.push("connect"); return { tab: "tX", left: "pX", space: "s1" }; },
    closeTab: () => log.push("close tab"),
    load: () => saved, save: (list) => { saved = list; log.push(`save ${list.map((e) => e.id).join(",")}`); },
    cleanup: async (repoRoot, branch, workDir) => { log.push(`cleanup ${workDir}`); },
  };
  return { deps, log, hcCalls, written, saved: () => saved };
}

test("start: the session folder is written after the worktree and before the host and the agent, and the prompt is given the folder", async () => {
  const f = fakeStart();
  const { entry } = await beginInvestigation(f.deps, ARGS);
  const dir = `/home/me/.herdr/investigations/inv-${T}`;
  assert.deepEqual(f.log, [`task ${dir}`, "worktree", "write session", "open host", "hc run", `save inv-${T}`, "connect", "hc wait", "hc send"]);
  assert.equal(f.written[0].dir, dir);
  assert.deepEqual(Object.keys(f.written[0].files).sort(), ["investigator.md", "spawn", "worker.md"]);
  assert.ok(f.written[0].files.spawn.includes(`herdr.investigation=`) && f.written[0].files.spawn.includes(`session_id='inv-${T}'`));
  assert.ok(f.written[0].files["investigator.md"].includes(entry.workDir));
  assert.ok(f.written[0].files["worker.md"].includes(`begins with ${entry.workDir})`) && !f.written[0].files["worker.md"].includes("<job>"));
});

test("start: the New Task Orchestrator gets the session folder's plumbing, and the sub-agents their own settings", async () => {
  const f = fakeStart();
  await beginInvestigation(f.deps, { ...ARGS, subAgents: { investigator: settings({ model: "haiku", effort: "low" }), worker: settings({ model: "opus", effort: "max" }) } });
  const dir = `/home/me/.herdr/investigations/inv-${T}`;
  const agent = f.hcCalls[0].slice(f.hcCalls[0].indexOf("--") + 1);
  assert.deepEqual(agent.slice(0, 3), ["claude", "--effort", "high"], "the New Task Orchestrator's own effort, not the sub-agents'");
  assert.deepEqual(values(agent, "--add-dir"), [dir]);
  assert.ok(values(agent, "--allowedTools").includes(`Bash(${dir}/spawn:*)`));
  const spawn = f.written[0].files.spawn;
  assert.ok(spawn.includes(`set -- 'claude' '--add-dir' '${dir}'`), "both roles carry the session folder");
  const line = (role) => spawn.split("\n").find((l) => l.startsWith(`  ${role}) set --`));
  assert.ok(line("investigator").includes("'haiku'") && line("investigator").includes("'low'") && line("investigator").includes("'--disallowedTools'"));
  assert.ok(line("worker").includes("'opus'") && line("worker").includes("'max'") && !line("worker").includes("'--disallowedTools'"));
});

test("start: with no settings saved the sub-agents are Claude at medium effort and the agent's default model", async () => {
  const f = fakeStart();
  await beginInvestigation(f.deps, ARGS);
  const line = (role) => f.written[0].files.spawn.split("\n").find((l) => l.startsWith(`  ${role}) set --`));
  for (const role of ["investigator", "worker"]) assert.ok(line(role).startsWith(`  ${role}) set -- 'claude'`) && line(role).includes("'--effort' 'medium'") && !line(role).includes("'--model'"), role);
});

test("start: the host opens first, named for the description, and the agent starts under it", async () => {
  const f = fakeStart();
  const { entry } = await beginInvestigation(f.deps, ARGS);
  const info = f.written.find((w) => w.host).host;
  assert.deepEqual(info, { id: entry.id, name: "Fix the login redirect agents", label: "Fix the login redirect", workDir: entry.workDir, repoRoot: "/repo/app" });
  const run = f.hcCalls[0];
  assert.equal(run[run.indexOf("--parent") + 1], "tH");
  assert.ok(run.includes("--outlive-parent") && !run.includes("--no-parent"));
  assert.ok(run.includes(`herdr.investigation=${entry.id}`) && run.includes("herdr.role=investigation"), "its labels are kept");
  assert.ok(!f.log.some((l) => l.startsWith("close host")), "the host stays while the session lives");
});

test("#57 start: a host that won't open fails the start with the reason: no agent, no tab, and the session folder, entry and worktree are taken back", async () => {
  const f = fakeStart({ hostFails: true });
  await assert.rejects(beginInvestigation(f.deps, ARGS), /The agent didn't start: its host tab didn't open \(no room\)/);
  assert.ok(!f.hcCalls.length, "no agent was started");
  assert.ok(!f.log.includes("connect") && !f.log.some((l) => l.startsWith("close host")));
  assert.ok(f.log.includes(`remove session /home/me/.herdr/investigations/inv-${T}`));
  assert.ok(f.log.findIndex((l) => l.startsWith("remove session")) < f.log.findIndex((l) => l.startsWith("cleanup")));
  assert.deepEqual(f.saved(), []);
});

test("start: an agent that doesn't start ends the host, takes the session folder back, then the worktree", async () => {
  const f = fakeStart({ run: { code: 1, stdout: "", stderr: "no such program" } });
  await assert.rejects(beginInvestigation(f.deps, ARGS), /The agent didn't start: no such program/);
  assert.ok(f.log.includes(`remove session /home/me/.herdr/investigations/inv-${T}`));
  assert.ok(f.log.indexOf("close host tH") < f.log.findIndex((l) => l.startsWith("remove session")));
  assert.ok(f.log.findIndex((l) => l.startsWith("remove session")) < f.log.findIndex((l) => l.startsWith("cleanup")));
  assert.deepEqual(f.saved(), []);
});

test("start: an agent that ends while starting or won't take its prompt also ends the host and takes the folder back", async () => {
  for (const f of [fakeStart({ ready: { code: 0, stdout: '{"reason":"exit","exit_code":1}', stderr: "" } })]) {
    await assert.rejects(beginInvestigation(f.deps, ARGS), /didn't start properly/);
    assert.ok(f.log.includes("close tab") && f.log.includes("close host tH") && f.log.some((l) => l.startsWith("remove session")));
    assert.ok(f.log.at(-1).startsWith("cleanup "));
  }
  const g = fakeStart();
  const hc = g.deps.hc;
  g.deps.hc = async (a) => (a[0] === "send" ? { code: 1, stdout: "", stderr: "busy" } : hc(a));
  await assert.rejects(beginInvestigation(g.deps, ARGS), /didn't take its task/);
  assert.ok(g.log.includes("close host tH") && g.log.some((l) => l.startsWith("remove session")));
});

test("start: a session folder that can't be written takes back what was made: no host, no agent, the worktree goes", async () => {
  const f = fakeStart({ writeFails: true });
  await assert.rejects(beginInvestigation(f.deps, ARGS), /disk full/);
  assert.ok(!f.log.includes("open host") && !f.log.includes("hc run"));
  assert.ok(f.log.some((l) => l.startsWith("remove session")), "what was half written");
  assert.ok(f.log.at(-1).startsWith("cleanup "));
  assert.deepEqual(f.saved(), []);
});

test("start: a session folder that can't be named (no home) is refused before anything is made", async () => {
  const f = fakeStart();
  f.deps.home = "";
  await assert.rejects(beginInvestigation(f.deps, ARGS), /folder for the session's helpers/);
  assert.deepEqual(f.log, [], "no prompt, worktree, folder, host or agent");
  assert.deepEqual(f.saved(), []);
});

test("start: a prompt that can't be made leaves nothing behind, and no folder is written", async () => {
  const f = fakeStart();
  f.deps.task = async () => { throw new Error("no tasks folder"); };
  await assert.rejects(beginInvestigation(f.deps, ARGS), /no tasks folder/);
  assert.deepEqual(f.log, []);
});

test("the host is found again under its own key", () => {
  assert.equal(hostKey("inv-x"), "github-tasks.host.inv-x");
});

// ---- A refactor session ---------------------------------------------------------------------------------

const TYPE = { id: "isolation", name: "Isolation", orchestrator: { agent: "claude", command: "", model: "opus", effort: "high", prompt: "Find modules that reach into each other.\n\nRate each one." } };

test("the Refactor Orchestrator runs with its type's orchestrator settings, not New Task's, and the same Claude extras", () => {
  const known = [{ key: "claude", run: ["claude", "--x"], installed: true }];
  const argv = refactorAgentArgv({ agent: "claude", command: "", model: "opus", effort: "high" }, known, DIR);
  assert.deepEqual(argv.slice(0, 5), ["claude", "--x", "--model", "opus", "--effort"]);
  assert.equal(argv[5], "high");
  assert.deepEqual(argv, newTaskAgentArgv({ key: "claude", run: ["claude", "--x"] }, { model: "opus", effort: "high" }, DIR), "the same command New Task's agent would run, with the type's model and effort");
  assert.deepEqual(values(argv, "--add-dir"), [DIR]);
  assert.deepEqual(values(argv, "--allowedTools"), NEW_TASK_PLUMBING(DIR));
});

test("the Refactor Orchestrator's agent: codex gets -m and an effort, a custom one runs its command, an unlisted one runs as its key, no folder means no extras", () => {
  assert.deepEqual(refactorAgentArgv({ agent: "codex", model: "m", effort: "low" }, [{ key: "codex", run: ["codex", "--y"] }], DIR), ["codex", "--y", "-m", "m", "-c", "model_reasoning_effort=low"]);
  assert.deepEqual(refactorAgentArgv({ agent: "custom", command: "my-agent --go", model: "m", effort: "low" }, [], DIR), ["sh", "-c", "my-agent --go"]);
  assert.deepEqual(refactorAgentArgv({ agent: "claude", model: "", effort: "" }, undefined, null), ["claude", "--effort", "medium"]);
});

test("a refactor session's helpers answer to the Refactor Orchestrator, and read their type's prompt after the built-in text", () => {
  const inv = newTaskInvestigatorPrompt({ ...P, refactor: true, rolePrompt: "Look for imports across mods.\n" });
  const wor = newTaskWorkerPrompt({ ...P, refactor: true, rolePrompt: "  Keep the prototype tiny.  " });
  for (const text of [inv, wor]) {
    assert.ok(text.includes("Refactor session") && text.includes("Refactor Orchestrator"));
    assert.doesNotMatch(text, /New Task/);
  }
  assert.ok(inv.startsWith(newTaskInvestigatorPrompt({ ...P, refactor: true })), "the built-in text comes first, unchanged");
  assert.ok(inv.endsWith("\n\n## This refactor's instructions\n\nLook for imports across mods."));
  assert.ok(wor.endsWith("\n\n## This refactor's instructions\n\nKeep the prototype tiny."));
  assert.match(bodyOf(newTaskWorkerPrompt({ ...P, refactor: true })), /never push, merge or open a pull request/);
});

test("no prompt of the type for a role: the built-in text only; a New Task session is unchanged", () => {
  for (const rolePrompt of ["", "  \n", undefined]) assert.equal(newTaskInvestigatorPrompt({ ...P, refactor: true, rolePrompt }), newTaskInvestigatorPrompt({ ...P, refactor: true }));
  assert.equal(newTaskInvestigatorPrompt({ ...P, refactor: false }), newTaskInvestigatorPrompt(P));
  assert.match(newTaskInvestigatorPrompt(P), /New Task Orchestrator/);
});

test("sessionFiles for a refactor: each role's file has its own type prompt, the spawn script names the Refactor Orchestrator", () => {
  const argv = { investigator: ["claude"], worker: ["claude"] };
  const files = sessionFiles({ id: "inv-x", dir: DIR, workDir: "/wt/x", repoRoot: "/src/app", branch: "investigate/x", argv, refactor: { investigator: "I prompt", worker: "" } });
  assert.ok(files["investigator.md"].endsWith("## This refactor's instructions\n\nI prompt"));
  assert.ok(!files["worker.md"].includes("This refactor's instructions"), "an empty prompt adds nothing");
  assert.equal(files.spawn, investigationSpawnScript({ id: "inv-x", dir: DIR, workDir: "/wt/x", branch: "investigate/x", argv, refactor: true }));
  assert.match(files.spawn, /The Refactor Orchestrator that started you is the terminal/);
  assert.match(files.spawn, /for Refactor session inv-x/);
  assert.doesNotMatch(files.spawn, /New Task/);
  assert.match(sessionFiles({ id: "inv-x", dir: DIR, workDir: "/wt/x", repoRoot: "/src/app", branch: "investigate/x", argv }).spawn, /The New Task Orchestrator that started you/);
});

test("the Refactor prompt: the header, the same Context, the type's prompt quoted, the focus, the steps and the helpers", () => {
  const github = refactorPrompt({ repo: "o/app", project: { title: "Board", url: "https://x/p" }, type: TYPE, focus: "", agentsDir: DIR });
  assert.ok(github.startsWith("# You are the Refactor Orchestrator, running the Isolation refactor for o/app\n"));
  const between = (t) => t.slice(t.indexOf("## Context"), t.indexOf("## What to do"));
  assert.equal(between(github), between(newTaskPrompt({ repo: "o/app", project: { title: "Board", url: "https://x/p" } })), "the GitHub Context is New Task's");
  for (const text of [github]) {
    assert.ok(text.includes("> Find modules that reach into each other.\n>\n> Rate each one."), "the type's orchestrator prompt, quoted line by line");
    assert.ok(text.includes("look at the whole repo"), "no focus: the whole repo");
    assert.ok(!text.includes("asked you to focus"));
    for (const step of ["start investigators", "rate each one", "List them to the person", "which of them to keep", "show the "]) assert.ok(text.includes(step), step);
    assert.ok(text.includes("a short title, a description, and the acceptance criteria as a checklist"));
    assert.ok(text.includes("Create it only when they say yes."));
    assert.ok(text.includes("Ask one question at a time. " + ASK_WITH_TOOL));
    assert.match(text, /Don't write code yourself\. Never push, merge or open a pull request\./);
    assert.ok(text.includes(`\`${DIR}/spawn investigator <name> '<brief>'\``) && text.includes(`\`${DIR}/spawn worker <job> '<brief>'\``));
    assert.match(text, /thrown away/);
    assert.match(text, /never becomes a ticket's work/);
    assert.doesNotMatch(text, /Don't do anything yet/);
  }
  assert.ok(github.includes('whether it should be in "Up Next" or "To Do"') && github.includes('the GitHub Project "Board"'));
  assert.doesNotMatch(refactorPrompt({ repo: "o/app", type: TYPE }), /spawn/, "no session folder, no helpers section");
});

test("the Refactor prompts with a focus say what to focus on; several lines are quoted; the project's own status names are used", () => {
  assert.ok(refactorPrompt({ repo: "o/app", type: TYPE, focus: "  the sidebar  " }).includes("The person asked you to focus on: the sidebar\n"));
  const many = refactorPrompt({ repo: "o/app", type: TYPE, focus: "the sidebar\nand the popup" });
  assert.ok(many.includes("The person asked you to focus on:\n\n> the sidebar\n> and the popup"));
  assert.ok(refactorPrompt({ repo: "o/app", type: TYPE, backlog: "Todo", groomed: "Ready" }).includes('"Ready" or "Todo"'));
});
