import test from "node:test";
import assert from "node:assert/strict";
import {
  firstLine, projectConfigPath, repoWorkflowsDir, globalWorkflowsDir, tildePath, workflowDirs, refactorDirs, kindDirs, repoRefactorsDir, globalRefactorsDir,
  runDir, runPanePath, runIdFromDir, worktreePath, sessionFolder, cliDir, cliRequestsDir, cliRepliesDir, posixFolder,
  testRunsDir, testRunLockDir, testRunId, testRunFolder, testRunBundle, testRunLog, testRunCode,
} from "./places.js";

test("firstLine takes the first non-empty line, trimmed", () => {
  assert.equal(firstLine("\n  /a/b  \n/c\n"), "/a/b");
  assert.equal(firstLine(""), null);
  assert.equal(firstLine(undefined), null);
  assert.equal(firstLine("  \n \n"), null);
});

test("project buttons are configured in the ticket worktree", () => {
  assert.equal(projectConfigPath("/code/ticket"), "/code/ticket/.herdr/config.yaml");
  assert.equal(projectConfigPath("/code/ticket/"), "/code/ticket/.herdr/config.yaml");
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
  assert.equal(runIdFromDir(runDir("C:/Users/me", "12-abc")), "12-abc"); // a run's folder on a Windows machine
  for (const path of [
    "C:/Users/me/.herdr/workflow-runs", "C:/Users/me/.herdr/workflow-runs/..", "C:relative/.herdr/workflow-runs/9-abc",
    "CD:/x/.herdr/workflow-runs/9-abc", "C:\\Users\\me\\.herdr\\workflow-runs", "C:\\Users\\me\\.herdr\\workflow-runs\\..",
    "C:\\Users\\me\\.herdr\\workflow-runs\\9-abc\\extra", "C:relative\\.herdr\\workflow-runs\\9-abc",
    "/home/me/.herdr/workflow-runs", "/home/me/.herdr/workflow-runs/", "/home/me/.herdr/workflow-runs/.",
    "/home/me/.herdr/workflow-runs/..", "/home/me/.herdr/workflow-runs/9..abc", "/home/me/.herdr/workflow-runs/9-abc/extra",
    "relative/.herdr/workflow-runs/9-abc", null,
  ]) assert.equal(runIdFromDir(path), null, String(path));
});

test("on Windows the guard takes a run's folder in either slash style, as path.join and git write it", () => {
  assert.equal(runIdFromDir("C:\\Users\\me\\.herdr\\workflow-runs\\9-abc"), "9-abc");
  assert.equal(runIdFromDir("C:/Users/me/.herdr/workflow-runs/9-abc"), "9-abc");
  assert.equal(runIdFromDir(runDir("C:\\Users\\me", "9-abc")), "9-abc");
  assert.equal(runIdFromDir("/home/me/.herdr/workflow-runs/9\\abc"), "9\\abc", "on Unix a backslash is part of a name");
});

test("a Windows home or repo builds the same forward-slash paths in either slash style", () => {
  assert.equal(runDir("C:\\Users\\me", "12-abc"), "C:/Users/me/.herdr/workflow-runs/12-abc");
  assert.equal(runDir("C:/Users/me/", "12-abc"), "C:/Users/me/.herdr/workflow-runs/12-abc");
  assert.equal(runPanePath("C:\\Users\\me\\", "12-abc"), "C:/Users/me/.herdr/workflow-runs/12-abc/pane.json");
  assert.equal(cliDir("C:\\Users\\me"), "C:/Users/me/.herdr/tasks-cli");
  assert.equal(sessionFolder("C:\\Users\\me", "inv-x"), "C:/Users/me/.herdr/investigations/inv-x");
  assert.equal(repoWorkflowsDir("C:\\src\\app"), "C:/src/app/.herdr/workflows");
  assert.equal(globalWorkflowsDir("C:\\Users\\me\\.config\\herdr-app\\"), "C:/Users/me/.config/herdr-app/workflows");
  assert.equal(projectConfigPath("C:\\code\\ticket\\"), "C:/code/ticket/.herdr/config.yaml");
  assert.equal(projectConfigPath("\\\\server\\share\\ticket"), "//server/share/ticket/.herdr/config.yaml");
});

