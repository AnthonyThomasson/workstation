import test from "node:test";
import assert from "node:assert/strict";
import { worktreeArgs, branchArgs, canMerge, finalSeen, shouldAutoPr, stageOf, optionFor, statusArgs, mergeSteps, runSteps, prArgs, prViewArgs, parsePrUrl, prNumber, parsePr } from "./finish.js";

test("canMerge needs the final reviewer seen and nobody live", () => {
  const ended = { live: false }, live = { live: true, status: "idle" };
  assert.equal(canMerge({ finalSeen: false, workers: [], reviewers: [] }), false);
  assert.equal(canMerge({ finalSeen: true, workers: [], reviewers: [ended] }), true);
  assert.equal(canMerge({ finalSeen: true, workers: [ended], reviewers: [ended] }), true);
  assert.equal(canMerge({ finalSeen: true, workers: [live], reviewers: [ended] }), false);
  assert.equal(canMerge({ finalSeen: true, workers: [ended], reviewers: [live] }), false);
  assert.equal(canMerge({ finalSeen: true, workers: [{ live: true, status: "done" }], reviewers: [] }), false);
  assert.equal(canMerge({ finalSeen: true }), true);
});

test("finalSeen remembers a final reviewer, in the rows or in what was saved", () => {
  assert.equal(finalSeen({ reviewers: [{ final: false }] }), false);
  assert.equal(finalSeen({ reviewers: [{ final: false }, { final: true, live: false }] }), true);
  assert.equal(finalSeen({ reviewers: [], saved: 1 }), true);
  assert.equal(finalSeen({ reviewers: [], saved: "1" }), true);
  assert.equal(finalSeen({ reviewers: [], saved: undefined }), false);
  assert.equal(finalSeen({ reviewers: [], saved: "" }), false);
  assert.equal(finalSeen({}), false);
});

test("stageOf follows the agents started", () => {
  assert.equal(stageOf({ workers: [], reviewers: [] }), 0);
  assert.equal(stageOf({ workers: [{}], reviewers: [] }), 1);
  assert.equal(stageOf({ workers: [{}], reviewers: [{}] }), 2);
});

test("optionFor matches status names loosely", () => {
  const options = [{ id: "a", name: "Todo" }, { id: "b", name: "In progress" }, { id: "c", name: "In-Review" }];
  assert.equal(optionFor(options, 1).id, "b");
  assert.equal(optionFor(options, 2).id, "c");
  assert.equal(optionFor([{ id: "a", name: "Todo" }], 1), null);
  assert.equal(optionFor(undefined, 1), null);
});

test("optionFor sets the Done status", () => {
  const options = [{ id: "a", name: "In progress" }, { id: "d", name: "Done" }, { id: "s", name: "Shipped" }];
  assert.equal(optionFor(options, 3).id, "d");
  assert.equal(optionFor([{ id: "a", name: "Todo" }], 3), null);
});

test("statusArgs sends the ids as variables", () => {
  const a = statusArgs({ projectId: "P", itemId: "I", fieldId: "F", optionId: "O" });
  assert.ok(a.includes("option=O") && a.includes("item=I") && a[0] === "api");
});

test("shouldAutoPr opens the pull request once, when Merge would be allowed and there is none", () => {
  const go = { ready: true, pr: null, tried: false, busy: null };
  assert.equal(shouldAutoPr(go), true);
  assert.equal(shouldAutoPr({ ...go, ready: false }), false);
  assert.equal(shouldAutoPr({ ...go, pr: { url: "u", state: "OPEN", number: 3 } }), false);
  assert.equal(shouldAutoPr({ ...go, tried: true }), false); // already tried, even across a reload or after a failure
  assert.equal(shouldAutoPr({ ...go, busy: "merge" }), false);
});

const ctx = { repoRoot: "/r", workDir: "/r-9-x", branch: "workflow/9-x", number: 12, status: { args: ["api", "graphql"] }, runDir: "/home/test/.herdr/workflow-runs/9-abc123" };
const names = (list) => list.map((s) => s.name);

