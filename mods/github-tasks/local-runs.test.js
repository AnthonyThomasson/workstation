import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSteps } from "./finish.js";
import { defaultBranchOf, localMergeSteps, localPrBody, moveToStage, squashMessage } from "./local-runs.js";
import { makeLocalTasks } from "./local-tasks.js";

// --- stage moves -------------------------------------------------------------------------------------------------

// A Map as the file system, in the shape local-tasks.js wants.
function memoryIo(files = {}) {
  const map = new Map(Object.entries(files));
  return {
    map,
    list: async (dir) => [...map.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1)),
    read: async (p) => map.get(p) ?? null,
    write: async (p, t) => { map.set(p, t); },
    remove: async (p) => { map.delete(p); },
    mkdir: async () => {},
  };
}
const dirOf = (folder) => `/h/.herdr/tasks/-r/${folder}`;
const taskText = "id: 7\ntitle: Fix login\ndescription: |\n  It breaks.\nlabels:\n  - bug\ncreatedAt: 2026-11-08T10:00:00Z\n";
const store = () => {
  const io = memoryIo({ [`${dirOf("up-next")}/7-fix-login.yml`]: taskText });
  return { io, tasks: makeLocalTasks({ io, root: "/r", home: "/h" }) };
};
const folders = (io) => [...io.map.keys()].map((p) => p.replace("/h/.herdr/tasks/-r/", ""));

test("the run's stages move the task's file: In Progress, In Review, then Done", async () => {
  const { io, tasks } = store();
  assert.equal((await moveToStage(tasks, 7, 1)).folder, "in-progress");
  assert.deepEqual(folders(io), ["in-progress/7-fix-login.yml"]);
  await moveToStage(tasks, 7, 2);
  assert.deepEqual(folders(io), ["in-review/7-fix-login.yml"]);
  await moveToStage(tasks, 7, 3);
  assert.deepEqual(folders(io), ["done/7-fix-login.yml"]);
  assert.match(io.map.get(`${dirOf("done")}/7-fix-login.yml`), /title: Fix login/, "the file's text comes along");
});

