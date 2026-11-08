import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseFor, mainCheckout, prepareWorktree } from "./worktree.js";
import { worktreePath } from "./run.js";

// The same shape as the host's exec: { code, stdout, stderr }.
const git = async (cwd, ...args) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@t"];

// A repo with a commit on `main`. With `remote`, it also has an origin that has one commit more.
function scratch({ remote = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-")));
  const repo = join(dir, "my app");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, ...ident, "commit", "-q", "--allow-empty", "-m", "first");
  let origin = null;
  if (remote) {
    origin = join(dir, "origin.git");
    execFileSync("git", ["clone", "-q", "--bare", repo, origin]);
    sh(repo, "remote", "add", "origin", origin);
    sh(repo, "fetch", "-q", "origin");
    sh(repo, "remote", "set-head", "origin", "main");
    // someone else pushes a commit the repo hasn't fetched
    const other = join(dir, "other");
    execFileSync("git", ["clone", "-q", origin, other]);
    sh(other, ...ident, "commit", "-q", "--allow-empty", "-m", "pushed by someone else");
    sh(other, "push", "-q", "origin", "main");
  }
  return { dir, repo, origin };
}

test("mainCheckout is the repo itself", async () => {
  const { repo } = scratch();
  assert.equal(await mainCheckout(git, repo), repo);
  mkdirSync(join(repo, "sub"));
  assert.equal(await mainCheckout(git, join(repo, "sub")), repo);
});

test("mainCheckout from inside a linked worktree is still the main checkout", async () => {
  const { repo, dir } = scratch();
  const linked = join(dir, "linked");
  sh(repo, "worktree", "add", "-q", "-b", "other", linked);
  assert.equal(await mainCheckout(git, linked), repo);
});

test("a new ticket branch is cut from origin's default branch, after a fetch", async () => {
  const { repo } = scratch({ remote: true });
  const target = worktreePath(repo, "workflow/1-x");
  const path = await prepareWorktree(git, repo, "workflow/1-x", target);
  assert.equal(path, target);
  assert.equal(sh(path, "branch", "--show-current"), "workflow/1-x");
  assert.equal(sh(path, "log", "-1", "--format=%s"), "pushed by someone else"); // the local main doesn't have it
  assert.equal(sh(repo, "log", "-1", "--format=%s", "main"), "first");
  assert.throws(() => execFileSync("git", ["-C", path, "config", "--get", "branch.workflow/1-x.merge"], { stdio: "pipe" }), "no upstream is set");
});

test("with no remote, a new branch is cut from the local default branch, not whatever is checked out", async () => {
  const { repo } = scratch();
  sh(repo, "checkout", "-q", "-b", "wip");
  sh(repo, ...ident, "commit", "-q", "--allow-empty", "-m", "unfinished");
  const path = await prepareWorktree(git, repo, "workflow/2-y", worktreePath(repo, "workflow/2-y"));
  assert.equal(sh(path, "log", "-1", "--format=%s"), "first");
});

test("with no default branch to find, a new branch is cut from HEAD", async () => {
  const { repo } = scratch();
  sh(repo, "checkout", "-q", "-b", "wip");
  sh(repo, "branch", "-q", "-m", "main", "elsewhere"); // no main or master any more
  sh(repo, ...ident, "commit", "-q", "--allow-empty", "-m", "on head");
  assert.equal(await baseFor(git, repo), "HEAD");
  const path = await prepareWorktree(git, repo, "workflow/3-z", worktreePath(repo, "workflow/3-z"));
  assert.equal(sh(path, "log", "-1", "--format=%s"), "on head");
});

test("an existing ticket branch is used as it is", async () => {
  const { repo } = scratch({ remote: true });
  sh(repo, "branch", "workflow/4-w", "main");
  const path = await prepareWorktree(git, repo, "workflow/4-w", worktreePath(repo, "workflow/4-w"));
  assert.equal(sh(path, "log", "-1", "--format=%s"), "first"); // not moved to origin's newer commit
});

test("a branch already checked out in a worktree gives that worktree's path", async () => {
  const { repo, dir } = scratch();
  const elsewhere = join(dir, "somewhere else");
  sh(repo, "worktree", "add", "-q", "-b", "workflow/5-v", elsewhere);
  assert.equal(await prepareWorktree(git, repo, "workflow/5-v", worktreePath(repo, "workflow/5-v")), elsewhere);
});

test("a worktree whose folder was deleted by hand is made again, not reused", async () => {
  const { repo } = scratch();
  const target = worktreePath(repo, "workflow/6-u");
  await prepareWorktree(git, repo, "workflow/6-u", target);
  rmSync(target, { recursive: true });
  const path = await prepareWorktree(git, repo, "workflow/6-u", target);
  assert.equal(path, target);
  assert.ok(existsSync(join(target, ".git")));
  assert.equal(sh(path, "branch", "--show-current"), "workflow/6-u");
});

test("a worktree that can't be made says why", async () => {
  const { repo } = scratch();
  const target = worktreePath(repo, "workflow/7-t");
  mkdirSync(target);
  execFileSync("touch", [join(target, "in the way")]);
  await assert.rejects(prepareWorktree(git, repo, "workflow/7-t", target), /Couldn't make a worktree at/);
});
