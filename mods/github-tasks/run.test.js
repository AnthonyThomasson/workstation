import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentArgv, branchName, orchestratorPrompt, reopenProps, reviewerPrompt, runId, shQuote, spawnScript, ticketFile, ticketKey, workerPrompt, worktreePath } from "./run.js";

const ticket = { number: 12, title: "Fix the login!", body: "It breaks.", labels: ["bug"], status: "Todo", url: "https://github.test/12" };
const role = (extra = {}) => ({ prompt: "", agent: "claude", command: "", model: "", effort: "medium", ...extra });
const workflow = (extra = {}) => ({ name: "Features", orchestrator: role(), worker: role(), reviewer: role(), ...extra });
const place = { ticket, repo: "o/r", runDir: "/runs/1", workDir: "/src/app-12-fix-the-login", repoRoot: "/src/app", branch: "workflow/12-fix-the-login" };

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

// The values of a flag that takes any number of them, up to the next flag.
const values = (argv, flag) => {
  const from = argv.indexOf(flag) + 1;
  const to = argv.findIndex((a, i) => i >= from && a.startsWith("--"));
  return argv.slice(from, to === -1 ? undefined : to);
};

test("claude: a worker accepts edits and may reach the orchestrator", () => {
  const argv = agentArgv("worker", role({ model: "opus", effort: "high" }), ["claude"], "/runs/1");
  assert.deepEqual(argv, ["claude", "--add-dir", "/runs/1", "--allowedTools", "Bash(hc send:*)", "--permission-mode", "acceptEdits", "--model", "opus", "--effort", "high"]);
});

test("claude: a reviewer can't ask, can't edit, and may only run read-only git and the workflow's test commands", () => {
  const argv = agentArgv("reviewer", role({ tests: "node --test\n  npm test \n\nherdr-app check" }), ["claude"], "/runs/1");
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(argv[argv.indexOf("--disallowedTools") + 1], "Edit,Write,NotebookEdit,MultiEdit");
  assert.deepEqual(values(argv, "--allowedTools"), [
    "Bash(hc send:*)",
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
    "Bash(git rev-parse:*)", "Bash(git merge-base:*)", "Bash(git ls-files:*)", "Bash(git grep:*)",
    "Bash(git symbolic-ref --short refs/remotes/origin/HEAD)", // exact: no `:*`, since other symbolic-ref arguments write
    "Bash(node --test:*)", "Bash(npm test:*)", "Bash(herdr-app check:*)",
  ]);
  assert.ok(!argv.includes("Bash(git branch:*)")); // `git branch` can create and delete
  assert.ok(!argv.some((a) => a.startsWith("Bash(git symbolic-ref") && a.includes(":*"))); // `git symbolic-ref HEAD refs/heads/x` and `-d` write
  assert.ok(!argv.includes("--model"));
  assert.deepEqual(argv.slice(-2), ["--effort", "medium"]);
});

test("claude: a test command with a comma in it stays one allowed rule", () => {
  const argv = agentArgv("reviewer", role({ tests: "node --test --test-name-pattern=a,b\nnpm test" }), ["claude"], "/runs/1");
  const rules = values(argv, "--allowedTools");
  assert.ok(rules.includes("Bash(node --test --test-name-pattern=a,b:*)"));
  assert.ok(rules.includes("Bash(npm test:*)"));
  assert.ok(!rules.some((r) => r === "Bash(node --test --test-name-pattern=a"), "not split at the comma");
  assert.equal(argv[argv.indexOf("--disallowedTools") - 1], "Bash(npm test:*)"); // the flag after the list ends it
});

test("claude: a reviewer with no test commands (an older workflow file) gets only the read-only ones", () => {
  const rules = values(agentArgv("reviewer", role(), ["claude"], "/runs/1"), "--allowedTools");
  assert.ok(rules.includes("Bash(git show:*)") && rules.every((r) => r.startsWith("Bash(git ") || r === "Bash(hc send:*)"));
});

test("claude: workers don't get the reviewer's restrictions", () => {
  assert.ok(!agentArgv("worker", role({ tests: "npm test" }), ["claude"], "/runs/1").includes("--disallowedTools"));
});

