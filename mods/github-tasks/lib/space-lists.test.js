import test from "node:test";
import assert from "node:assert/strict";
import { SpaceLists, spaceKey, newList, resetList, forgetRepo, clearTickets, snapshotOf, restoreList, applyPlace, applyRepo, applyProject, failReload, doneReload, isCurrent } from "./space-lists.js";

const ctx = (space, folder = "/code/app", on) => ({ space, on, folder });
const tickets = (...titles) => ({ open: titles.map((title) => ({ key: title, title })), closed: [] });
const place = (mainRoot = "/code/app") => ({ mainRoot, folder: "/code/app", remote: false, cache: { c: 1 } });

// A view as the Tasks sidebar has it once a GitHub list is on screen.
function github(over = {}) {
  const view = newList(ctx("a"));
  Object.assign(view, {
    place: place(), repo: "me/app", repoFolder: "/code/app",
    projects: [{ id: "P1", title: "One" }, { id: "P2", title: "Two" }], project: { id: "P1", title: "One" },
    groups: tickets("first", "second"), truncated: true, loaded: true,
  }, over);
  return view;
}
test("the key of a space is its id and machine", () => {
  assert.equal(spaceKey(ctx("a")), "a|undefined");
  assert.equal(spaceKey(ctx("a", "/x", "box")), "a|box");
  assert.equal(spaceKey(null), null);
});

test("a new list is empty and not restored", () => {
  const view = newList(ctx("a"));
  assert.equal(view.loaded, false);
  assert.equal(view.repo, null);
  assert.deepEqual(view.groups, { open: [], closed: [] });
  assert.equal(view.restored, null);
});

test("resetting starts over and makes an earlier load stale", () => {
  const view = github({ error: { kind: "other" }, setupError: "s", startError: "e", loading: true });
  const token = view.token;
  resetList(view, ctx("b"));
  assert.equal(isCurrent(view, token), false);
  assert.equal(view.ctx.space, "b");
  assert.equal(view.loading, false);
  assert.equal(view.loaded, false);
  assert.equal(view.repo, null);
  assert.equal(view.place, null);
  assert.equal(view.error, null);
  assert.equal(view.setupError, null);
});

test("a GitHub list on screen is saved with everything the settings and chips show", () => {
  const snap = snapshotOf(github());
  assert.equal(snap.repo, "me/app");
  assert.equal(snap.repoFolder, "/code/app");
  assert.equal(snap.project.id, "P1");
  assert.equal(snap.projects.length, 2);
  assert.equal(snap.truncated, true);
  assert.deepEqual(snap.groups, tickets("first", "second"));
});

test("errors are never saved", () => {
  const snap = snapshotOf(github({ error: { kind: "other" }, setupError: "s", startError: "e" }));
  assert.equal("error" in snap || "setupError" in snap || "startError" in snap, false);
});

test("nothing on screen saves nothing", () => {
  assert.equal(snapshotOf(newList(ctx("a"))), null);
  assert.equal(snapshotOf(github({ loaded: false })), null); // placeholders
  assert.equal(snapshotOf(github({ project: null })), null); // the repo has no project
  assert.equal(snapshotOf(github({ repoFolder: "/elsewhere" })), null); // the folder moved and the repo is not known again yet
});

test("leaving a space with a list saves it; leaving it empty forgets an older one", () => {
  const lists = new SpaceLists();
  lists.save("a|undefined", github());
  assert.ok(lists.has("a|undefined"));
  lists.save("a|undefined", newList(ctx("a")));
  assert.equal(lists.has("a|undefined"), false);
});

test("switching back shows the saved list at once, with no placeholders", () => {
  const lists = new SpaceLists();
  const view = github();
  lists.save("a|undefined", view);
  resetList(view, ctx("b")); // the sidebar moved to b
  assert.equal(view.loaded, false);
  resetList(view, ctx("a"));
  assert.equal(lists.restore("a|undefined", view), true);
  assert.equal(view.loaded, true);
  assert.deepEqual(view.groups, tickets("first", "second"));
  assert.equal(view.truncated, true);
  assert.equal(view.repo, "me/app");
  assert.equal(view.project.id, "P1");
  assert.equal(view.projects.length, 2);
  assert.equal(view.error, null);
  assert.ok(view.restored);
});

test("a space not opened yet this session shows placeholders", () => {
  const lists = new SpaceLists();
  const view = newList(ctx("z"));
  assert.equal(lists.restore("z|undefined", view), false);
  assert.equal(view.loaded, false);
  assert.equal(view.restored, null);
});

test("each space keeps its own list", () => {
  const lists = new SpaceLists();
  lists.save("a|undefined", github());
  lists.save("b|undefined", github({ repo: "me/other", groups: tickets("other") }));
  const view = newList(ctx("a"));
  lists.restore("a|undefined", view);
  assert.equal(view.repo, "me/app");
  const other = newList(ctx("b"));
  lists.restore("b|undefined", other);
  assert.equal(other.repo, "me/other");
  assert.deepEqual(other.groups, tickets("other"));
});

