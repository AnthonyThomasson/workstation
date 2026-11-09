import test from "node:test";
import assert from "node:assert/strict";
import { localTicket, localStages, rowLabel, sourceFor, sourceToggle, LOCAL_STATUS_OPTIONS, LOCAL_ONLY_HERE, typedLabels, localNewTaskPrompt } from "./local-ui.js";
import { ASK_WITH_TOOL } from "./model.js";
import { makeLocalTasks } from "./local-tasks.js";
import { matchWorkflows } from "./match.js";

const task = (id, status, createdAt, over = {}) => ({ id, title: `Task ${id}`, description: `About ${id}`, labels: ["bug"], createdAt, status, folder: "x", path: "/p", ...over });

test("a local task is the ticket the rest of Tasks knows: number is the id, body the description", () => {
  const t = localTicket(task(7, "Up Next", "2026-11-08T10:00:00Z"), "/r");
  assert.equal(t.number, 7);
  assert.equal(t.title, "Task 7");
  assert.equal(t.body, "About 7");
  assert.deepEqual(t.labels, ["bug"]);
  assert.equal(t.status, "Up Next");
  assert.equal(t.url, null);
  assert.equal(t.draft, false);
  assert.equal(t.local, true);
  assert.equal(t.mainRoot, "/r");
  assert.equal(t.key, "local:7");
});

test("a local ticket's labels match workflows like a GitHub ticket's", () => {
  const workflows = [{ id: "a", name: "A", trigger: { labels: ["bug"], match: "any" } }];
  assert.equal(matchWorkflows(workflows, localTicket(task(1, "To Do", null), "/r").labels).length, 1);
});

test("the sidebar's sections hold the local tasks of each status, newest createdAt first", () => {
  const stages = localStages([
    task(1, "To Do", "2026-01-01T00:00:00Z"),
    task(2, "To Do", "2026-03-01T00:00:00Z"),
    task(3, "Up Next", "2026-02-01T00:00:00Z"),
    task(4, "In Progress", "2026-02-01T00:00:00Z"),
    task(5, "In Review", "2026-02-01T00:00:00Z"),
    task(6, "Done", "2026-02-01T00:00:00Z"),
    task(7, "To Do", "2026-02-01T00:00:00Z"),
  ], "/r");
  assert.deepEqual(stages.backlog.map((t) => t.number), [2, 7, 1]);
  assert.deepEqual(stages.groomed.map((t) => t.number), [3]);
  assert.deepEqual(stages.inProgress.map((t) => t.number), [4]);
  assert.deepEqual(stages.inReview.map((t) => t.number), [5]);
  assert.equal(Object.values(stages).flat().some((t) => t.number === 6), false); // done/ is hidden
  assert.deepEqual(localStages(null, "/r"), { inProgress: [], inReview: [], groomed: [], backlog: [] });
});

