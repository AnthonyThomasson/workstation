import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseFor, mainCheckout, placeInfo, NOT_A_REPO_MS, prepareWorktree } from "./worktree.js";
import { worktreePath } from "../workflow/index.js";

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
  return { dir, repo, origin, home: join(dir, "home") }; // home doesn't exist yet: the worktree's parent folders are made on demand
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
  const { repo, home } = scratch({ remote: true });
  const target = worktreePath(repo, "workflow/1-x", home);
  const path = await prepareWorktree(git, repo, "workflow/1-x", target);
  assert.equal(path, target);
  assert.equal(sh(path, "branch", "--show-current"), "workflow/1-x");
  assert.equal(sh(path, "log", "-1", "--format=%s"), "pushed by someone else"); // the local main doesn't have it
  assert.equal(sh(repo, "log", "-1", "--format=%s", "main"), "first");
  assert.throws(() => execFileSync("git", ["-C", path, "config", "--get", "branch.workflow/1-x.merge"], { stdio: "pipe" }), "no upstream is set");
});

test("with no remote, a new branch is cut from the local default branch, not whatever is checked out", async () => {
  const { repo, home } = scratch();
  sh(repo, "checkout", "-q", "-b", "wip");
  sh(repo, ...ident, "commit", "-q", "--allow-empty", "-m", "unfinished");
  const path = await prepareWorktree(git, repo, "workflow/2-y", worktreePath(repo, "workflow/2-y", home));
  assert.equal(sh(path, "log", "-1", "--format=%s"), "first");
});

test("with no default branch to find, a new branch is cut from HEAD", async () => {
  const { repo, home } = scratch();
  sh(repo, "checkout", "-q", "-b", "wip");
  sh(repo, "branch", "-q", "-m", "main", "elsewhere"); // no main or master any more
  sh(repo, ...ident, "commit", "-q", "--allow-empty", "-m", "on head");
  assert.equal(await baseFor(git, repo), "HEAD");
  const path = await prepareWorktree(git, repo, "workflow/3-z", worktreePath(repo, "workflow/3-z", home));
  assert.equal(sh(path, "log", "-1", "--format=%s"), "on head");
});

test("an existing ticket branch is used as it is", async () => {
  const { repo, home } = scratch({ remote: true });
  sh(repo, "branch", "workflow/4-w", "main");
  const path = await prepareWorktree(git, repo, "workflow/4-w", worktreePath(repo, "workflow/4-w", home));
  assert.equal(sh(path, "log", "-1", "--format=%s"), "first"); // not moved to origin's newer commit
});

test("a branch already checked out in a worktree gives that worktree's path", async () => {
  const { repo, dir, home } = scratch();
  const elsewhere = join(dir, "somewhere else");
  sh(repo, "worktree", "add", "-q", "-b", "workflow/5-v", elsewhere);
  assert.equal(await prepareWorktree(git, repo, "workflow/5-v", worktreePath(repo, "workflow/5-v", home)), elsewhere);
});

test("a worktree whose folder was deleted by hand is made again, not reused", async () => {
  const { repo, home } = scratch();
  const target = worktreePath(repo, "workflow/6-u", home);
  await prepareWorktree(git, repo, "workflow/6-u", target);
  rmSync(target, { recursive: true });
  const path = await prepareWorktree(git, repo, "workflow/6-u", target);
  assert.equal(path, target);
  assert.ok(existsSync(join(target, ".git")));
  assert.equal(sh(path, "branch", "--show-current"), "workflow/6-u");
});

test("a worktree that can't be made says why", async () => {
  const { repo, home } = scratch();
  const target = worktreePath(repo, "workflow/7-t", home);
  mkdirSync(target, { recursive: true });
  execFileSync("touch", [join(target, "in the way")]);
  await assert.rejects(prepareWorktree(git, repo, "workflow/7-t", target), /Couldn't make a worktree at/);
});

test("a ticket worktree lands in Herdr's worktree folder, named for the main checkout even when started from a worktree", async () => {
  const { repo, dir, home } = scratch();
  const linked = join(dir, "linked");
  sh(repo, "worktree", "add", "-q", "-b", "side", linked);
  const main = await mainCheckout(git, linked);
  const target = worktreePath(main, "workflow/9-q", home);
  assert.equal(target, join(home, ".herdr", "worktrees", "my app", "workflow-9-q"));
  assert.equal(await prepareWorktree(git, main, "workflow/9-q", target), target);
  assert.ok(existsSync(join(target, ".git")));
  assert.equal(sh(target, "branch", "--show-current"), "workflow/9-q");
});

test("a second Start for the same branch reuses its worktree under Herdr's folder", async () => {
  const { repo, home } = scratch();
  const target = worktreePath(repo, "workflow/10-p", home);
  await prepareWorktree(git, repo, "workflow/10-p", target);
  assert.equal(await prepareWorktree(git, repo, "workflow/10-p", target), target);
});

// ---- which place ----
const fakeGit = (roots) => {
  const calls = [];
  const git = (on) => async (cwd, ...args) => {
    calls.push([on, cwd, ...args]);
    const root = roots[cwd];
    if (args[0] === "worktree") return root ? { code: 0, stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/main\n\n`, stderr: "" } : { code: 128, stdout: "", stderr: "not a git repository" };
    return { code: 128, stdout: "", stderr: "not a git repository" };
  };
  return { git, calls, lookups: () => calls.filter((c) => c[2] === "worktree").length };
};

test("a folder in a repo is that repo's main checkout", async () => {
  const { git } = fakeGit({ "/r/wt": "/r" });
  const info = await placeInfo({ folder: "/r/wt" }, null, { git });
  assert.deepEqual([info.mainRoot, info.remote, info.folder], ["/r", false, "/r/wt"]);
});

test("a folder outside any repo has no main checkout", async () => {
  const { git } = fakeGit({});
  const info = await placeInfo({ folder: "/home/me" }, null, { git });
  assert.equal(info.mainRoot, null);
  assert.equal((await placeInfo({}, null, { git })).mainRoot, null); // no folder at all
});

test("a space on another machine is asked there, and is marked remote", async () => {
  const { git, calls } = fakeGit({ "/srv/app": "/srv/app" });
  const info = await placeInfo({ folder: "/srv/app", on: "box" }, null, { git });
  assert.deepEqual([info.mainRoot, info.remote, info.on], ["/srv/app", true, "box"]);
  assert.equal(calls[0][0], "box");
});

test("the main checkout is not asked for again in the same folder", async () => {
  const { git, lookups } = fakeGit({ "/r": "/r" });
  const first = await placeInfo({ folder: "/r" }, null, { git });
  const second = await placeInfo({ folder: "/r" }, first.cache, { git });
  assert.equal(second.mainRoot, "/r");
  assert.equal(lookups(), 1);
  await placeInfo({ folder: "/r/other" }, second.cache, { git }); // another folder: asked again
  assert.equal(lookups(), 2);
});

test("a folder that was not a repo is looked at again after a while", async () => {
  const { git, lookups } = fakeGit({});
  const first = await placeInfo({ folder: "/x" }, null, { git }, 1000);
  await placeInfo({ folder: "/x" }, first.cache, { git }, 1000 + NOT_A_REPO_MS - 1);
  assert.equal(lookups(), 1);
  await placeInfo({ folder: "/x" }, first.cache, { git }, 1000 + NOT_A_REPO_MS);
  assert.equal(lookups(), 2);
});