test("mergeSteps runs in the order the ticket gives", () => {
  assert.deepEqual(names(mergeSteps(ctx)), ["tree-status", "fetch", "ahead", "pr-merge", "status", "remove-worktree", "delete-branch", "remove-run-files"]);
});

test("mergeSteps adds run-file cleanup after the other cleanup when runDir is given", () => {
  const runDir = "/home/test/.herdr/workflow-runs/9-abc123";
  const steps = mergeSteps({ ...ctx, runDir });
  assert.deepEqual(names(steps).slice(-3), ["remove-worktree", "delete-branch", "remove-run-files"]);
  assert.deepEqual(steps.at(-1), {
    name: "remove-run-files", cmd: "rm", args: ["-rf", runDir],
    fail: `Couldn't remove the run files ${runDir}.`, done: `removed the run files ${runDir}`,
  });
});

test("mergeSteps refuses missing or unsafe run folders", () => {
  const unsafe = [
    undefined, "", null,
    "/home/test/.herdr/workflow-runs",
    "/home/test/.herdr/workflow-runs/",
    "/home/test/.herdr/workflow-runs/.",
    "/home/test/.herdr/workflow-runs/..",
    "/home/test/.herdr/workflow-runs/9..abc",
    "/home/test/.herdr/workflow-runs/../other",
    "/home/test/.herdr/workflow-runs/9-abc/extra",
    "/home/test/.herdr/workflow-runs/9-abc/",
    "/tmp/not-run-files/9-abc",
    "relative/.herdr/workflow-runs/9-abc",
  ];
  for (const runDir of unsafe) {
    assert.equal(mergeSteps({ ...ctx, runDir }).some((s) => s.name === "remove-run-files"), false, String(runDir));
  }
});

test("mergeSteps checks the worktree and the branch, squash-merges the PR, and cleans up", () => {
  const s = Object.fromEntries(mergeSteps(ctx).map((x) => [x.name, x]));
  assert.deepEqual(s["tree-status"].args, ["-C", "/r-9-x", "status", "--porcelain"]);
  assert.ok(s["tree-status"].dirty.includes("/r-9-x"));
  assert.deepEqual(s.fetch.args, ["-C", "/r-9-x", "fetch", "origin", "+refs/heads/workflow/9-x:refs/remotes/origin/workflow/9-x"]);
  assert.deepEqual(s.ahead.args, ["-C", "/r-9-x", "rev-list", "origin/workflow/9-x..workflow/9-x"]);
  assert.ok(s.ahead.dirty.includes("origin/workflow/9-x"));
  assert.ok(s.ahead.dirty.includes("`git -C /r-9-x push origin workflow/9-x`"), "the message names the exact command");
  assert.equal(s["pr-merge"].cmd, "gh");
  assert.deepEqual(s["pr-merge"].args, ["pr", "merge", "12", "--squash"]);
  assert.equal(s["pr-merge"].cwd, "/r-9-x");
  assert.deepEqual(s["remove-worktree"].args, ["-C", "/r", "worktree", "remove", "/r-9-x"]);
  assert.deepEqual(s["delete-branch"].args, ["-C", "/r", "branch", "-D", "workflow/9-x"]);
});

test("mergeSteps never merges, switches, pushes, closes the issue, or bypasses protection", () => {
  const lines = mergeSteps(ctx).filter((x) => x.cmd).map((x) => `${x.cmd} ${x.args.join(" ")}`);
  for (const l of lines) {
    assert.ok(!/ (switch|checkout|push|issue)( |$)/.test(l), l);
    assert.ok(!/--admin|--auto| -d( |$)|--delete-branch/.test(l), l);
    assert.ok(!/ merge (--no-edit|workflow)/.test(l), l);
  }
  assert.ok(!lines.some((l) => l.startsWith("git -C /r ") && /fetch|status|rev-list/.test(l)), "no git in the repo folder while the worktree exists");
});

