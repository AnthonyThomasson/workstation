import test from "node:test";
import assert from "node:assert/strict";
import { canMerge, finalSeen, stageOf, optionFor, statusArgs, defaultBranch, mergeSteps, runSteps, prArgs, parsePrUrl, prNumber, parsePr } from "./finish.js";

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

test("optionFor uses the configured names, falling back to the defaults", () => {
  const options = [{ id: "a", name: "Doing" }, { id: "b", name: "Checking" }, { id: "c", name: "In progress" }];
  const statuses = { inProgress: "Doing", inReview: "Checking" };
  assert.equal(optionFor(options, 1, statuses).id, "a");
  assert.equal(optionFor(options, 2, statuses).id, "b");
  assert.equal(optionFor(options, 1, {}).id, "c");
  assert.equal(optionFor(options, 1, null).id, "c");
  assert.equal(optionFor([{ id: "x", name: "In Review" }], 2, { inProgress: "Doing" }).id, "x");
});

test("optionFor sets the Done status, default Done", () => {
  const options = [{ id: "a", name: "In progress" }, { id: "d", name: "Done" }, { id: "s", name: "Shipped" }];
  assert.equal(optionFor(options, 3).id, "d");
  assert.equal(optionFor(options, 3, { done: "Shipped" }).id, "s");
  assert.equal(optionFor(options, 3, { done: "" }).id, "d");
  assert.equal(optionFor([{ id: "a", name: "Todo" }], 3, {}), null);
});

test("statusArgs sends the ids as variables", () => {
  const a = statusArgs({ projectId: "P", itemId: "I", fieldId: "F", optionId: "O" });
  assert.ok(a.includes("option=O") && a.includes("item=I") && a[0] === "api");
});

test("defaultBranch", () => {
  assert.equal(defaultBranch("origin/main\n"), "main");
  assert.equal(defaultBranch(""), null);
});

const ctx = { repoRoot: "/r", workDir: "/r-9-x", branch: "workflow/9-x", base: "main", number: 9, status: { args: ["api", "graphql"] } };
const names = (list) => list.flatMap((s) => [s.name, ...(s.ifOutput ?? []).map((x) => `>${x.name}`)]);

test("mergeSteps runs in the order the ticket gives", () => {
  assert.deepEqual(names(mergeSteps(ctx)), ["tree-status", ">commit-add", ">commit", "repo-clean", "switch", "merge", "push", "status", "close-issue", "remove-worktree", "delete-branch"]);
});

