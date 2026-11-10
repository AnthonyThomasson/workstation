import test from "node:test";
import assert from "node:assert/strict";
import { firstLine, repoWorkflowsDir, globalWorkflowsDir, tildePath, workflowDirs, refactorDirs, kindDirs, repoRefactorsDir, globalRefactorsDir } from "./places.js";

test("firstLine takes the first non-empty line, trimmed", () => {
  assert.equal(firstLine("\n  /a/b  \n/c\n"), "/a/b");
  assert.equal(firstLine(""), null);
  assert.equal(firstLine(undefined), null);
  assert.equal(firstLine("  \n \n"), null);
});

test("a repo's workflows are in its .herdr folder", () => {
  assert.equal(repoWorkflowsDir("/code/app"), "/code/app/.herdr/workflows");
});

test("global workflows are in the workflows folder of the Herdr home", () => {
  assert.equal(globalWorkflowsDir("/home/me/.config/herdr-app"), "/home/me/.config/herdr-app/workflows");
  assert.equal(globalWorkflowsDir("/scratch/app-home/"), "/scratch/app-home/workflows");
});

test("a path under the home is shown with ~, any other as it is", () => {
  assert.equal(tildePath("/home/me/.config/herdr-app/workflows", "/home/me"), "~/.config/herdr-app/workflows");
  assert.equal(tildePath("/home/me", "/home/me"), "~");
  assert.equal(tildePath("/home/me2/x", "/home/me"), "/home/me2/x");
  assert.equal(tildePath("/scratch/app/workflows", "/home/me"), "/scratch/app/workflows");
});

test("global is always a place; repo is one only with a repo", () => {
  assert.deepEqual(workflowDirs("/home/me/.config/herdr-app", null), { global: "/home/me/.config/herdr-app/workflows" });
  assert.deepEqual(workflowDirs("/home/me/.config/herdr-app", "/code/app"), {
    global: "/home/me/.config/herdr-app/workflows",
    repo: "/code/app/.herdr/workflows",
  });
});

test("refactor types live in refactors folders: the Herdr home's, and a repo's .herdr", () => {
  assert.equal(repoRefactorsDir("/code/app"), "/code/app/.herdr/refactors");
  assert.equal(globalRefactorsDir("/home/me/.config/herdr-app/"), "/home/me/.config/herdr-app/refactors");
  assert.deepEqual(refactorDirs("/home/me/.config/herdr-app", null), { global: "/home/me/.config/herdr-app/refactors" });
  assert.deepEqual(refactorDirs("/home/me/.config/herdr-app", "/code/app"), {
    global: "/home/me/.config/herdr-app/refactors", repo: "/code/app/.herdr/refactors",
  });
  assert.deepEqual(kindDirs("/h", "/r", "workflows"), workflowDirs("/h", "/r"));
});