test("moving a task to the stage it is in changes nothing, and a missing task says so", async () => {
  const { io, tasks } = store();
  await moveToStage(tasks, 7, 1);
  await moveToStage(tasks, 7, 1);
  assert.deepEqual(folders(io), ["in-progress/7-fix-login.yml"]);
  await assert.rejects(moveToStage(tasks, 99, 1), /no task #99/);
  await assert.rejects(moveToStage(tasks, 7, 0), /stage/);
});

// --- pull request body ---------------------------------------------------------------------------------------------

test("the pull request body describes the local task and doesn't close an issue", () => {
  const body = localPrBody({ id: 7, title: "Fix login", description: "It breaks.\nOn /404.", labels: ["bug", "ui"] });
  assert.match(body, /^Local task 7: Fix login/);
  assert.doesNotMatch(body, /#/, "GitHub would link a # to an unrelated issue");
  assert.match(body, /It breaks\.\nOn \/404\./);
  assert.match(body, /Labels: bug, ui/);
  assert.doesNotMatch(body, /Closes/);
});

test("the pull request body copes with a task with no description or labels, and with no task at all", () => {
  assert.equal(localPrBody({ id: 7, title: "Fix login", description: "", labels: [] }), "Local task 7: Fix login");
  assert.equal(localPrBody(null, { id: 7, title: "Fix login" }), "Local task 7: Fix login");
});

test("the squash commit is '<title> (#<id>)'", () => {
  assert.equal(squashMessage("Fix login", 7), "Fix login (#7)");
  assert.equal(squashMessage("  Fix\nlogin  ", 7), "Fix login (#7)");
});

// --- local Merge: the steps with a fake exec -----------------------------------------------------------------------------

const ctx = {
  repoRoot: "/r", workDir: "/r-7-fix-login", branch: "workflow/7-fix-login", defaultBranch: "main", message: "Fix login (#7)",
  runDir: "/home/test/.herdr/workflow-runs/7-abc", status: { move: async () => {} },
};
const names = (list) => list.map((s) => s.name);
const line = (s) => `${s.cmd} ${s.args.join(" ")}`;

test("local Merge checks first, then squashes, commits, moves the task, and cleans up", () => {
  assert.deepEqual(names(localMergeSteps(ctx)), ["tree-status", "main-branch", "main-status", "squash", "commit", "status", "remove-worktree", "delete-branch", "remove-run-files"]);
});

test("local Merge never pushes, fetches or touches a remote, and never leaves the main checkout's branch", () => {
  const lines = localMergeSteps(ctx).filter((s) => s.cmd).map(line);
  for (const l of lines) assert.doesNotMatch(l, /\b(push|fetch|pull|checkout|switch|gh)\b/, l);
  assert.ok(lines.includes("git -C /r branch -D workflow/7-fix-login"));
  assert.ok(lines.includes("git -C /r worktree remove /r-7-fix-login"));
});

test("local Merge needs to know the default branch", () => {
  assert.throws(() => localMergeSteps({ ...ctx, defaultBranch: null }), /default branch/);
  assert.doesNotThrow(() => localMergeSteps({ ...ctx, defaultBranch: null, branchExists: false }), "nothing to merge once the branch is gone");
});

test("local Merge leaves out the worktree check once the folder is gone, and everything but the cleanup once the branch is", () => {
  assert.deepEqual(names(localMergeSteps({ ...ctx, workDirExists: false })), ["main-branch", "main-status", "squash", "commit", "status", "prune-worktrees", "delete-branch", "remove-run-files"]);
  assert.deepEqual(names(localMergeSteps({ ...ctx, branchExists: false })), ["status", "remove-worktree", "remove-run-files"]);
});

test("local Merge leaves out the task step when there is nothing to move, and warns when the task is missing", () => {
  assert.ok(!names(localMergeSteps({ ...ctx, status: undefined })).includes("status"));
  assert.equal(localMergeSteps({ ...ctx, status: { warn: "no task" } }).find((s) => s.name === "status").warn, "no task");
});

// A fake exec answering by the command line; the rest succeeds with no output.
const fake = (answers = {}) => {
  answers = { "branch --show-current": { stdout: "main\n" }, ...answers };
  const ran = [];
  const exec = async (cmd, args) => {
    const l = `${cmd} ${args.join(" ")}`;
    ran.push(l);
    const hit = Object.entries(answers).find(([k]) => l.includes(k));
    const a = typeof hit?.[1] === "function" ? hit[1]() : hit?.[1];
    return { code: 0, stdout: "", stderr: "", ...a };
  };
  return { exec, ran };
};

test("local Merge refuses, running nothing that changes anything, when the ticket worktree has uncommitted changes", async () => {
  const { exec, ran } = fake({ "-C /r-7-fix-login status": { stdout: " M a.txt\n?? b.txt\n" } });
  await assert.rejects(runSteps(localMergeSteps(ctx), exec), (e) => /\/r-7-fix-login has uncommitted changes/.test(e.message) && /a\.txt/.test(e.message) && !/Already done/.test(e.message));
  assert.equal(ran.length, 1);
});

test("local Merge refuses unless the main checkout is on the default branch", async () => {
  for (const branch of ["feature\n", "\n"]) { // a detached HEAD prints nothing
    const { exec, ran } = fake({ "branch --show-current": { stdout: branch } });
    await assert.rejects(runSteps(localMergeSteps(ctx), exec), /main checkout \/r is on .*main/);
    assert.ok(!ran.some((l) => /merge --squash|commit/.test(l)));
  }
});

test("local Merge refuses when the main checkout has uncommitted changes, and names them", async () => {
  const { exec, ran } = fake({ "-C /r status": { stdout: "?? .herdr/tasks/tasks.json\n" } });
  await assert.rejects(runSteps(localMergeSteps(ctx), exec), (e) => /\/r has uncommitted changes/.test(e.message) && /tasks\.json/.test(e.message));
  assert.ok(!ran.some((l) => /merge --squash|commit/.test(l)));
});

test("local Merge squashes the ticket branch into the main checkout and commits it as '<title> (#<id>)'", async () => {
  const moved = [];
  const { exec, ran } = fake({ "diff --cached --quiet": { code: 1 } });
  const out = await runSteps(localMergeSteps({ ...ctx, status: { move: async () => { moved.push("done"); } } }), exec);
  assert.ok(ran.includes("git -C /r merge --squash workflow/7-fix-login"));
  assert.ok(ran.includes("git -C /r commit -q -m Fix login (#7)"));
  assert.deepEqual(moved, ["done"]);
  assert.ok(ran.indexOf("git -C /r commit -q -m Fix login (#7)") < ran.indexOf("git -C /r worktree remove /r-7-fix-login"), "cleanup comes last");
  assert.match(out.done.join("; "), /moved the task to done/);
});

test("local Merge pressed again after the commit went in doesn't commit twice", async () => {
  const { exec, ran } = fake({ "diff --cached --quiet": { code: 0 } }); // nothing staged
  await runSteps(localMergeSteps(ctx), exec);
  assert.ok(!ran.some((l) => / commit /.test(l)));
});

test("a squash conflict lists the files, puts the main checkout back, and cleans nothing up", async () => {
  const moved = [];
  const { exec, ran } = fake({
    "merge --squash": { code: 1, stdout: "CONFLICT (content): Merge conflict in a.txt\n", stderr: "" },
    "--diff-filter=U": { stdout: "a.txt\nsrc/b.js\n" },
  });
  await assert.rejects(runSteps(localMergeSteps({ ...ctx, status: { move: async () => { moved.push(1); } } }), exec), (e) => {
    assert.match(e.message, /a\.txt/);
    assert.match(e.message, /src\/b\.js/);
    assert.match(e.message, /main checkout is back as it was/);
    return true;
  });
  assert.ok(ran.includes("git -C /r reset --merge"));
  assert.ok(ran.indexOf("git -C /r reset --merge") > ran.findIndex((l) => l.includes("--diff-filter=U")), "the files are read before they are reset away");
  assert.ok(!ran.some((l) => /worktree|branch -D|rm -rf|commit/.test(l)));
  assert.deepEqual(moved, []);
});

test("if putting the main checkout back fails, that is said", async () => {
  const { exec } = fake({ "merge --squash": { code: 1, stderr: "boom" }, "reset --merge": { code: 1, stderr: "no" } });
  await assert.rejects(runSteps(localMergeSteps(ctx), exec), /couldn't put .* back/i);
});

test("a failed commit puts the main checkout back too", async () => {
  const { exec, ran } = fake({ "diff --cached --quiet": { code: 1 }, " commit ": { code: 1, stderr: "hook said no" } });
  await assert.rejects(runSteps(localMergeSteps(ctx), exec), /hook said no/);
  assert.ok(ran.includes("git -C /r reset --merge"));
  assert.ok(!ran.some((l) => /worktree remove|branch -D/.test(l)));
});

// --- local Merge: real git ----------------------------------------------------------------------------------------

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@t"];
const realExec = async (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return { code: r.status ?? 127, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const realGit = (cwd, ...args) => realExec("git", ["-C", cwd, ...args]);

// A repo with no remote: a.txt on main, a ticket worktree on workflow/7-fix-login with a commit that edits a.txt and adds c.txt.
function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lr-")));
  const repo = join(dir, "app");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  git(repo, "add", "."); git(repo, ...ident, "commit", "-q", "-m", "first");
  const workDir = join(dir, "app-7-fix-login");
  git(repo, "worktree", "add", "-q", "-b", "workflow/7-fix-login", workDir);
  writeFileSync(join(workDir, "a.txt"), "one\ntwo\nthree\nfour\n");
  writeFileSync(join(workDir, "c.txt"), "new\n");
  git(workDir, "add", "."); git(workDir, ...ident, "commit", "-q", "-m", "work 1");
  git(workDir, ...ident, "commit", "-q", "--allow-empty", "-m", "work 2");
  const runDir = join(dir, ".herdr", "workflow-runs", "7-abc");
  mkdirSync(runDir, { recursive: true });
  return { dir, repo, workDir, runDir, branch: "workflow/7-fix-login", defaultBranch: "main", message: "Fix login (#7)" };
}

test("real git: Merge squashes the work into main as one commit, never pushes, and cleans up", async () => {
  const s = scratch();
  const moved = [];
  const before = git(s.repo, "rev-parse", "HEAD");
  const steps = localMergeSteps({ ...s, repoRoot: s.repo, status: { move: async () => { moved.push("done"); } } });
  await runSteps(steps, realExec);
  assert.equal(git(s.repo, "rev-list", "--count", `${before}..HEAD`), "1", "one commit, not the branch's two");
  assert.equal(git(s.repo, "log", "-1", "--format=%s"), "Fix login (#7)");
  assert.equal(git(s.repo, "status", "--porcelain"), "");
  assert.equal(git(s.repo, "show", "HEAD:c.txt"), "new");
  assert.equal(git(s.repo, "branch", "--show-current"), "main");
  assert.deepEqual(moved, ["done"]);
  assert.ok(!existsSync(s.workDir) && !existsSync(s.runDir));
  assert.equal(git(s.repo, "branch", "--list", s.branch), "", "the branch is gone");
});

test("real git: a conflict leaves main exactly as it was, names the files, and removes nothing", async () => {
  const s = scratch();
  writeFileSync(join(s.repo, "a.txt"), "one\nTWO\nthree\nFOUR\n"); // the same lines, differently
  git(s.repo, "commit", "-q", "-a", ...ident.slice(0, 0), "-m", "main edits a.txt", "--no-gpg-sign");
  const head = git(s.repo, "rev-parse", "HEAD");
  let moved = false;
  await assert.rejects(runSteps(localMergeSteps({ ...s, repoRoot: s.repo, status: { move: async () => { moved = true; } } }), realExec), (e) => {
    assert.match(e.message, /a\.txt/);
    assert.doesNotMatch(e.message, /c\.txt/, "only the conflicting files are listed");
    return true;
  });
  assert.equal(git(s.repo, "rev-parse", "HEAD"), head);
  assert.equal(git(s.repo, "status", "--porcelain"), "", "no conflict markers, no staged files left");
  assert.equal(git(s.repo, "branch", "--show-current"), "main");
  assert.ok(!existsSync(join(s.repo, "c.txt")), "the squash's new file is gone from main");
  assert.ok(existsSync(s.workDir) && existsSync(s.runDir));
  assert.notEqual(git(s.repo, "branch", "--list", s.branch), "");
  assert.equal(moved, false);
  // and it works once the branch no longer conflicts
  git(s.workDir, ...ident, "merge", "-q", "-X", "theirs", "main", "-m", "resolve");
  await runSteps(localMergeSteps({ ...s, repoRoot: s.repo, status: { move: async () => {} } }), realExec);
  assert.equal(git(s.repo, "log", "-1", "--format=%s"), "Fix login (#7)");
});

test("real git: Merge refuses, changing nothing, when main is on another branch, is dirty, or the worktree is dirty", async () => {
  const s = scratch();
  const run = () => runSteps(localMergeSteps({ ...s, repoRoot: s.repo, status: { move: async () => {} } }), realExec);
  const state = () => `${git(s.repo, "rev-parse", "HEAD")} ${git(s.repo, "branch", "--list")}`;
  const before = state();

  writeFileSync(join(s.workDir, "d.txt"), "x");
  await assert.rejects(run(), /uncommitted changes/);
  git(s.workDir, "clean", "-fq");

  writeFileSync(join(s.repo, "e.txt"), "x");
  await assert.rejects(run(), /uncommitted changes/);
  git(s.repo, "clean", "-fq");

  git(s.repo, "switch", "-q", "-c", "other");
  await assert.rejects(run(), /is on .*other.*main/s);
  git(s.repo, "switch", "-q", "main"); git(s.repo, "branch", "-q", "-D", "other");

  assert.equal(state(), before);
  assert.ok(existsSync(s.workDir) && existsSync(s.runDir));
});

test("real git: pressing Merge again after the commit went in finishes the rest", async () => {
  const s = scratch();
  let tries = 0;
  const status = { move: async () => { if (!tries++) throw new Error("disk full"); } };
  await assert.rejects(runSteps(localMergeSteps({ ...s, repoRoot: s.repo, status }), realExec), /disk full.*Already done/s);
  const commits = git(s.repo, "rev-list", "--count", "HEAD");
  await runSteps(localMergeSteps({ ...s, repoRoot: s.repo, status }), realExec);
  assert.equal(git(s.repo, "rev-list", "--count", "HEAD"), commits, "no second commit");
  assert.ok(!existsSync(s.workDir) && !existsSync(s.runDir));
});

// --- the default branch --------------------------------------------------------------------------------------------

test("real git: the default branch is origin's, else main or master, else init.defaultBranch", async () => {
  const s = scratch();
  assert.equal(await defaultBranchOf(realGit, s.repo), "main");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "db-")));
  git(dir, "init", "-q", "-b", "master");
  git(dir, ...ident, "commit", "-q", "--allow-empty", "-m", "x");
  assert.equal(await defaultBranchOf(realGit, dir), "master");
  const odd = realpathSync(mkdtempSync(join(tmpdir(), "db-")));
  git(odd, "init", "-q", "-b", "trunk");
  git(odd, ...ident, "commit", "-q", "--allow-empty", "-m", "x");
  git(odd, "config", "init.defaultBranch", "trunk");
  assert.equal(await defaultBranchOf(realGit, odd), "trunk");
  git(odd, "config", "--unset", "init.defaultBranch");
  assert.equal(await defaultBranchOf(realGit, odd), null);
  // origin/HEAD wins
  git(s.repo, "update-ref", "refs/remotes/origin/develop", "HEAD");
  git(s.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  assert.equal(await defaultBranchOf(realGit, s.repo), "develop");
});

test("an empty ticket branch is logged as nothing new to merge, not as merged", async () => {
  const empty = await runSteps(localMergeSteps(ctx), fake({ "diff --cached --quiet": { code: 0 } }).exec);
  assert.ok(empty.done.some((d) => /nothing new to merge from workflow\/7-fix-login/.test(d)));
  assert.ok(!empty.done.some((d) => /^merged /.test(d)));
  const full = await runSteps(localMergeSteps(ctx), fake({ "diff --cached --quiet": { code: 1 } }).exec);
  assert.ok(full.done.includes("merged workflow/7-fix-login into main"));
});

test("when main's changes are staged, the refusal says what to do", async () => {
  await assert.rejects(runSteps(localMergeSteps(ctx), fake({ "-C /r status": { stdout: "M  a.txt\n" } }).exec), /staged: commit them, or drop them with `git reset --merge`/);
  await assert.rejects(runSteps(localMergeSteps(ctx), fake({ "-C /r status": { stdout: " M a.txt\n?? b.txt\n" } }).exec), (e) => !/staged/.test(e.message));
});