test("sections built from the real store: done/ is hidden, a file that doesn't parse is skipped", async () => {
  const files = new Map([
    ["/h/.herdr/tasks/-r/to-do/1-a.yml", "id: 1\ntitle: A\ncreatedAt: 2026-01-01T00:00:00Z\n"],
    ["/h/.herdr/tasks/-r/up-next/2-b.yml", "id: 2\ntitle: B\ncreatedAt: 2026-01-02T00:00:00Z\n"],
    ["/h/.herdr/tasks/-r/done/3-c.yml", "id: 3\ntitle: C\n"],
    ["/h/.herdr/tasks/-r/to-do/4-broken.yml", "title: [oops"],
  ]);
  const io = {
    list: async (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
    read: async (p) => files.get(p) ?? null, write: async (p, t) => files.set(p, t), remove: async (p) => files.delete(p), mkdir: async () => {},
  };
  const stages = localStages(await makeLocalTasks({ io, root: "/r", home: "/h" }).list(), "/r");
  assert.deepEqual(stages.backlog.map((t) => t.number), [1]);
  assert.deepEqual(stages.groomed.map((t) => t.number), [2]);
});

test("rows show #<id> for a local task and only the title for GitHub's", () => {
  assert.equal(rowLabel(localTicket(task(12, "To Do", null), "/r")), "#12 Task 12");
  assert.equal(rowLabel({ number: 12, title: "From GitHub" }), "From GitHub");
});

test("the published source only counts for the place it was made for", () => {
  const published = { source: "local", mainRoot: "/r", remote: false, cwd: "/r/sub", on: undefined };
  assert.equal(sourceFor(published, { cwd: "/r/sub", on: undefined }), published);
  assert.equal(sourceFor(published, { cwd: "/r/sub", on: null }), published);
  assert.equal(sourceFor(published, { cwd: "/elsewhere" }), null);
  assert.equal(sourceFor(published, { cwd: "/r/sub", on: "box" }), null);
  assert.equal(sourceFor(null, { cwd: "/r" }), null);
  assert.equal(sourceFor(published, null), null);
});

test("the Local tasks checkbox is enabled only inside a git repo on this computer", () => {
  const inRepo = sourceToggle({ source: "github", mainRoot: "/r", remote: false });
  assert.deepEqual([inRepo.checked, inRepo.enabled, inRepo.next], [false, true, "local"]);
  const on = sourceToggle({ source: "local", mainRoot: "/r", remote: false });
  assert.deepEqual([on.checked, on.enabled, on.next], [true, true, "github"]);

  const outside = sourceToggle({ source: "github", mainRoot: null, remote: false });
  assert.equal(outside.enabled, false);
  assert.match(outside.tooltip, /inside a git repo/);

  const remote = sourceToggle({ source: "github", mainRoot: "/r", remote: true });
  assert.equal(remote.enabled, false);
  assert.equal(remote.tooltip, LOCAL_ONLY_HERE);

  const unknown = sourceToggle(null);
  assert.deepEqual([unknown.checked, unknown.enabled], [false, false]);
  assert.ok(unknown.tooltip);
});

test("a hand edit that made the file say local shows as checked even where it can't be changed", () => {
  assert.equal(sourceToggle({ source: "local", mainRoot: "/r", remote: true }).checked, true);
});

test("the editor's Status picker offers all five statuses, Done too", () => {
  assert.deepEqual(LOCAL_STATUS_OPTIONS.map((o) => o.name), ["To Do", "Up Next", "In Progress", "In Review", "Done"]);
});

test("typed labels split on commas and keep what was typed", () => {
  assert.deepEqual(typedLabels("bug"), ["bug"]);
  assert.deepEqual(typedLabels(" bug , Needs Work,, "), ["bug", "Needs Work"]);
  assert.deepEqual(typedLabels("  "), []);
});

test("the local New Task prompt asks questions with the built-in question tool, right after waiting for each answer", () => {
  const prompt = localNewTaskPrompt({ mainRoot: "/Users/me/app", todoDir: "/t", upNextDir: "/u", nextId: 1 });
  assert.ok(prompt.includes("wait for the answer before the next question. " + ASK_WITH_TOOL + " Read the code yourself"));
});

test("the local New Task prompt names the folders, the next id, the file name and the format, and says no gh", () => {
  const prompt = localNewTaskPrompt({ mainRoot: "/Users/me/app", todoDir: "/h/.herdr/tasks/-Users-me-app/to-do", upNextDir: "/h/.herdr/tasks/-Users-me-app/up-next", nextId: 12 });
  assert.match(prompt, /\/h\/\.herdr\/tasks\/-Users-me-app\/to-do/);
  assert.match(prompt, /\/h\/\.herdr\/tasks\/-Users-me-app\/up-next/);
  assert.match(prompt, /next id is 12/);
  assert.match(prompt, /<id>-<slug>\.yml/);
  assert.match(prompt, /12-fix-login-redirect\.yml/);
  assert.match(prompt, /^id: 12$/m);
  for (const field of ["title:", "description: |", "labels:", "createdAt:"]) assert.ok(prompt.includes(field), field);
  assert.match(prompt, /exactly one file/);
  assert.match(prompt, /no `gh` calls/);
  assert.doesNotMatch(prompt, /GitHub Project/);
  assert.match(prompt, /^# You are helping the person write a new task for app$/m);
});

// ---- which place and which source ----
import { placeInfo, NOT_A_REPO_MS } from "./local-ui.js";

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
const config = (sources) => (on) => ({ read: async (root) => sources[`${on ?? ""}:${root}`] ?? "github" });

test("a folder in a repo is that repo's main checkout, with the source its tasks.json says", async () => {
  const { git } = fakeGit({ "/r/wt": "/r" });
  const info = await placeInfo({ folder: "/r/wt" }, null, { git, config: config({ ":/r": "local" }) });
  assert.deepEqual([info.mainRoot, info.source, info.remote, info.folder], ["/r", "local", false, "/r/wt"]);
});

test("a folder outside any repo has no main checkout and uses github", async () => {
  const { git } = fakeGit({});
  const info = await placeInfo({ folder: "/home/me" }, null, { git, config: config({}) });
  assert.deepEqual([info.mainRoot, info.source], [null, "github"]);
  assert.equal((await placeInfo({}, null, { git, config: config({}) })).mainRoot, null); // no folder at all
});

test("a space on another machine is asked there, and is marked remote", async () => {
  const { git, calls } = fakeGit({ "/srv/app": "/srv/app" });
  const info = await placeInfo({ folder: "/srv/app", on: "box" }, null, { git, config: config({ "box:/srv/app": "local" }) });
  assert.deepEqual([info.mainRoot, info.source, info.remote, info.on], ["/srv/app", "local", true, "box"]);
  assert.equal(calls[0][0], "box");
});

test("the main checkout is not asked for again in the same folder, but the file is read every time", async () => {
  const { git, lookups } = fakeGit({ "/r": "/r" });
  const sources = { ":/r": "github" };
  const deps = { git, config: config(sources) };
  const first = await placeInfo({ folder: "/r" }, null, deps);
  sources[":/r"] = "local"; // a hand edit
  const second = await placeInfo({ folder: "/r" }, first.cache, deps);
  assert.equal(second.source, "local");
  assert.equal(lookups(), 1);
  await placeInfo({ folder: "/r/other" }, second.cache, deps); // another folder: asked again
  assert.equal(lookups(), 2);
});

test("a folder that was not a repo is looked at again after a while", async () => {
  const { git, lookups } = fakeGit({});
  const deps = { git, config: config({}) };
  const first = await placeInfo({ folder: "/x" }, null, deps, 1000);
  await placeInfo({ folder: "/x" }, first.cache, deps, 1000 + NOT_A_REPO_MS - 1);
  assert.equal(lookups(), 1);
  await placeInfo({ folder: "/x" }, first.cache, deps, 1000 + NOT_A_REPO_MS);
  assert.equal(lookups(), 2);
});

test("a config that can't be read counts as github", async () => {
  const { git } = fakeGit({ "/r": "/r" });
  const info = await placeInfo({ folder: "/r" }, null, { git, config: () => ({ read: async () => { throw new Error("boom"); } }) });
  assert.equal(info.source, "github");
});

test("the local New Task prompt says to re-check the highest id before writing, and what a title with no letters gets", () => {
  const prompt = localNewTaskPrompt({ mainRoot: "/r/app", todoDir: "/t/to-do", upNextDir: "/t/up-next", nextId: 5 });
  assert.match(prompt, /right before writing the file, look at the highest id across all the status folders again/);
  assert.match(prompt, /no letters or digits gets `5-task\.yml`/);
});
