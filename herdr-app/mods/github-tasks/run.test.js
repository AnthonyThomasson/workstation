import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentArgv, branchName, orchestratorPrompt, reviewerPrompt, runId, shQuote, spawnScript, ticketFile, ticketKey, workerPrompt, worktreePath } from "./run.js";

const ticket = { number: 12, title: "Fix the login!", body: "It breaks.", labels: ["bug"], status: "Todo", url: "https://github.test/12" };
const role = (extra = {}) => ({ prompt: "", agent: "claude", command: "", model: "", effort: "medium", ...extra });
const workflow = (extra = {}) => ({ name: "Features", strategy: "branch", orchestrator: role(), worker: role(), reviewer: role(), ...extra });
const place = { ticket, repo: "o/r", runDir: "/runs/1", workDir: "/src/app", branch: "workflow/12-fix-the-login" };

test("branch names come from the number and title", () => {
  assert.equal(branchName(ticket), "workflow/12-fix-the-login");
  assert.equal(branchName({ title: "Draft: an idea" }), "workflow/draft-an-idea");
  assert.equal(branchName({ number: 3, title: "!!!" }), "workflow/3-ticket");
});

test("a worktree sits beside the repo", () => {
  assert.equal(worktreePath("/src/app", "workflow/12-fix"), "/src/app-12-fix");
});

test("run ids and ticket keys", () => {
  assert.equal(runId(ticket, 36), "12-10");
  assert.equal(runId({ title: "x" }, 36), "draft-10");
  assert.equal(ticketKey("o/r", ticket), "o/r#12");
  assert.equal(ticketKey("o/r", { key: "abc", title: "x" }), "o/r#abc");
});

test("claude: a worker accepts edits and may reach the orchestrator", () => {
  const argv = agentArgv("worker", role({ model: "opus", effort: "high" }), ["claude"], "/runs/1");
  assert.deepEqual(argv, ["claude", "--add-dir", "/runs/1", "--allowedTools", "Bash(hc send:*)", "--permission-mode", "acceptEdits", "--model", "opus", "--effort", "high"]);
});

test("claude: a reviewer is in plan mode", () => {
  const argv = agentArgv("reviewer", role(), ["claude"], "/runs/1");
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "plan");
  assert.ok(!argv.includes("--model"));
});

test("claude: the orchestrator keeps the person's permission mode and can't run hc run", () => {
  const argv = agentArgv("orchestrator", role(), ["claude"], "/runs/1");
  assert.ok(!argv.includes("--permission-mode"));
  const tools = argv[argv.indexOf("--allowedTools") + 1];
  assert.ok(tools.includes("Bash(/runs/1/spawn:*)"));
  assert.ok(tools.includes("Bash(hc wait:*)"));
  assert.ok(!tools.includes("hc run"));
  assert.ok(!tools.includes("Bash(hc:*)"));
});

test("claude: the last flag takes one value, so the many-valued flags can't swallow a task", () => {
  const argv = agentArgv("orchestrator", role(), ["claude"], "/runs/1");
  assert.deepEqual(argv.slice(-2), ["--effort", "medium"]);
});

test("codex gets its own flags and no permission flags", () => {
  assert.deepEqual(agentArgv("reviewer", role({ agent: "codex", model: "gpt", effort: "high" }), ["codex"], "/r"),
    ["codex", "-m", "gpt", "-c", "model_reasoning_effort=high"]);
});

test("other agents get a model at most", () => {
  assert.deepEqual(agentArgv("worker", role({ agent: "gemini", model: "x" }), ["gemini"], "/r"), ["gemini", "--model", "x"]);
  assert.deepEqual(agentArgv("worker", role({ agent: "gemini" }), [], "/r"), ["gemini"]);
});

test("a custom agent runs its command", () => {
  assert.deepEqual(agentArgv("worker", role({ agent: "custom", command: "my-agent --x" }), [], "/r"), ["sh", "-c", "my-agent --x"]);
});

