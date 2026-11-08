import test from "node:test";
import assert from "node:assert/strict";
import { gather, check, Doctor, TIMEOUT } from "./doctor-run.js";
import { DOCTOR_KEY } from "./doctor.js";
import { PLACE, WORKFLOWS_CHANGED, STATUSES } from "./model.js";

const PROJECT = { id: "P1", title: "app", url: "https://github.com/users/me/projects/3", closed: false };
const OK_AUTH = { code: 0, stdout: "  ✓ Logged in to github.com account me\n  - Active account: true\n  - Token scopes: 'repo', 'project'\n", stderr: "" };
const ALL = Object.values(STATUSES);

// A fake gh answering the calls the doctor makes. Replace a key of `answers` to change an answer; an Error is a failure,
// a function is called, and a Promise that never settles is a hung gh.
function fakes(over = {}) {
  const answers = {
    auth: OK_AUTH,
    repo: { code: 0, stdout: JSON.stringify({ nameWithOwner: "me/app" }), stderr: "" },
    projects: { code: 0, stdout: JSON.stringify({ data: { repository: { projectsV2: { nodes: [PROJECT] } } } }), stderr: "" },
    field: { code: 0, stdout: JSON.stringify({ data: { node: { field: { id: "F", options: ALL.map((name, i) => ({ id: String(i), name })) } } } }), stderr: "" },
    ...over,
  };
  const calls = [];
  const gh = async (args) => {
    const a = args.join(" ");
    const name = args[0] === "auth" ? "auth" : a.startsWith("repo view") ? "repo" : a.includes("projectsV2") ? "projects" : a.includes("field(name") ? "field" : "other";
    calls.push(name);
    const answer = typeof answers[name] === "function" ? answers[name]() : answers[name];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const store = new Map(), writes = [];
  const deps = {
    gh, calls, answers, store, writes,
    shared: (k) => store.get(k),
    setShared: (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); writes.push([k, v]); },
    knownAgents: async () => [{ key: "claude", installed: true }],
    loadWorkflows: async () => ({ items: [], errors: [] }),
    repoRootOf: async ({ cwd }) => (cwd?.startsWith("/repo") ? "/repo" : null),
    groomerAgent: () => null,
    chosenProject: () => undefined,
    ...over.deps,
  };
  return deps;
}
const notARepo = { code: 1, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" };
const kinds = (found) => found.issues.map((i) => i.kind);
const place = { cwd: "/repo/src", on: undefined, root: "/repo" };

test("gather finds the repo, its chosen project and its status options", async () => {
  const inputs = await gather({ cwd: "/repo" }, fakes());
  assert.equal(inputs.repo, "me/app");
  assert.deepEqual(inputs.project, { id: "P1", title: "app", url: PROJECT.url });
  assert.deepEqual(inputs.statuses.map((o) => o.name), ALL);
});

test("a Status field that is null means no statuses at all (missing), not unknown", async () => {
  const deps = fakes({ field: { code: 0, stdout: JSON.stringify({ data: { node: { field: null } } }), stderr: "" } });
  const found = await check(place, deps);
  assert.deepEqual(found.issues.map((i) => [i.kind, i.status]), ALL.map((s) => ["status-missing", s]));
});

test("a failed status read is unknown: no status issues", async () => {
  const found = await check(place, fakes({ field: { code: 1, stdout: "", stderr: "HTTP 502" } }));
  assert.deepEqual(found.issues, []);
});

test("project null (none linked) is an issue; project unknown (the read failed) is not", async () => {
  const none = await check(place, fakes({ projects: { code: 0, stdout: JSON.stringify({ data: { repository: { projectsV2: { nodes: [] } } } }), stderr: "" } }));
  assert.deepEqual(kinds(none), ["no-project"]);
  assert.equal(none.project, null);
  const unknown = await check(place, fakes({ projects: { code: 1, stdout: "", stderr: "HTTP 502" } }));
  assert.deepEqual(unknown.issues, []);
  assert.equal(unknown.repo, "me/app");
});

test("not being in a GitHub repo is no project issue, and the repo is null", async () => {
  const found = await check(place, fakes({ repo: notARepo }));
  assert.deepEqual(found.issues, []);
  assert.equal(found.repo, null);
});

test("a repo view that fails for another reason keeps the last project issues for the same place", async () => {
  const missing = fakes({ field: { code: 0, stdout: JSON.stringify({ data: { node: { field: { id: "F", options: [{ id: "1", name: "To Do" }] } } } }), stderr: "" } });
  const first = await check(place, missing);
  assert.ok(first.issues.length > 0);
  const flaky = fakes({ repo: { code: 1, stdout: "", stderr: "error connecting to api.github.com" } });
  const again = await check(place, flaky, first);
  assert.deepEqual(again.issues, first.issues);
  assert.equal(again.repo, "me/app");
  assert.equal(again.project.id, "P1");
  // ...but not another place's, and not once gh says it is not a repo.
  assert.deepEqual((await check({ cwd: "/elsewhere", root: null }, flaky, first)).issues, []);
  assert.deepEqual((await check(place, fakes({ repo: notARepo }), first)).issues, []);
});

test("previous project issues are carried only for the same project", async () => {
  const one = fakes({ field: { code: 0, stdout: JSON.stringify({ data: { node: { field: { id: "F", options: [{ id: "1", name: "To Do" }] } } } }), stderr: "" } });
  const first = await check(place, one);
  const other = { ...PROJECT, id: "P2", title: "other" };
  const sameRepoNewProject = fakes({
    projects: { code: 0, stdout: JSON.stringify({ data: { repository: { projectsV2: { nodes: [other] } } } }), stderr: "" },
    field: { code: 1, stdout: "", stderr: "HTTP 502" },
  });
  assert.deepEqual((await check(place, sameRepoNewProject, first)).issues, [], "another project's status issues are not carried");
  const sameProject = fakes({ field: { code: 1, stdout: "", stderr: "HTTP 502" } });
  assert.deepEqual((await check(place, sameProject, first)).issues, first.issues);
});

test("gh signed out skips the project questions and keeps the last project issues", async () => {
  const deps = fakes({ auth: { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." } });
  const found = await check(place, deps);
  assert.deepEqual(kinds(found), ["gh-auth"]);
  assert.deepEqual(deps.calls, ["auth"]);
});

test("agents the host does not know are not flagged, ones it reports uninstalled are", async () => {
  const wf = (agent) => ({ name: "W", orchestrator: { agent }, worker: { agent }, reviewer: { agent } });
  const deps = fakes({ deps: { knownAgents: async () => [{ key: "claude", installed: true }, { key: "gemini", installed: false }], groomerAgent: () => "gemini", loadWorkflows: async () => ({ items: [wf("claude"), wf("mine")], errors: [] }) } });
  const found = await check(place, deps);
  assert.deepEqual(found.issues.map((i) => [i.kind, i.agent]), [["agent-missing", "gemini"]]);
});

test("a failed agent or workflow read is unknown", async () => {
  const deps = fakes({ deps: { knownAgents: async () => { throw new Error("no"); }, loadWorkflows: async () => { throw new Error("no"); }, groomerAgent: () => "gemini" } });
  assert.deepEqual((await check(place, deps)).issues, []);
});

// ---- The watcher -------------------------------------------------------------------------------------

function watcher(deps) {
  const cx = { timer: { every: () => {} }, spawn: () => {} };
  const doctor = new Doctor(cx, deps);
  return doctor;
}
const at = (deps, cwd, on) => deps.store.set(PLACE, { cwd, on });
const soon = () => new Promise((r) => setImmediate(r));

test("with no place yet nothing is checked or published, until a forced check", async () => {
  const deps = fakes();
  const doctor = watcher(deps);
  await doctor.look(false);
  assert.deepEqual(deps.writes, []);
  assert.deepEqual(deps.calls, []);
  await doctor.look(true);
  assert.equal(deps.writes.length, 1);
  assert.equal(deps.store.get(DOCTOR_KEY).place, null);
});

test("the answer is published with the place it was made for, and only when it changes", async () => {
  const deps = fakes({ deps: { groomerAgent: () => null } });
  const doctor = watcher(deps);
  at(deps, "/repo/src");
  await doctor.look(false);
  assert.equal(deps.writes.length, 1);
  assert.deepEqual(deps.store.get(DOCTOR_KEY).place, { cwd: "/repo/src", on: null, root: "/repo" });
  await doctor.look(true); // the slow check finds the same thing
  assert.equal(deps.writes.length, 1, "unchanged answers are not published again");
});

test("moving about inside one repo does not check again, and another repo or machine does", async () => {
  const deps = fakes();
  const doctor = watcher(deps);
  at(deps, "/repo/src");
  await doctor.look(false);
  const before = deps.calls.length;
  at(deps, "/repo/docs");
  await doctor.look(false);
  assert.equal(deps.calls.length, before);
  at(deps, "/repo/docs", "box");
  await doctor.look(false);
  assert.ok(deps.calls.length > before);
  const mid = deps.calls.length;
  at(deps, "/other/place");
  await doctor.look(false);
  assert.ok(deps.calls.length > mid);
});

test("a change to the workflows or the grooming agent checks again", async () => {
  let agent = null;
  const deps = fakes({ deps: { groomerAgent: () => agent } });
  const doctor = watcher(deps);
  at(deps, "/repo");
  await doctor.look(false);
  const n = deps.calls.length;
  await doctor.look(false);
  assert.equal(deps.calls.length, n);
  deps.store.set(WORKFLOWS_CHANGED, 5);
  await doctor.look(false);
  assert.ok(deps.calls.length > n);
  const m = deps.calls.length;
  agent = "gemini";
  await doctor.look(false);
  assert.ok(deps.calls.length > m);
});

test("an answer whose place changed during the check is dropped, and the new place is checked next", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = fakes({ repo: () => gate.then(() => ({ code: 0, stdout: JSON.stringify({ nameWithOwner: "me/app" }), stderr: "" })) });
  const doctor = watcher(deps);
  at(deps, "/repo");
  const running = doctor.look(false);
  await soon();
  at(deps, "/other"); // the person moved to another space while gh was answering
  release();
  await running;
  assert.deepEqual(deps.writes, [], "nothing is published for the old place");
  deps.answers.repo = notARepo;
  await doctor.look(false);
  assert.equal(deps.writes.length, 1);
  assert.equal(deps.store.get(DOCTOR_KEY).place.cwd, "/other");
});

test("only one check runs at a time", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = fakes({ auth: () => gate.then(() => OK_AUTH) });
  const doctor = watcher(deps);
  at(deps, "/repo");
  const first = doctor.look(false);
  await soon();
  await doctor.look(true); // returns at once: one is running
  assert.equal(deps.calls.filter((c) => c === "auth").length, 1);
  release();
  await first;
  assert.equal(doctor.running, false);
});

test("a hung check is given up on after the timeout, and the next look starts over", async () => {
  let hang = true, releaseHung;
  const hungGate = new Promise((r) => { releaseHung = r; });
  const deps = fakes({ auth: () => (hang ? hungGate.then(() => OK_AUTH) : OK_AUTH) });
  const doctor = watcher(deps);
  at(deps, "/repo");
  let timeoutAsked = null;
  await doctor.look(false, async (ms) => { timeoutAsked = ms; }); // the timeout fires at once
  assert.equal(timeoutAsked, TIMEOUT);
  assert.equal(doctor.running, false, "the guard is released");
  // The person moves on; the next look checks the new place, though the old check never finished.
  hang = false;
  at(deps, "/other");
  deps.answers.repo = notARepo;
  await doctor.look(false);
  assert.equal(deps.store.get(DOCTOR_KEY).place.cwd, "/other");
  // The old check finishing late publishes nothing.
  const writes = deps.writes.length;
  releaseHung();
  await soon(); await soon();
  assert.equal(deps.writes.length, writes);
  assert.equal(deps.store.get(DOCTOR_KEY).place.cwd, "/other");
});

test("after a timeout nothing new is started until the forced check, unless the place or what it depends on changes", async () => {
  let hang = true;
  const deps = fakes({ auth: () => (hang ? new Promise(() => {}) : OK_AUTH) });
  const doctor = watcher(deps);
  at(deps, "/repo");
  await doctor.look(false, async () => {});
  const stuck = deps.calls.length;
  hang = false;
  await doctor.look(false);
  await doctor.look(false);
  assert.equal(deps.calls.length, stuck, "the 2s looks start no more checks");
  assert.equal(deps.writes.length, 0);
  await doctor.look(true); // the 60s check tries again
  assert.equal(deps.writes.length, 1);
});

test("after a timeout a changed place or workflow still checks at the next look", async () => {
  for (const change of [(deps) => at(deps, "/other"), (deps) => deps.store.set(WORKFLOWS_CHANGED, 3)]) {
    const deps = fakes({ auth: () => new Promise(() => {}) });
    const doctor = watcher(deps);
    at(deps, "/repo");
    await doctor.look(false, async () => {});
    const stuck = deps.calls.length;
    change(deps);
    deps.answers.auth = OK_AUTH;
    await doctor.look(false);
    assert.ok(deps.calls.length > stuck);
  }
});

test("a repo-root lookup that hangs is not asked again by the 2s looks", async () => {
  let asked = 0;
  const deps = fakes({ deps: { repoRootOf: () => { asked++; return new Promise(() => {}); } } });
  const doctor = watcher(deps);
  at(deps, "/repo");
  await doctor.look(false, async () => {});
  await doctor.look(false);
  await doctor.look(false);
  assert.equal(asked, 1);
  await doctor.look(true, async () => {});
  assert.equal(asked, 2, "the forced check asks again");
});

test("picking another project in the sidebar checks again at the next look", async () => {
  let picked;
  const deps = fakes({ deps: { chosenProject: () => picked } });
  const doctor = watcher(deps);
  at(deps, "/repo");
  await doctor.look(false);
  const n = deps.calls.length;
  await doctor.look(false);
  assert.equal(deps.calls.length, n, "nothing changed: no check");
  picked = "P2";
  await doctor.look(false);
  assert.ok(deps.calls.length > n, "the picked project changed");
  const m = deps.calls.length;
  await doctor.look(false);
  assert.equal(deps.calls.length, m, "and settles after one check");
});

test("after a timeout, going to another place and back checks the first again", async () => {
  let hang = true;
  const deps = fakes({ auth: () => (deps.store.get(PLACE).cwd === "/a" && hang ? new Promise(() => {}) : OK_AUTH) });
  const doctor = watcher(deps);
  at(deps, "/a");
  await doctor.look(false, async () => {}); // A hangs
  at(deps, "/b");
  deps.answers.repo = notARepo;
  await doctor.look(false); // B is fine
  assert.equal(deps.store.get(DOCTOR_KEY).place.cwd, "/b");
  hang = false;
  at(deps, "/a");
  await doctor.look(false);
  assert.equal(deps.store.get(DOCTOR_KEY).place.cwd, "/a", "A is not held back by its old timeout");
});

test("after a timeout, moving about inside the same repo starts no new check", async () => {
  const deps = fakes({ auth: () => new Promise(() => {}) });
  const doctor = watcher(deps);
  at(deps, "/repo/src");
  await doctor.look(false, async () => {});
  const stuck = deps.calls.length;
  at(deps, "/repo/docs"); // a folder never asked about, inside the repo the check is stuck on
  await doctor.look(false);
  assert.equal(deps.calls.length, stuck);
});

test("after a timeout a new grooming agent or a newly picked project checks at the next look", async () => {
  for (const change of ["agent", "project"]) {
    let agent = null, picked, hang = false;
    const deps = fakes({ auth: () => (hang ? new Promise(() => {}) : OK_AUTH), deps: { groomerAgent: () => agent, chosenProject: () => picked } });
    const doctor = watcher(deps);
    at(deps, "/repo");
    await doctor.look(false); // answered once, so the repo is known
    deps.store.set(WORKFLOWS_CHANGED, 7);
    hang = true;
    await doctor.look(false, async () => {}); // times out
    const stuck = deps.calls.length;
    hang = false;
    await doctor.look(false);
    assert.equal(deps.calls.length, stuck, "held back");
    if (change === "agent") agent = "gemini"; else picked = "P2";
    await doctor.look(false);
    assert.ok(deps.calls.length > stuck, change);
  }
});

test("a project picked while the check runs is not missed", async () => {
  let picked, release;
  const gate = new Promise((r) => { release = r; });
  const field = { code: 0, stdout: JSON.stringify({ data: { node: { field: { id: "F", options: ALL.map((name, i) => ({ id: String(i), name })) } } } }), stderr: "" };
  const deps = fakes({ field: () => gate.then(() => field), deps: { chosenProject: () => picked } });
  const doctor = watcher(deps);
  at(deps, "/repo");
  const running = doctor.look(false);
  await soon(); await soon(); await soon();
  picked = "P2"; // after the check read the pick, before it finished
  release();
  await running;
  const n = deps.calls.length;
  await doctor.look(false);
  assert.ok(deps.calls.length > n, "checked again for the new pick");
  const m = deps.calls.length;
  await doctor.look(false);
  assert.equal(deps.calls.length, m, "and then settles");
});

test("a check that throws leaves the last answer and is tried again", async () => {
  const deps = fakes();
  const doctor = watcher(deps);
  at(deps, "/repo");
  deps.setShared = () => { throw new Error("boom"); };
  await doctor.look(false);
  assert.equal(doctor.running, false);
  assert.equal(doctor.sig, null);
});

test("a look with nothing to do starts no timeout", async () => {
  const deps = fakes();
  const doctor = watcher(deps);
  at(deps, "/repo");
  await doctor.look(false); // the first look checks
  const asked = [];
  const sleep = async (ms) => { asked.push(ms); };
  await doctor.look(false, sleep); // nothing changed: no work, no timer
  await doctor.look(false, sleep);
  assert.deepEqual(asked, []);
  deps.store.set(WORKFLOWS_CHANGED, 9);
  await doctor.look(false, () => new Promise(() => { asked.push("check"); }));
  assert.deepEqual(asked, ["check"], "a check starts one");
  const none = watcher(fakes());
  await none.look(false, sleep); // no place yet
  assert.deepEqual(asked, ["check"]);
});

test("a failed repo-root lookup is asked again; an answer is kept", async () => {
  let fail = true, asked = 0;
  const deps = fakes({ deps: { repoRootOf: async () => { asked++; if (fail) throw new Error("transient"); return "/repo"; } } });
  const doctor = watcher(deps);
  at(deps, "/repo/src");
  await doctor.look(false);
  assert.equal(deps.store.get(DOCTOR_KEY).place.root, null);
  fail = false;
  await doctor.look(false); // the signature changes with the root, so this checks again
  assert.equal(deps.store.get(DOCTOR_KEY).place.root, "/repo");
  const n = asked;
  await doctor.look(false);
  await doctor.look(false);
  assert.equal(asked, n, "the answer is cached");
});