test("mergeSteps needs a pull request, unless it is already merged", () => {
  assert.throws(() => mergeSteps({ ...ctx, number: undefined }), /pull request/);
  assert.doesNotThrow(() => mergeSteps({ ...ctx, number: undefined, prMerged: true }));
});

test("mergeSteps leaves out the status when there is nothing to set, and warns when the option is missing", () => {
  assert.ok(!names(mergeSteps({ ...ctx, status: undefined })).includes("status"));
  const warn = mergeSteps({ ...ctx, status: { warn: "no Done option" } }).find((x) => x.name === "status");
  assert.equal(warn.warn, "no Done option");
});

test("mergeSteps skips the PR merge, fetch and ahead check when the PR is already merged", () => {
  const steps = mergeSteps({ ...ctx, prMerged: true });
  assert.deepEqual(names(steps), ["tree-status", "status", "remove-worktree", "delete-branch", "remove-run-files"]);
});

test("mergeSteps checks a merged PR's head commit against the local branch, before any cleanup", () => {
  const steps = mergeSteps({ ...ctx, prMerged: true, headOid: "0123456789abcdef" });
  assert.deepEqual(names(steps), ["tree-status", "fetch-pr-head", "not-in-pr", "status", "remove-worktree", "delete-branch", "remove-run-files"]);
  assert.deepEqual(steps.find((x) => x.name === "fetch-pr-head").args, ["-C", "/r-9-x", "fetch", "origin", "+refs/pull/12/head"]);
  const s = steps.find((x) => x.name === "not-in-pr");
  assert.deepEqual(s.args, ["-C", "/r-9-x", "rev-list", "0123456789abcdef..workflow/9-x"]);
  assert.ok(s.dirty.includes("git -C /r-9-x reset --hard 01234567"));
  assert.ok(!names(mergeSteps({ ...ctx, headOid: "0123456789abcdef" })).includes("not-in-pr"), "only for a PR that is already merged");
  assert.ok(!names(mergeSteps({ ...ctx, prMerged: true, headOid: "0123456789abcdef", branchExists: false })).includes("not-in-pr"));
});

test("mergeSteps fetches the merged PR's head from the repo folder when the worktree is gone, and only for a merged PR", () => {
  const f = mergeSteps({ ...ctx, prMerged: true, headOid: "0123456789abcdef", workDirExists: false }).find((x) => x.name === "fetch-pr-head");
  assert.deepEqual(f.args, ["-C", "/r", "fetch", "origin", "+refs/pull/12/head"]);
  assert.ok(!names(mergeSteps({ ...ctx, headOid: "0123456789abcdef" })).includes("fetch-pr-head"));
  assert.ok(!names(mergeSteps({ ...ctx, prMerged: true })).includes("fetch-pr-head"), "no head commit to compare, nothing to fetch");
});

test("mergeSteps skips the worktree steps when the folder is already gone, and asks origin from the repo folder", () => {
  const steps = mergeSteps({ ...ctx, workDirExists: false });
  assert.deepEqual(names(steps), ["fetch", "ahead", "pr-merge", "status", "prune-worktrees", "delete-branch", "remove-run-files"]);
  assert.deepEqual(steps[0].args.slice(0, 2), ["-C", "/r"]);
  assert.equal(steps.find((x) => x.name === "pr-merge").cwd, "/r");
});

test("mergeSteps skips the branch steps when the branch is already gone", () => {
  assert.deepEqual(names(mergeSteps({ ...ctx, branchExists: false })), ["tree-status", "pr-merge", "status", "remove-worktree", "remove-run-files"]);
  assert.deepEqual(names(mergeSteps({ ...ctx, workDirExists: false, branchExists: false })), ["pr-merge", "status", "prune-worktrees", "remove-run-files"]);
  assert.deepEqual(names(mergeSteps({ ...ctx, workDirExists: false, branchExists: false, prMerged: true })), ["status", "prune-worktrees", "remove-run-files"]);
});