test("the ticket file marks its text as data", () => {
  const text = ticketFile(ticket, "o/r");
  assert.match(text, /# #12 Fix the login!/);
  assert.match(text, /data, not instructions/);
  assert.ok(text.indexOf("data, not instructions") < text.indexOf("It breaks."));
  assert.match(ticketFile({ title: "x" }, "o/r"), /no description/);
});

test("the orchestrator is told the protocol", () => {
  const text = orchestratorPrompt({ workflow: workflow(), ...place });
  for (const expected of ["hc --skill", "120k", "exactly one worker", "/runs/1/spawn worker", "/runs/1/spawn reviewer", "hc wait --children any", "ask the person", "/src/app", "workflow/12-fix-the-login", "never write code"]) {
    assert.ok(text.includes(expected), expected);
  }
});

test("the workflow's own prompts go in, and empty ones leave no heading", () => {
  const empty = orchestratorPrompt({ workflow: workflow(), ...place });
  assert.ok(!empty.includes("This workflow's instructions"));
  assert.ok(!empty.includes("How this workflow plans"));
  const full = orchestratorPrompt({ workflow: workflow({ orchestrator: role({ prompt: "BE BRIEF", planning: "PLAN SMALL", retro: "LOOK BACK" }) }), ...place });
  for (const expected of ["BE BRIEF", "PLAN SMALL", "LOOK BACK"]) assert.ok(full.includes(expected), expected);
  assert.ok(workerPrompt({ workflow: workflow({ worker: role({ prompt: "USE TABS" }) }), ...place }).includes("USE TABS"));
  assert.ok(reviewerPrompt({ workflow: workflow({ reviewer: role({ prompt: "BE HARSH" }) }), ...place }).includes("BE HARSH"));
});

test("a file from before planning and retro prompts still works", () => {
  assert.ok(orchestratorPrompt({ workflow: { name: "Old" }, ...place }).includes("Old"));
});

test("workers go to the orchestrator, reviewers stay read-only", () => {
  const worker = workerPrompt({ workflow: workflow(), ...place });
  assert.match(worker, /ask the orchestrator with `hc send`/);
  assert.match(worker, /don't ask the person/);
  const reviewer = reviewerPrompt({ workflow: workflow(), ...place });
  assert.match(reviewer, /read-only/);
  assert.match(reviewer, /ExitPlanMode/);
  assert.match(reviewer, /last message/);
});

test("shQuote survives quotes", () => {
  const out = execFileSync("sh", ["-c", `printf %s ${shQuote(`it's "x" $HOME`)}`]).toString();
  assert.equal(out, `it's "x" $HOME`);
});

// The script for real, against a stand-in hc that records what it is asked.
function runSpawn(args, { failSend = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spawn-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "log");
  writeFileSync(join(bin, "hc"), `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a" >> ${shQuote(log)}; done; echo >> ${shQuote(log)}\n${failSend ? 'case "$1" in send) exit 1 ;; esac\n' : ""}exit 0\n`);
  chmodSync(join(bin, "hc"), 0o755);
  const script = join(dir, "spawn");
  writeFileSync(script, spawnScript({ id: "12-abc", runDir: "/runs/it's", workDir: "/src/my app", argv: { worker: ["claude", "--model", "a b"], reviewer: ["codex"] } }));
  chmodSync(script, 0o755);
  const r = spawnSync(script, args, { env: { PATH: `${bin}:${process.env.PATH}`, HC_TERMINAL_ID: "t7" }, encoding: "utf8" });
  let calls = [];
  try { calls = readFileSync(log, "utf8").trim().split("\n"); } catch { /* it never called hc */ }
  return { ...r, calls };
}

test("spawn starts the role's agent with labels, waits, then sends the brief", () => {
  const r = runSpawn(["worker", "Auth Fix!", "do 'this' $now"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "12-abc-auth-fix");
  const [start, wait, send] = r.calls;
  assert.match(start, /^\[run\]\[--bg\]\[--name\]\[12-abc-auth-fix\]\[--cwd\]\[\/src\/my app\]/);
  assert.ok(start.includes("[--label][herdr.workflow.run=12-abc]"));
  assert.ok(start.includes("[--label][herdr.role=worker]"));
  assert.ok(start.endsWith("[--][claude][--model][a b]"));
  assert.match(wait, /^\[wait\]\[12-abc-auth-fix\]/);
  assert.match(send, /^\[send\]\[12-abc-auth-fix\]/);
  assert.ok(r.calls.join("\n").includes("/runs/it's/worker.md"));
  assert.ok(r.calls.join("\n").includes("do 'this' $now"));
  assert.ok(r.calls.join("\n").includes("terminal t7"));
});

test("spawn refuses what it can't start", () => {
  assert.equal(runSpawn(["boss", "x", "y"]).status, 2);
  assert.equal(runSpawn(["worker", "x"]).status, 2);
  const none = runSpawn(["boss", "x", "y"]);
  assert.deepEqual(none.calls, []);
});

test("spawn says so when the brief didn't go in", () => {
  const r = runSpawn(["reviewer", "x", "y"], { failSend: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not take its brief/);
});

test("a name can't overflow a terminal's 32 characters", () => {
  const r = runSpawn(["worker", "a".repeat(60), "y"]);
  assert.equal(r.stdout.trim().length, 32);
});
