// Whether a repo's `origin` remote is on github.com. Pure URL check, plus a git adapter in the shape worktree.js uses:
// git(cwd, ...args) => Promise<{ code, stdout, stderr }> (start.js passes `git -C <cwd> ...`, the tests a fake).

// https://github.com/o/r.git, http(s)://user@github.com/..., ssh://git@github.com[:22]/..., git://github.com/...,
// git@github.com:o/r.git. The host must be exactly github.com, so github.com.evil.io and a path that mentions it are not.
const URL_HOST = /^(?:https?|ssh|git):\/\/(?:[^/@?#]*@)?github\.com(?::\d+)?(?:[/?#]|$)/i;
const SCP_HOST = /^(?:[^/@:\s]+@)?github\.com:/i;

export const isGithubRemote = (url) => {
  const text = String(url ?? "").trim();
  return URL_HOST.test(text) || SCP_HOST.test(text);
};

// true when `origin` exists and is on github.com. No origin, no git or an unreadable answer is false.
export async function hasGithubRemote(git, repoRoot) {
  try {
    const r = await git(repoRoot, "remote", "get-url", "origin");
    return r.code === 0 && isGithubRemote(r.stdout);
  } catch { return false; }
}