test("worktreeArgs and branchArgs ask git whether the folder and the branch are still there", () => {
  assert.deepEqual(worktreeArgs("/r-9-x"), ["-C", "/r-9-x", "rev-parse", "--git-dir"]);
  assert.deepEqual(branchArgs("/r", "workflow/9-x"), ["-C", "/r", "rev-parse", "--verify", "--quiet", "refs/heads/workflow/9-x"]);
});

// A fake exec: answers by the step's args, records what ran.
const fake = (answers = {}) => {
  const ran = [];
  const exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    ran.push(line);
    const hit = Object.keys(answers).find((k) => line.includes(k));
    return { code: 0, stdout: "", stderr: "", ...(hit ? answers[hit] : {}) };
  };
  return { exec, ran };
};

test("runSteps runs every step in order and reports what it did", async () => {
  const f = fake();
  const r = await runSteps(mergeSteps(ctx), f.exec);
  assert.equal(f.ran.length, 8);
  assert.ok(f.ran[3].startsWith("gh pr merge 12 --squash"));
  assert.ok(f.ran[4].startsWith("gh api graphql"));
  assert.ok(f.ran[6].includes("branch -D workflow/9-x"));
  assert.ok(r.done.includes("merged pull request #12"));
  assert.deepEqual(r.warnings, []);
});

test("runSteps stops on an uncommitted worktree and does nothing else", async () => {
  const f = fake({ "r-9-x status": { stdout: " M a.js\n" } });
  await assert.rejects(runSteps(mergeSteps(ctx), f.exec), /\/r-9-x has uncommitted changes/);
  assert.deepEqual(f.ran, ["git -C /r-9-x status --porcelain"]);
});

