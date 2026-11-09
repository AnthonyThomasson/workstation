// The git side of getting a ticket's worktree ready. `git` is (cwd, ...args) => Promise<{ code, stdout, stderr }>,
// so this runs in the mod (herdr's exec) and in the tests (real git) alike.
import { out } from "./run.js";

// The repo's main checkout, never a linked worktree: the first entry of `git worktree list` is always the main one,
// wherever Start was launched from. Falls back to the folder git says it is in.
export async function mainCheckout(git, cwd) {
  const list = await git(cwd, "worktree", "list", "--porcelain");
  if (list.code === 0) {
    const first = list.stdout.split("\n\n")[0].split("\n");
    const path = first.find((l) => l.startsWith("worktree "))?.slice(9);
    if (path && !first.includes("bare")) return path;
  }
  const top = await git(cwd, "rev-parse", "--show-toplevel");
  if (top.code !== 0) throw new Error(`${cwd} isn't in a git repo: ${out(top)}`);
  return top.stdout.trim();
}

const has = async (git, repoRoot, ref) => (await git(repoRoot, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)).code === 0;

// What a new ticket branch is cut from: origin's default branch (fetched first, so it is current), else the local
// default branch, else HEAD.
export async function baseFor(git, repoRoot) {
  await git(repoRoot, "fetch", "origin").catch(() => {}); // no remote, or offline: the local branches will do
  const head = await git(repoRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  const remote = head.code === 0 ? head.stdout.trim() : "";
  if (remote && await has(git, repoRoot, remote)) return remote;
  const local = remote.replace(/^origin\//, "");
  for (const name of [local, "main", "master"]) {
    if (name && await has(git, repoRoot, `refs/heads/${name}`)) return name;
  }
  return "HEAD";
}

const branchExists = async (git, dir, branch) => (await git(dir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)).code === 0;

// The ticket's own git worktree, at `target` (under Herdr's worktrees folder; git makes the missing parent folders). The repo's folder is never switched. A worktree that
// already has the branch is used again, unless its folder was deleted by hand, which prune forgets first.
export async function prepareWorktree(git, repoRoot, branch, target) {
  await git(repoRoot, "worktree", "prune");
  const list = await git(repoRoot, "worktree", "list", "--porcelain");
  if (list.code !== 0) throw new Error(`git couldn't list worktrees: ${out(list)}`);
  let path = null;
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    else if (line === `branch refs/heads/${branch}` && path) return path;
  }
  const r = (await branchExists(git, repoRoot, branch))
    ? await git(repoRoot, "worktree", "add", target, branch)
    : await git(repoRoot, "worktree", "add", "--no-track", "-b", branch, target, await baseFor(git, repoRoot));
  if (r.code !== 0) throw new Error(`Couldn't make a worktree at ${target}: ${out(r)}`);
  return target;
}