test("posixFolder names one folder one way: no trailing slash, and a Windows path in forward slashes", () => {
  assert.equal(posixFolder("/src/app/"), "/src/app");
  assert.equal(posixFolder("C:\\src\\app\\"), "C:/src/app");
  assert.equal(posixFolder("C:/src/app"), "C:/src/app");
  assert.equal(posixFolder("/src/a\\b"), "/src/a\\b", "on Unix a backslash is part of a name");
  assert.equal(posixFolder(null), "");
});

test("a ticket's worktree is where Herdr's worktree mod puts that branch", () => {
  assert.equal(worktreePath("/src/app", "workflow/12-fix", "/Users/me"), "/Users/me/.herdr/worktrees/app/workflow-12-fix");
});

test("the worktree folder is named for the main checkout, whatever else is passed", () => {
  assert.equal(worktreePath("/src/my app/", "workflow/3-x", "/h/"), "/h/.herdr/worktrees/my app/workflow-3-x");
});

test("on Windows the worktree folder is named for the repo whichever slashes its path and the home use", () => {
  const want = "C:/Users/me/.herdr/worktrees/my app/workflow-3-x";
  assert.equal(worktreePath("C:\\Users\\me\\src\\my app", "workflow/3-x", "C:\\Users\\me"), want);
  assert.equal(worktreePath("C:/Users/me/src/my app/", "workflow/3-x", "C:/Users/me/"), want);
  assert.equal(worktreePath("C:\\Users\\me\\src\\my app\\", "workflow/3-x", "C:/Users/me"), want);
});

test("on Unix a backslash in a folder's name is part of the name", () => {
  assert.equal(worktreePath("/src/a\\b", "workflow/3-x", "/h"), "/h/.herdr/worktrees/a\\b/workflow-3-x");
  assert.equal(runDir("/home/a\\b", "1-x"), "/home/a\\b/.herdr/workflow-runs/1-x");
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

test("herdr-tasks' mailbox is under ~/.herdr, beside the runs", () => {
  assert.equal(cliDir("/home/me/"), "/home/me/.herdr/tasks-cli");
  assert.equal(cliRequestsDir("/home/me"), "/home/me/.herdr/tasks-cli/requests");
  assert.equal(cliRepliesDir("/home/me"), "/home/me/.herdr/tasks-cli/replies");
});

test("a test run's folder, bundle, log and code are siblings in the device's test-runs folder", () => {
  assert.equal(testRunsDir("C:/Users/me/"), "C:/Users/me/.herdr/test-runs");
  assert.equal(testRunLockDir("/home/me"), "/home/me/.herdr/test-runs/.lock");
  assert.equal(testRunFolder("/home/me", "k3x9a"), "/home/me/.herdr/test-runs/k3x9a");
  assert.equal(testRunBundle("/home/me", "k3x9a"), "/home/me/.herdr/test-runs/k3x9a.bundle");
  assert.equal(testRunLog("C:/Users/me", "k3x9a"), "C:/Users/me/.herdr/test-runs/k3x9a.log");
  assert.equal(testRunCode("/home/me", "k3x9a"), "/home/me/.herdr/test-runs/k3x9a.code");
});

test("a test run id that could leave test-runs names no path", () => {
  for (const id of ["..", ".", "", "a/b", "../x", "a..b", "A1", "a b", "a-b", null, undefined, "x".repeat(41), "k3x9a\n"]) {
    assert.equal(testRunId(id), null, JSON.stringify(id));
    for (const f of [testRunFolder, testRunBundle, testRunLog, testRunCode]) assert.equal(f("/home/me", id), null, `${f.name} ${JSON.stringify(id)}`);
  }
  assert.equal(testRunId("k3x9a"), "k3x9a");
  assert.equal(testRunFolder("", "k3x9a"), null, "no home, no path");
});