test("runSteps stops when the branch is ahead of origin, before it merges anything", async () => {
  const f = fake({ "rev-list": { stdout: "abc123\n" } });
  await assert.rejects(runSteps(mergeSteps(ctx), f.exec), /has commits that origin\/workflow\/9-x doesn't/);
  assert.ok(!f.ran.some((l) => l.startsWith("gh ")));
  assert.ok(!f.ran.some((l) => l.includes("worktree remove") || l.includes("branch -D")));
});

test("runSteps stops when origin can't be reached for the check", async () => {
  const f = fake({ "fetch origin": { code: 128, stderr: "Could not resolve host" } });
  await assert.rejects(runSteps(mergeSteps(ctx), f.exec), /Couldn't fetch workflow\/9-x from origin\. Could not resolve host/);
  assert.ok(!f.ran.some((l) => l.startsWith("gh ")));
});

test("when GitHub refuses the merge its message is shown and nothing is cleaned up", async () => {
  const f = fake({ "pr merge": { code: 1, stderr: "Pull request is not mergeable: the base branch policy prohibits the merge" } });
  await assert.rejects(runSteps(mergeSteps(ctx), f.exec), (e) => /didn't merge pull request #12/.test(e.message) && /base branch policy prohibits/.test(e.message) && !/Already done/.test(e.message));
  assert.ok(!f.ran.some((l) => l.includes("graphql") || l.includes("worktree") || l.includes("branch -D") || l.startsWith("rm ")));
});

test("an already merged PR is not merged again, and the cleanup runs", async () => {
  const f = fake();
  const r = await runSteps(mergeSteps({ ...ctx, prMerged: true }), f.exec);
  assert.ok(!f.ran.some((l) => l.includes("pr merge") || l.includes("fetch")));
  assert.ok(f.ran.some((l) => l.includes("worktree remove")) && f.ran.some((l) => l.includes("branch -D")) && f.ran.some((l) => l.startsWith("rm -rf")));
  assert.ok(!r.done.some((d) => /merged pull request/.test(d)));
});

test("a merged PR with local commits it never took in stops before any cleanup", async () => {
  const f = fake({ "rev-list 0123456789abcdef..": { stdout: "abc\n" } });
  await assert.rejects(runSteps(mergeSteps({ ...ctx, prMerged: true, headOid: "0123456789abcdef" }), f.exec), /commits that the merged pull request doesn't/);
  assert.ok(!f.ran.some((l) => l.includes("graphql") || l.includes("worktree remove") || l.includes("branch -D") || l.startsWith("rm ")));
});

test("a merged PR whose head can't be fetched stops with a clear message before comparing or cleaning up", async () => {
  const f = fake({ "refs/pull/12/head": { code: 128, stderr: "Could not resolve host" } });
  await assert.rejects(runSteps(mergeSteps({ ...ctx, prMerged: true, headOid: "0123456789abcdef" }), f.exec), /Couldn't fetch the merged pull request #12 from origin.*Could not resolve host/);
  assert.ok(!f.ran.some((l) => l.includes("rev-list") || l.includes("graphql") || l.includes("worktree remove") || l.includes("branch -D") || l.startsWith("rm ")));
});

test("a failed status step says the PR is already merged", async () => {
  const f = fake({ graphql: { code: 1, stderr: "boom" } });
  await assert.rejects(runSteps(mergeSteps(ctx), f.exec), (e) => /Couldn't set the ticket's status/.test(e.message) && /merged pull request #12/.test(e.message));
  assert.ok(!f.ran.some((l) => l.includes("worktree remove")));
});

test("a missing Done option warns once and carries on", async () => {
  const f = fake();
  const r = await runSteps(mergeSteps({ ...ctx, status: { warn: "no Done option" } }), f.exec);
  assert.deepEqual(r.warnings, ["no Done option"]);
  assert.ok(f.ran.some((l) => l.includes("branch -D")));
});

test("prArgs and the URL", () => {
  assert.deepEqual(prArgs({ branch: "b", title: "T", number: 4 }).slice(-4), ["--title", "#4 T", "--body", "Closes #4"]);
  assert.equal(prArgs({ branch: "b", title: "T" })[5], "T");
  const url = parsePrUrl("Creating...\nhttps://github.com/o/r/pull/12\n");
  assert.equal(url, "https://github.com/o/r/pull/12");
  assert.equal(prNumber(url), "12");
  assert.equal(parsePrUrl("nothing"), null);
});

test("parsePr", () => {
  assert.deepEqual(parsePr('{"url":"https://github.com/o/r/pull/3","state":"merged","number":3,"headRefOid":"abc123"}'), { url: "https://github.com/o/r/pull/3", state: "MERGED", number: 3, headOid: "abc123" });
  assert.equal(parsePr('{"url":"https://github.com/o/r/pull/3","state":"open","number":3}').headOid, undefined);
  assert.ok(prViewArgs("b").join(" ").includes("headRefOid"));
  assert.equal(parsePr("no pull requests found"), null);
});

// The same steps against real git: an origin, a repo folder on main, and a ticket worktree. gh is stubbed (it would reach GitHub).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs git and rm for real; gh answers from `gh` (default: success) and is recorded in `ghRan`.
const realWith = (ghRan, gh = () => ({ code: 0, stdout: "", stderr: "" })) => async (cmd, args, opts) => {
  if (cmd === "gh") { ghRan.push({ args, cwd: opts?.cwd }); return gh(args); }
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: opts?.cwd });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
function repoWithTicket() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "merge-")));
  const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  const origin = join(base, "origin.git"), repoRoot = join(base, "repo"), workDir = join(base, "repo-9-x");
  const runDir = join(base, ".herdr", "workflow-runs", "9-abc123");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "worker.md"), "run files\n");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repoRoot]);
  git(repoRoot, "remote", "add", "origin", origin);
  writeFileSync(join(repoRoot, "a.txt"), "a\n"); git(repoRoot, "add", "."); git(repoRoot, "commit", "-qm", "first"); git(repoRoot, "push", "-q", "origin", "main");
  git(repoRoot, "worktree", "add", "-q", "-b", "workflow/9-x", workDir);
  writeFileSync(join(workDir, "b.txt"), "b\n"); git(workDir, "add", "."); git(workDir, "commit", "-qm", "work");
  git(workDir, "push", "-q", "-u", "origin", "workflow/9-x"); // the automatic PR pushes the branch
  return { git, origin, repoRoot, workDir, runDir, ctx: { repoRoot, workDir, branch: "workflow/9-x", number: 12, runDir } };
}
const head = (w) => w.git(w.repoRoot, "rev-parse", "HEAD").trim();