test("mergeSteps commits leftovers, checks the repo folder, merges with an abort, and pushes the default branch", () => {
  const s = Object.fromEntries(mergeSteps(ctx).map((x) => [x.name, x]));
  assert.deepEqual(s["tree-status"].args, ["-C", "/r-9-x", "status", "--porcelain"]);
  assert.deepEqual(s["tree-status"].ifOutput.map((x) => x.args.slice(2, 3)[0]), ["add", "commit"]);
  assert.match(s["tree-status"].ifOutput[1].args.join(" "), /#9/);
  assert.ok(s["repo-clean"].dirty.includes("/r"));
  assert.deepEqual(s.switch.args, ["-C", "/r", "switch", "main"]);
  assert.deepEqual(s.merge.args, ["-C", "/r", "merge", "--no-edit", "workflow/9-x"]);
  assert.deepEqual(s.merge.abort, { cmd: "git", args: ["-C", "/r", "merge", "--abort"] });
  assert.deepEqual(s.push.args, ["-C", "/r", "push", "origin", "main"]);
  assert.equal(s["close-issue"].cmd, "gh");
  assert.deepEqual(s["close-issue"].args, ["issue", "close", "9"]);
  assert.equal(s["close-issue"].cwd, "/r");
  assert.deepEqual(s["remove-worktree"].args, ["-C", "/r", "worktree", "remove", "/r-9-x"]);
  assert.deepEqual(s["delete-branch"].args, ["-C", "/r", "branch", "-d", "workflow/9-x"]);
});

test("mergeSteps leaves out the status and the issue when there is nothing to set or close", () => {
  assert.ok(!names(mergeSteps({ ...ctx, status: undefined, number: null })).some((n) => n === "status" || n === "close-issue"));
  const warn = mergeSteps({ ...ctx, status: { warn: "no Done option" } }).find((x) => x.name === "status");
  assert.equal(warn.warn, "no Done option");
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
  assert.equal(f.ran.length, 9);
  assert.ok(f.ran[3].includes("merge --no-edit"));
  assert.ok(r.done.includes("merged workflow/9-x into main"));
  assert.deepEqual(r.warnings, []);
});

test("runSteps commits the ticket worktree only when it has changes", async () => {
  const f = fake({ "r-9-x status": { stdout: " M a.js\n" } });
  await runSteps(mergeSteps(ctx), f.exec);
  assert.ok(f.ran.some((l) => l.includes("r-9-x add -A")));
  assert.ok(f.ran.some((l) => l.includes("r-9-x commit")));
  const clean = fake();
  await runSteps(mergeSteps(ctx), clean.exec);
  assert.ok(!clean.ran.some((l) => l.includes(" commit ")));
});

test("runSteps stops on a dirty repo folder and says nothing has happened to the branch", async () => {
  const f = fake({ "-C /r status": { stdout: " M x\n" } });
  await assert.rejects(runSteps(mergeSteps(ctx), f.exec), /\/r has uncommitted changes/);
  assert.ok(!f.ran.some((l) => l.includes("switch")));
});

test("a failed merge aborts and says which steps already happened", async () => {
  const f = fake({ "merge --no-edit": { code: 1, stderr: "CONFLICT" } });
  await assert.rejects(runSteps(mergeSteps(ctx), f.exec), (e) => /didn't merge into main/.test(e.message) && /CONFLICT/.test(e.message) && /switched \/r to main/.test(e.message));
  assert.ok(f.ran.some((l) => l.includes("merge --abort")));
  assert.ok(!f.ran.some((l) => l.includes("push")));
});

test("a failed push says the merge already happened locally", async () => {
  const f = fake({ "push origin main": { code: 1, stderr: "rejected" } });
  await assert.rejects(runSteps(mergeSteps(ctx), f.exec), (e) => /rejected/.test(e.message) && /merged workflow\/9-x into main/.test(e.message));
  assert.ok(!f.ran.some((l) => l.includes("issue close")));
});

test("a missing Done option warns once and carries on", async () => {
  const f = fake();
  const r = await runSteps(mergeSteps({ ...ctx, status: { warn: "no Done option" } }), f.exec);
  assert.deepEqual(r.warnings, ["no Done option"]);
  assert.ok(f.ran.some((l) => l.includes("branch -d")));
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
  assert.deepEqual(parsePr('{"url":"https://github.com/o/r/pull/3","state":"merged","number":3}'), { url: "https://github.com/o/r/pull/3", state: "MERGED", number: 3 });
  assert.equal(parsePr("no pull requests found"), null);
});

// The same steps against real git: an origin, a repo folder on main, and a ticket worktree with a leftover edit.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const real = async (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: opts?.cwd });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
function repoWithTicket() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "merge-")));
  const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  const origin = join(base, "origin.git"), repoRoot = join(base, "repo"), workDir = join(base, "repo-9-x");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repoRoot]);
  git(repoRoot, "remote", "add", "origin", origin);
  writeFileSync(join(repoRoot, "a.txt"), "a\n"); git(repoRoot, "add", "."); git(repoRoot, "commit", "-qm", "first"); git(repoRoot, "push", "-q", "origin", "main");
  git(repoRoot, "worktree", "add", "-q", "-b", "workflow/9-x", workDir);
  writeFileSync(join(workDir, "b.txt"), "b\n"); git(workDir, "add", "."); git(workDir, "commit", "-qm", "work");
  writeFileSync(join(workDir, "c.txt"), "left over\n");
  return { git, origin, repoRoot, workDir, ctx: { repoRoot, workDir, branch: "workflow/9-x", base: "main" } };
}

test("merge steps, run for real: commit, merge, push, clean up", async () => {
  const w = repoWithTicket();
  const r = await runSteps(mergeSteps(w.ctx), real);
  assert.equal(r.done.length, 6); // commit, switch, merge, push, remove worktree, delete branch
  assert.ok(existsSync(join(w.repoRoot, "c.txt")), "the leftover edit was committed and merged");
  assert.ok(!existsSync(w.workDir));
  assert.equal(w.git(w.repoRoot, "branch", "--list", "workflow/9-x").trim(), "");
  assert.equal(w.git(w.origin, "log", "--format=%s", "main").split("\n").includes("work"), true);
  assert.equal(w.git(w.repoRoot, "rev-parse", "HEAD").trim(), w.git(w.origin, "rev-parse", "main").trim());
});

test("merge steps, run for real: a conflict aborts and leaves the repo clean", async () => {
  const w = repoWithTicket();
  writeFileSync(join(w.repoRoot, "b.txt"), "other\n"); w.git(w.repoRoot, "add", "."); w.git(w.repoRoot, "commit", "-qm", "clash");
  await assert.rejects(runSteps(mergeSteps(w.ctx), real), /didn't merge into main/);
  assert.equal(w.git(w.repoRoot, "status", "--porcelain").trim(), "");
  assert.ok(existsSync(w.workDir), "nothing was removed");
});