test("claude: the orchestrator keeps the person's permission mode and can't run hc run", () => {
  const argv = agentArgv("orchestrator", role(), ["claude"], "/runs/1");
  assert.ok(!argv.includes("--permission-mode"));
  const tools = values(argv, "--allowedTools");
  for (const rule of ["Bash(/runs/1/spawn:*)", "Bash(hc wait:*)", "Bash(hc kill:*)"]) assert.ok(tools.includes(rule), rule);
  assert.ok(!tools.some((t) => t.includes("hc run")));
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
  for (const expected of ["hc --skill", "120k", "exactly one worker", "/runs/1/spawn worker <job>", "/runs/1/spawn reviewer <name> <job>", "/runs/1/spawn reviewer <name> final", "hc wait --children any", "Keeping up with the main branch", "rebase origin/<main-branch>", "ask the person", "/src/app", "workflow/12-fix-the-login", "never write code"]) {
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

test("workers must test, and the workflow's testing prompt goes in", () => {
  const base = workerPrompt({ workflow: workflow(), ...place });
  assert.match(base, /You must test the changes you make/);
  assert.ok(!base.includes("Testing rules"));
  const full = workerPrompt({ workflow: workflow({ worker: role({ testing: "RUN NPM TEST" }) }), ...place });
  assert.ok(full.includes("## Testing rules") && full.includes("RUN NPM TEST"));
  assert.match(full, /its own testing rules, under "Testing rules" below\. Follow them/);
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
  assert.match(reviewer, /can't edit files/);
  assert.match(reviewer, /with `hc send`, and give them as your last message/);
  assert.ok(!reviewer.includes("ExitPlanMode"));
});

test("every role is told which folder is the main checkout, the ticket's and its own", () => {
  const folders = ["/src/app", "/src/app-12-fix-the-login", "/src/app-12-fix-the-login--<job>", "workflow/12-fix-the-login--<job>"];
  for (const build of [orchestratorPrompt, workerPrompt, reviewerPrompt]) {
    const text = build({ workflow: workflow(), ...place });
    for (const expected of folders) assert.ok(text.includes(expected), `${build.name}: ${expected}`);
    assert.match(text, /main checkout/);
  }
});

test("live-environment steps wait for the Merge and run from the main checkout", () => {
  for (const build of [orchestratorPrompt, workerPrompt]) {
    const text = build({ workflow: workflow(), ...place });
    assert.match(text, /mount\.sh/, build.name);
    assert.match(text, /Skillshare/, build.name);
    assert.match(text, /never run from a worktree/, build.name);
  }
  assert.match(orchestratorPrompt({ workflow: workflow(), ...place }), /list them in your final report for the person to approve/);
});

test("the orchestrator runs jobs in parallel, reviews and merges each, then reviews the whole ticket", () => {
  const text = orchestratorPrompt({ workflow: workflow(), ...place });
  assert.ok(!text.includes("share one branch and one folder"));
  for (const expected of ["Run independent jobs in parallel, each in its own worktree", "start a reviewer on its job", "tell its worker with `hc send` to merge", "end the worker and its reviewer with `hc kill <name>`", "one reviewer over the whole ticket branch against the default branch", "end it with `hc kill <name>`", "Merge button", "Create PR", "Don't merge into the default branch, push or open a pull request yourself"]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.match(text, /rebase the ticket branch onto it, in the ticket worktree: `git -C \/src\/app-12-fix-the-login rebase origin\/<main-branch>`/);
});

test("a worker merges by rebasing, re-testing, fast-forwarding and cleaning up, and never pushes", () => {
  const text = workerPrompt({ workflow: workflow(), ...place });
  for (const expected of ["git rebase workflow/12-fix-the-login", "git -C /src/app-12-fix-the-login merge --ff-only workflow/12-fix-the-login--<job>", "worktree remove", "branch -d workflow/12-fix-the-login--<job>", "Never push", "git rebase --abort"]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.ok(!text.includes("Other workers may share it"));
});

test("a worker removes its own folder and reports in one command run from the ticket worktree", () => {
  const text = workerPrompt({ workflow: workflow(), ...place });
  assert.ok(text.includes('cd /src/app-12-fix-the-login && git worktree remove <your worktree> && git branch -d workflow/12-fix-the-login--<job> && hc send <orchestrator> "<report>"'));
  assert.match(text, /Don't remove your worktree in a separate step before reporting/);
  assert.ok(!text.includes("5. `hc send` the orchestrator that the merge is done"));
});

test("the orchestrator names reviewers uniquely, apart from every job", () => {
  const text = orchestratorPrompt({ workflow: workflow(), ...place });
  assert.match(text, /unique in this run and differ from every job name/);
  assert.ok(text.includes("`<job>-review`"));
});

test("a reviewer is only told about git commands its allowlist permits, and not to check out other commits", () => {
  const text = reviewerPrompt({ workflow: workflow(), ...place });
  const argv = agentArgv("reviewer", { agent: "claude", tests: "" }, ["claude"], "/run");
  // Every full git command the prompt puts in backticks, however long, must be covered by a rule: a `:*` prefix rule or an exact one.
  const named = [...text.matchAll(/`(git [^`]+)`/g)].map((m) => m[1]).filter((c) => !/[<>]/.test(c));
  assert.ok(named.length >= 9);
  const permitted = (cmd) => argv.some((r) => r === `Bash(${cmd})` || (r.endsWith(":*)") && (cmd === r.slice(5, -3) || cmd.startsWith(`${r.slice(5, -3)} `))));
  for (const cmd of named) assert.ok(permitted(cmd), cmd);
  assert.ok(named.includes("git symbolic-ref --short refs/remotes/origin/HEAD"));
  assert.ok(!named.includes("git symbolic-ref")); // the prompt names that one command, not symbolic-ref in general
  assert.match(text, /checking out another commit/);
  assert.ok(text.includes("git show <commit>:<path>"));
});

test("shQuote survives quotes", () => {
  const out = execFileSync("sh", ["-c", `printf %s ${shQuote(`it's "x" $HOME`)}`]).toString();
  assert.equal(out, `it's "x" $HOME`);
});

// The script for real: a scratch git repo with the ticket's branch checked out in its worktree, and a stand-in hc
// on PATH that records what it is asked. Returns where things are, so a test can look at what the script made.
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "spawn-"));
  const repo = join(dir, "my app"); // a space, to be sure everything is quoted
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first");
  const branch = "workflow/12-fix";
  const ticketDir = worktreePath(repo, branch);
  git(repo, "worktree", "add", "-q", "-b", branch, ticketDir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "log");
  return { dir, repo, branch, ticketDir, bin, log };
}

// Where a job's worktree and branch are: beside the ticket's worktree, on a branch off the ticket's own.
const jobAt = (ticketDir, ticketBranch, name) => ({ path: `${ticketDir}--${name}`, branch: `${ticketBranch}--${name}` });

function runSpawn(args, { failSend = false, setup = () => {}, workDir } = {}) {
  const w = scratch();
  writeFileSync(join(w.bin, "hc"), `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a" >> ${shQuote(w.log)}; done; echo >> ${shQuote(w.log)}\n${failSend ? 'case "$1" in send) exit 1 ;; esac\n' : ""}exit 0\n`);
  chmodSync(join(w.bin, "hc"), 0o755);
  setup(w);
  const script = join(w.dir, "spawn");
  writeFileSync(script, spawnScript({ id: "12-abc", runDir: "/runs/it's", workDir: workDir?.(w) ?? w.ticketDir, branch: w.branch, argv: { worker: ["claude", "--model", "a b"], reviewer: ["codex"] } }));
  chmodSync(script, 0o755);
  const r = spawnSync(script, args, { env: { PATH: `${w.bin}:${process.env.PATH}`, HC_TERMINAL_ID: "t7" }, encoding: "utf8" });
  let calls = [];
  try { calls = readFileSync(w.log, "utf8").trim().split("\n"); } catch { /* it never called hc */ }
  return { ...r, calls, ...w, jobDir: jobAt(w.ticketDir, w.branch, "auth").path };
}

test("spawn worker makes the job's worktree and branch off the ticket's, and works there", () => {
  const r = runSpawn(["worker", "Auth!", "do 'this' $now"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "12-abc-auth");
  const job = jobAt(r.ticketDir, r.branch, "auth");
  assert.equal(git(job.path, "branch", "--show-current"), "workflow/12-fix--auth");
  assert.equal(git(job.path, "rev-parse", "HEAD"), git(r.ticketDir, "rev-parse", "HEAD")); // made off the ticket branch
  const [start, wait, send] = r.calls;
  assert.ok(start.startsWith(`[run][--bg][--name][12-abc-auth][--cwd][${job.path}]`), start);
  assert.ok(start.includes("[--label][herdr.workflow.run=12-abc]"));
  assert.ok(start.includes("[--label][herdr.role=worker]"));
  assert.ok(start.includes("[--label][herdr.workflow.name=auth]"));
  assert.ok(start.includes(`[--label][herdr.workflow.folder=${job.path}]`));
  assert.ok(!start.includes("herdr.workflow.final"));
  assert.ok(start.endsWith("[--][claude][--model][a b]"));
  assert.match(wait, /^\[wait\]\[12-abc-auth\]/);
  assert.match(send, /^\[send\]\[12-abc-auth\]/);
  const all = r.calls.join("\n");
  assert.ok(all.includes("/runs/it's/worker.md") && all.includes("do 'this' $now") && all.includes("terminal t7"));
});

test("spawn worker uses the job's worktree again, with what was committed in it", () => {
  const r = runSpawn(["worker", "auth", "again"], {
    setup: (w) => {
      const job = jobAt(w.ticketDir, w.branch, "auth");
      git(w.ticketDir, "worktree", "add", "-q", "-b", job.branch, job.path);
      git(job.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "earlier work");
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(r.jobDir, "log", "-1", "--format=%s"), "earlier work");
  assert.ok(r.calls[0].includes(`[--cwd][${r.jobDir}]`));
});

test("spawn worker picks a job's branch back up when only its folder is gone", () => {
  const r = runSpawn(["worker", "auth", "again"], { setup: (w) => git(w.ticketDir, "branch", "workflow/12-fix--auth") });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(r.jobDir, "branch", "--show-current"), "workflow/12-fix--auth");
});

test("spawn reviewer <name> <job> works in the job's worktree, which must already exist", () => {
  const r = runSpawn(["reviewer", "Checker", "auth", "look"], {
    setup: (w) => { const job = jobAt(w.ticketDir, w.branch, "auth"); git(w.ticketDir, "worktree", "add", "-q", "-b", job.branch, job.path); },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "12-abc-checker");
  const start = r.calls[0];
  assert.ok(start.startsWith(`[run][--bg][--name][12-abc-checker][--cwd][${r.jobDir}]`), start);
  assert.ok(start.includes("[--label][herdr.role=reviewer]"));
  assert.ok(start.includes(`[--label][herdr.workflow.folder=${r.jobDir}]`));
  assert.ok(!start.includes("herdr.workflow.final"));
  assert.ok(start.endsWith("[--][codex]"));
  assert.ok(r.calls.join("\n").includes("/runs/it's/reviewer.md"));
});

test("spawn reviewer for a job with no worktree says so and starts nothing", () => {
  const r = runSpawn(["reviewer", "checker", "auth", "look"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /job auth has no worktree/);
  assert.match(r.stderr, /spawn worker auth/);
  assert.deepEqual(r.calls, []);
});

test("spawn reviewer <name> final works in the ticket's worktree and labels itself the final reviewer", () => {
  const r = runSpawn(["reviewer", "last", "final", "look at it all"]);
  assert.equal(r.status, 0, r.stderr);
  const start = r.calls[0];
  assert.ok(start.startsWith(`[run][--bg][--name][12-abc-last][--cwd][${r.ticketDir}]`), start);
  assert.ok(start.includes("[--label][herdr.workflow.final=1]"));
  assert.ok(start.includes(`[--label][herdr.workflow.folder=${r.ticketDir}]`));
  assert.ok(start.includes("[--label][herdr.role=reviewer]"));
});

test("spawn refuses what it can't start", () => {
  for (const args of [[], ["boss", "x", "y"], ["worker", "x"], ["worker", "x", "y", "z"], ["reviewer", "x", "y"], ["reviewer", "x", "y", "z", "w"], ["worker", "!!!", "y"], ["reviewer", "x", "!!!", "y"], ["worker", "final", "y"]]) {
    const r = runSpawn(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.deepEqual(r.calls, []);
  }
});

test("spawn won't work in a ticket worktree that is gone", () => {
  const r = runSpawn(["worker", "auth", "y"], { setup: (w) => execFileSync("rm", ["-rf", w.ticketDir]) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /worktree .* is gone/);
});

test("spawn says so when the brief didn't go in", () => {
  const r = runSpawn(["reviewer", "x", "final", "y"], { failSend: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not take its brief/);
});

test("a name can't overflow a terminal's 32 characters", () => {
  const r = runSpawn(["worker", "a".repeat(60), "y"]);
  assert.equal(r.stdout.trim().length, 32);
  assert.equal(git(jobAt(r.ticketDir, r.branch, "a".repeat(40)).path, "branch", "--show-current"), `workflow/12-fix--${"a".repeat(40)}`);
  assert.equal(runSpawn(["reviewer", "b".repeat(60), "final", "y"]).stdout.trim().length, 32);
});

test("spawn cleans a job's name into the folder and branch: runs collapse, ends are trimmed, long names are cut", () => {
  const cases = [
    ["Fix  Auth!!", "fix-auth"],
    ["  --Build_1--  ", "build_1"],
    ["a/b\\c d", "a-b-c-d"],
    ["Ünï cøde", "n-c-de"],
    [`${"x".repeat(39)}!yyy`, "x".repeat(39)], // cut at 40 leaves a trailing '-', which goes
    ["z".repeat(60), "z".repeat(40)],
  ];
  for (const [given, job] of cases) {
    const r = runSpawn(["worker", given, "y"]);
    assert.equal(r.status, 0, `${given}: ${r.stderr}`);
    const at = jobAt(r.ticketDir, r.branch, job);
    assert.ok(r.calls[0].includes(`[--cwd][${at.path}]`), `${given}: ${r.calls[0]}`);
    assert.equal(git(at.path, "branch", "--show-current"), at.branch, given);
  }
});

test("spawn builds a job's folder from the ticket worktree it was given, even when that isn't the usual place", () => {
  const r = runSpawn(["worker", "auth", "y"], {
    workDir: (w) => join(w.dir, "somewhere else"),
    setup: (w) => { git(w.ticketDir, "worktree", "move", w.ticketDir, join(w.dir, "somewhere else")); },
  });
  assert.equal(r.status, 0, r.stderr);
  const at = jobAt(join(r.dir, "somewhere else"), r.branch, "auth");
  assert.ok(r.calls[0].includes(`[--cwd][${at.path}]`), r.calls[0]);
  assert.equal(git(at.path, "branch", "--show-current"), at.branch);
});

test("a reopened run pane gets the full props saved when the run started", () => {
  const saved = { role: "run", id: "3-x", orchestrator: "old-term", title: "#3 T", workflow: "Story", branch: "workflow/3-t", folder: "/w", strategy: "worktree", repoRoot: "/src/app", ticket: { number: 3, key: null }, projectId: "P", statusField: { id: "F" } };
  const props = reopenProps(JSON.stringify(saved), { role: "run", id: "3-x", workflow: "" }, "new-term");
  assert.ok(!("strategy" in props)); // a run saved before strategies went away
  assert.equal(props.repoRoot, "/src/app");
  assert.deepEqual(props.statusField, { id: "F" });
  assert.equal(props.workflow, "Story");
  assert.equal(props.orchestrator, "new-term");
});

test("a reopened run pane falls back to the partial props when nothing usable was saved", () => {
  const fallback = { role: "run", id: "3-x", workflow: "" };
  for (const bad of [null, "", "not json", "[]", JSON.stringify({ role: "other" })]) assert.deepEqual(reopenProps(bad, fallback, "t"), fallback);
});