test("merge steps, run for real: check, merge through the PR, clean up, and leave the main checkout alone", async () => {
  const w = repoWithTicket();
  const before = head(w), ran = [];
  const r = await runSteps(mergeSteps(w.ctx), realWith(ran));
  assert.equal(r.done.length, 4); // merge the PR, remove worktree, delete branch, remove run files
  assert.deepEqual(ran.map((x) => x.args.slice(0, 4)), [["pr", "merge", "12", "--squash"]]);
  assert.equal(ran[0].cwd, w.workDir);
  assert.ok(!existsSync(w.workDir));
  assert.ok(!existsSync(w.runDir));
  assert.equal(w.git(w.repoRoot, "branch", "--list", "workflow/9-x").trim(), "");
  assert.equal(head(w), before, "the main checkout's HEAD didn't move");
  assert.equal(w.git(w.repoRoot, "branch", "--show-current").trim(), "main");
  assert.ok(w.git(w.origin, "branch", "--list", "workflow/9-x").includes("workflow/9-x"), "the remote branch is left alone");
  assert.equal(w.git(w.origin, "log", "--format=%s", "main").trim(), "first", "nothing was pushed to the default branch");
});

test("merge steps, run for real: uncommitted changes in the worktree stop everything", async () => {
  const w = repoWithTicket();
  writeFileSync(join(w.workDir, "c.txt"), "left over\n");
  const ran = [];
  await assert.rejects(runSteps(mergeSteps(w.ctx), realWith(ran)), /has uncommitted changes/);
  assert.equal(ran.length, 0);
  assert.ok(existsSync(w.workDir) && existsSync(w.runDir));
  assert.equal(w.git(w.workDir, "log", "--format=%s").trim().split("\n")[0], "work", "nothing was committed for the person");
});

