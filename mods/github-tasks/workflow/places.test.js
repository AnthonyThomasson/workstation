import test from "node:test";
import assert from "node:assert/strict";
import {
  firstLine, repoWorkflowsDir, globalWorkflowsDir, tildePath, workflowDirs, refactorDirs, kindDirs, repoRefactorsDir, globalRefactorsDir,
  runDir, runPanePath, runIdFromDir, worktreePath, sessionFolder,
} from "./places.js";

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

test("a run folder and its pane.json live under the home's workflow-runs folder", () => {
  assert.equal(runDir("/home/me", "12-abc"), "/home/me/.herdr/workflow-runs/12-abc");
  assert.equal(runPanePath("/home/me", "12-abc"), "/home/me/.herdr/workflow-runs/12-abc/pane.json");
});

test("the run-folder guard accepts only one safe child of workflow-runs", () => {
  assert.equal(runIdFromDir("/home/me/.herdr/workflow-runs/12-abc"), "12-abc");
  assert.equal(runIdFromDir(runDir("/home/me", "12-abc")), "12-abc");
  for (const path of [
    "/home/me/.herdr/workflow-runs", "/home/me/.herdr/workflow-runs/", "/home/me/.herdr/workflow-runs/.",
    "/home/me/.herdr/workflow-runs/..", "/home/me/.herdr/workflow-runs/9..abc", "/home/me/.herdr/workflow-runs/9-abc/extra",
    "relative/.herdr/workflow-runs/9-abc", null,
  ]) assert.equal(runIdFromDir(path), null, String(path));
});

test("a ticket's worktree is where Herdr's worktree mod puts that branch", () => {
  assert.equal(worktreePath("/src/app", "workflow/12-fix", "/Users/me"), "/Users/me/.herdr/worktrees/app/workflow-12-fix");
});

test("the worktree folder is named for the main checkout, whatever else is passed", () => {
  assert.equal(worktreePath("/src/my app/", "workflow/3-x", "/h/"), "/h/.herdr/worktrees/my app/workflow-3-x");
});

test("odd branch names are slugged the way Herdr's worktree mod does", () => {
  const at = (branch) => worktreePath("/src/app", branch, "/h");
  assert.equal(at("workflow/12-fix the login: now!"), "/h/.herdr/worktrees/app/workflow-12-fix-the-login-now");
  assert.equal(at("feat//a..b_c"), "/h/.herdr/worktrees/app/feat-a..b_c");
  assert.equal(at("/lead/trail/"), "/h/.herdr/worktrees/app/lead-trail");
});

test("the session folder is ~/.herdr/investigations/<id>, and only an investigation's own id has one", () => {
  assert.equal(sessionFolder("/home/me", "inv-x"), "/home/me/.herdr/investigations/inv-x");
  assert.equal(sessionFolder("/home/me/", "inv-x"), "/home/me/.herdr/investigations/inv-x", "a trailing slash on home is no matter");
  for (const bad of ["", "..", "../x", "inv-", "inv-x/..", "inv-x/sub", "inv-a/b", "inv-1/..", "other", "x", undefined]) assert.equal(sessionFolder("/home/me", bad), null, String(bad));
  assert.equal(sessionFolder("", "inv-x"), null);
  assert.equal(sessionFolder("/", "inv-x"), null);
});
