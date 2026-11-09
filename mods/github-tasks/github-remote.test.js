import test from "node:test";
import assert from "node:assert/strict";
import { isGithubRemote, hasGithubRemote } from "./github-remote.js";

test("github.com remotes, https and ssh", () => {
  for (const url of [
    "https://github.com/me/app.git", "https://github.com/me/app", "http://github.com/me/app.git",
    "https://user@github.com/me/app.git", "https://user:token@github.com/me/app.git", "https://GitHub.com/me/app.git",
    "git@github.com:me/app.git", "git@github.com:me/app", "ssh://git@github.com/me/app.git", "ssh://git@github.com:22/me/app.git",
    "git://github.com/me/app.git", "github.com:me/app.git", "  git@github.com:me/app.git\n",
  ]) assert.equal(isGithubRemote(url), true, url);
});

test("other hosts, other forms and nothing are not github.com", () => {
  for (const url of [
    "", null, undefined, "https://gitlab.com/me/app.git", "git@gitlab.com:me/app.git", "https://github.example.com/me/app.git",
    "https://github.com.evil.io/me/app.git", "https://evil.io/github.com/me/app.git", "git@evil.io:github.com/me.git",
    "https://notgithub.com/me/app.git", "/local/path/github.com/app", "../app", "file:///tmp/github.com/app", "https://user@evil.io/?github.com",
  ]) assert.equal(isGithubRemote(url), false, String(url));
});

test("the adapter asks git for origin's url in the repo", async () => {
  const seen = [];
  const git = (answer) => async (cwd, ...args) => { seen.push([cwd, ...args]); return answer; };
  assert.equal(await hasGithubRemote(git({ code: 0, stdout: "git@github.com:me/app.git\n", stderr: "" }), "/code/app"), true);
  assert.deepEqual(seen[0], ["/code/app", "remote", "get-url", "origin"]);
  assert.equal(await hasGithubRemote(git({ code: 0, stdout: "https://gitlab.com/me/app\n", stderr: "" }), "/code/app"), false);
  assert.equal(await hasGithubRemote(git({ code: 2, stdout: "", stderr: "error: No such remote 'origin'" }), "/code/app"), false);
  assert.equal(await hasGithubRemote(async () => { throw new Error("no git"); }, "/code/app"), false);
});