test("merge steps, run for real: a branch ahead of origin stops everything", async () => {
  const w = repoWithTicket();
  writeFileSync(join(w.workDir, "c.txt"), "unpushed\n"); w.git(w.workDir, "add", "."); w.git(w.workDir, "commit", "-qm", "unpushed");
  const ran = [];
  await assert.rejects(runSteps(mergeSteps(w.ctx), realWith(ran)), /has commits that origin\/workflow\/9-x doesn't/);
  assert.equal(ran.length, 0);
  assert.ok(existsSync(w.workDir) && existsSync(w.runDir));
  assert.equal(w.git(w.repoRoot, "branch", "--list", "workflow/9-x").includes("workflow/9-x"), true);
});

test("merge steps, run for real: GitHub refusing leaves everything where it was", async () => {
  const w = repoWithTicket();
  const ran = [];
  const refuse = () => ({ code: 1, stdout: "", stderr: "X Pull request #12 is not mergeable: required status checks are failing" });
  await assert.rejects(runSteps(mergeSteps(w.ctx), realWith(ran, refuse)), /required status checks are failing/);
  assert.ok(existsSync(w.workDir) && existsSync(w.runDir));
  assert.equal(w.git(w.repoRoot, "branch", "--list", "workflow/9-x").includes("workflow/9-x"), true);
});

test("merge steps, run for real: an already merged PR (remote branch deleted) still cleans up", async () => {
  const w = repoWithTicket();
  w.git(w.origin, "branch", "-D", "workflow/9-x"); // GitHub deleted the branch on merge
  const ran = [];
  const r = await runSteps(mergeSteps({ ...w.ctx, prMerged: true }), realWith(ran));
  assert.equal(ran.length, 0, "no gh pr merge");
  assert.ok(r.done.length >= 3);
  assert.ok(!existsSync(w.workDir) && !existsSync(w.runDir));
  assert.equal(w.git(w.repoRoot, "branch", "--list", "workflow/9-x").trim(), "");
});

test("merge steps, run for real: a single-branch clone still gets origin/<branch> updated by the fetch", async () => {
  const w = repoWithTicket();
  const clone = join(w.repoRoot, "..", "single");
  execFileSync("git", ["clone", "-q", "--single-branch", "-b", "main", w.origin, clone]);
  w.git(clone, "worktree", "add", "-q", "-b", "workflow/9-x", join(clone, "..", "single-wt"), "origin/main");
  const wt = join(clone, "..", "single-wt");
  assert.equal(spawnSync("git", ["-C", clone, "rev-parse", "--verify", "--quiet", "origin/workflow/9-x"]).status, 1, "starts without the remote branch ref");
  await runSteps(mergeSteps({ repoRoot: clone, workDir: wt, branch: "workflow/9-x", number: 12 }).slice(0, 2), realWith([]));
  assert.equal(spawnSync("git", ["-C", clone, "rev-parse", "--verify", "--quiet", "origin/workflow/9-x"]).status, 0, "the fetch made origin/<branch>");
});

test("merge steps, run for real: a merged PR with a local commit beyond its head stops, and a clean one cleans up", async () => {
  const w = repoWithTicket();
  const oid = w.git(w.workDir, "rev-parse", "HEAD").trim();
  w.git(w.origin, "update-ref", "refs/pull/12/head", oid); // GitHub keeps the PR's head here
  writeFileSync(join(w.workDir, "late.txt"), "late\n"); w.git(w.workDir, "add", "."); w.git(w.workDir, "commit", "-qm", "late");
  await assert.rejects(runSteps(mergeSteps({ ...w.ctx, prMerged: true, headOid: oid }), realWith([])), /commits that the merged pull request doesn't/);
  assert.ok(existsSync(w.workDir) && existsSync(w.runDir));
  w.git(w.workDir, "reset", "-q", "--hard", oid);
  await runSteps(mergeSteps({ ...w.ctx, prMerged: true, headOid: oid }), realWith([]));
  assert.ok(!existsSync(w.workDir) && !existsSync(w.runDir));
});

test("merge steps, run for real: the PR head exists only on the remote (pushed on GitHub, branch deleted) and cleanup still succeeds", async () => {
  const w = repoWithTicket();
  // Someone pushed to the PR branch on GitHub: a commit this clone never fetched, then the PR merged and the branch was deleted.
  const other = join(w.repoRoot, "..", "other");
  execFileSync("git", ["clone", "-q", "-b", "workflow/9-x", w.origin, other]);
  writeFileSync(join(other, "gh.txt"), "edited on GitHub\n"); w.git(other, "add", "."); w.git(other, "commit", "-qm", "edit on github");
  const oid = w.git(other, "rev-parse", "HEAD").trim();
  w.git(other, "push", "-q", "origin", `HEAD:refs/pull/12/head`);
  w.git(w.origin, "branch", "-D", "workflow/9-x");
  assert.notEqual(spawnSync("git", ["-C", w.workDir, "cat-file", "-e", `${oid}^{commit}`]).status, 0, "the head commit is not a local object");
  // Without the fetch, rev-list exits 128 on the unknown commit:
  assert.equal(spawnSync("git", ["-C", w.workDir, "rev-list", `${oid}..workflow/9-x`]).status, 128);
  const r = await runSteps(mergeSteps({ ...w.ctx, prMerged: true, headOid: oid }), realWith([]));
  assert.ok(r.done.some((d) => /deleted/.test(d)));
  assert.ok(!existsSync(w.workDir) && !existsSync(w.runDir));
  assert.equal(w.git(w.repoRoot, "branch", "--list", "workflow/9-x").trim(), "");
});

test("merge steps, run for real: a merged PR whose head can't be fetched stops and cleans nothing up", async () => {
  const w = repoWithTicket();
  const oid = w.git(w.workDir, "rev-parse", "HEAD").trim(); // origin has no refs/pull/12/head
  await assert.rejects(runSteps(mergeSteps({ ...w.ctx, prMerged: true, headOid: oid }), realWith([])), /Couldn't fetch the merged pull request #12/);
  assert.ok(existsSync(w.workDir) && existsSync(w.runDir));
});

test("merge steps, run for real: a second Merge after everything is done is harmless", async () => {
  const w = repoWithTicket();
  await runSteps(mergeSteps(w.ctx), realWith([]));
  const again = await runSteps(mergeSteps({ ...w.ctx, prMerged: true, workDirExists: false, branchExists: false }), realWith([]));
  assert.deepEqual(again.warnings, []);
  assert.ok(!existsSync(w.runDir), "removing an already removed run folder is harmless");
});

test("merge steps, run for real: a retry with the worktree gone but the branch kept", async () => {
  const w = repoWithTicket();
  w.git(w.repoRoot, "worktree", "remove", w.workDir);
  const ran = [];
  const r = await runSteps(mergeSteps({ ...w.ctx, workDirExists: false }), realWith(ran));
  assert.equal(ran[0].cwd, w.repoRoot, "gh runs in the repo folder when the worktree is gone");
  assert.ok(r.done.some((d) => /merged pull request/.test(d)) && r.done.some((d) => /deleted/.test(d)));
  assert.ok(!existsSync(w.runDir));
  assert.equal(w.git(w.repoRoot, "branch", "--list", "workflow/9-x").trim(), "");
});

test("merge steps, run for real: a retry after the PR merged but the cleanup stopped", async () => {
  const w = repoWithTicket();
  const r = await runSteps(mergeSteps({ ...w.ctx, prMerged: true }), realWith([]));
  assert.ok(r.done.some((d) => /deleted/.test(d)));
  assert.ok(!existsSync(w.workDir) && !existsSync(w.runDir));
});

test("prArgs takes a body of its own, for a task with no GitHub issue to close", () => {
  const a = prArgs({ branch: "b", title: "T", number: 4, body: "Local task #4: T" });
  assert.deepEqual(a.slice(-4), ["--title", "#4 T", "--body", "Local task #4: T"]);
  assert.doesNotMatch(a.join(" "), /Closes/);
  assert.equal(prArgs({ branch: "b", title: "T", number: 4, body: "" }).at(-1), "", "an empty body is still the caller's");
});

test("mergeSteps can move a local task's file to done/ instead of setting a project status", async () => {
  const moved = [];
  const steps = mergeSteps({ ...ctx, status: { move: async () => { moved.push("done"); } } });
  assert.deepEqual(names(steps), ["tree-status", "fetch", "ahead", "pr-merge", "status", "remove-worktree", "delete-branch", "remove-run-files"]);
  const { exec } = fake();
  const out = await runSteps(steps, exec);
  assert.deepEqual(moved, ["done"]);
  assert.match(out.done.join(";"), /moved the task to done/);
});

test("runSteps: a step can be code (run) and a check can read the output (check)", async () => {
  const { exec } = fake();
  const ran = [];
  await runSteps([{ name: "a", run: async (e) => { ran.push(typeof e); } }], exec);
  assert.deepEqual(ran, ["function"]);
  await assert.rejects(runSteps([{ name: "ok", cmd: "x", args: [], done: "did x" }, { name: "b", run: async () => { throw new Error("nope"); } }], exec), /^Error: nope Already done: did x\.$/);
  const check = { name: "c", cmd: "x", args: [], fail: "Couldn't.", check: (s) => (s.trim() === "main" ? null : `on ${s.trim()}`) };
  await runSteps([check], fake({ x: { stdout: "main\n" } }).exec);
  await assert.rejects(runSteps([check], fake({ x: { stdout: "dev\n" } }).exec), /^Error: on dev$/);
  await assert.rejects(runSteps([check], fake({ x: { code: 1, stderr: "bad" } }).exec), /Couldn't\. bad/);
});