test("a saved list is not changed by what happens to the one on screen", () => {
  const lists = new SpaceLists();
  const view = github();
  lists.save("a|undefined", view);
  resetList(view, ctx("a"));
  lists.restore("a|undefined", view);
  forgetRepo(view);
  const again = newList(ctx("a"));
  assert.equal(lists.restore("a|undefined", again), true);
  assert.equal(again.repo, "me/app");
  assert.equal(again.groups.open.length, 2);
});

function restoredGithub() {
  const lists = new SpaceLists();
  const view = github();
  lists.save("a|undefined", view);
  resetList(view, ctx("a"));
  lists.restore("a|undefined", view);
  return view;
}

test("a reload of the same repo and project keeps the list until the fresh one replaces it", () => {
  const view = restoredGithub();
  applyPlace(view, place());
  assert.deepEqual(view.place, place());
  assert.deepEqual(view.placeCache, { c: 1 });
  assert.equal(applyRepo(view, "me/app"), false);
  view.projects = [{ id: "P1" }, { id: "P2" }];
  view.project = { id: "P1" };
  applyProject(view);
  assert.equal(view.loaded, true);
  assert.deepEqual(view.groups, tickets("first", "second"));
  view.groups = tickets("fresh");
  doneReload(view);
  assert.equal(view.restored, null);
  assert.deepEqual(view.groups, tickets("fresh"));
});

test("a failed reload drops the saved list and leaves only the error", () => {
  const view = restoredGithub();
  assert.equal(failReload(view), true);
  assert.equal(view.loaded, false);
  assert.deepEqual(view.groups, { open: [], closed: [] });
  assert.equal(view.repo, null);
  assert.equal(view.project, null);
  assert.equal(view.truncated, false);
});

test("a failure with nothing restored leaves a list loaded by this space alone, as before", () => {
  const view = github();
  assert.equal(failReload(view), false);
  assert.equal(view.loaded, true);
  assert.equal(view.groups.open.length, 2);
});

test("a changed repo drops the saved list", () => {
  const view = restoredGithub();
  assert.equal(applyRepo(view, "me/new"), true);
  assert.equal(view.repo, "me/new");
  assert.equal(view.loaded, false);
  assert.deepEqual(view.groups, { open: [], closed: [] });
  assert.deepEqual(view.projects, []);
});

test("a changed project drops the saved list", () => {
  const view = restoredGithub();
  view.projects = [{ id: "P1" }, { id: "P2" }];
  view.project = { id: "P2" };
  applyProject(view);
  assert.equal(view.loaded, false);
  assert.deepEqual(view.groups, { open: [], closed: [] });
});

test("a project that is gone drops the saved list", () => {
  const view = restoredGithub();
  view.projects = [];
  view.project = null;
  applyProject(view);
  assert.equal(view.loaded, false);
});

test("choosing a project with the chips is as before", () => {
  const view = github();
  view.project = { id: "P2" };
  applyProject(view); // nothing was restored
  assert.equal(view.loaded, true);
});

test("a late answer from the space left is ignored", () => {
  const view = github();
  const lists = new SpaceLists();
  const token = view.token; // a load of space a starts
  lists.save("a|undefined", view);
  resetList(view, ctx("b")); // the person switches to b
  assert.equal(isCurrent(view, token), false); // a's load finishes late: main.js drops it on this check
  const second = view.token;
  resetList(view, ctx("a")); // and back to a
  lists.restore("a|undefined", view);
  assert.equal(isCurrent(view, token), false);
  assert.equal(isCurrent(view, second), false); // the load b started is stale too
  assert.equal(isCurrent(view, view.token), true);
});

test("switching spaces quickly never shows one space's list in another", () => {
  const lists = new SpaceLists();
  const view = github();
  lists.save("a|undefined", view);
  resetList(view, ctx("b"));
  lists.restore("b|undefined", view); // b was never opened
  assert.equal(view.loaded, false);
  assert.equal(view.repo, null);
  assert.deepEqual(view.groups, { open: [], closed: [] });
});

test("a restored list leaving again is saved again, and one dropped by a reload is forgotten", () => {
  const lists = new SpaceLists();
  const view = restoredGithub();
  lists.save("a|undefined", view);
  assert.ok(lists.has("a|undefined"));
  applyRepo(view, "me/new");
  lists.save("a|undefined", view);
  assert.equal(lists.has("a|undefined"), false);
});

test("clearing tickets and forgetting the repo empty the list", () => {
  const view = github();
  clearTickets(view);
  assert.equal(view.loaded, false);
  assert.equal(view.repo, "me/app");
  forgetRepo(view);
  assert.equal(view.repo, null);
  assert.deepEqual(view.projects, []);
});
