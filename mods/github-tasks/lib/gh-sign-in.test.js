import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, signInFrom } from "./gh-sign-in.js";

test("reads gh's one-time code and page from its sign-in output", () => {
  const out = "\n! One-time code (AA8B-5FB7) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
  assert.deepEqual(signInFrom(out), { code: "AA8B-5FB7", url: "https://github.com/login/device" });
  assert.deepEqual(signInFrom(""), { code: null, url: null });
  assert.deepEqual(signInFrom("! One-time code (6D7D-8CDC)"), { code: "6D7D-8CDC", url: null });
});

test("names gh's failures", () => {
  assert.equal(classifyError("GraphQL: Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project']"), "no-scope");
  assert.equal(classifyError("To get started with GitHub CLI, please run:  gh auth login"), "no-auth");
  assert.equal(classifyError("HTTP 401: Bad credentials"), "no-auth");
  assert.equal(classifyError("failed to run git: fatal: not a git repository (or any of the parent directories): .git"), "not-a-repo");
  assert.equal(classifyError("no git remotes found"), "not-a-repo");
  assert.equal(classifyError("none of the git remotes configured for this repository point to a known GitHub host"), "not-a-repo");
  assert.equal(classifyError("HTTP 502: Bad gateway"), "other");
  assert.equal(classifyError(undefined), "other");
});

const WRITE_SCOPE_ERROR = "GraphQL: Your token has not been granted the required scopes to execute this query. The 'updateProjectV2ItemFieldValue' field requires one of the following scopes: ['project'], but your token has only been granted the: ['read:project', 'repo'] scopes.";

test("tells a missing write scope from a missing read scope", () => {
  assert.equal(classifyError(WRITE_SCOPE_ERROR), "no-write-scope");
  assert.equal(classifyError("The 'projectsV2' field requires one of the following scopes: ['read:project']"), "no-scope");
});
