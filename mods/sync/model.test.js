import test from "node:test";
import assert from "node:assert/strict";
import {
  NO_REPO, parseSyncJson, parseLinkInfo, nextPick, parseOutcome, parseTargets, viewState, statusLine, ago, shortError,
  relativeTo, tildePath,
} from "./model.js";

test("sync.json: the repo and the remote, or nothing when it is missing or unusable", () => {
  assert.deepEqual(parseSyncJson('{"repo": "/r", "remote": "git@h:o/r.git"}\n'), { repo: "/r", remote: "git@h:o/r.git" });
  assert.deepEqual(parseSyncJson('{"repo": "/r", "remote": ""}'), { repo: "/r", remote: "" });
  assert.deepEqual(parseSyncJson('{"repo": "/r"}'), { repo: "/r", remote: "" });
  assert.equal(parseSyncJson(null), null);
  assert.equal(parseSyncJson(""), null);
  assert.equal(parseSyncJson("not json"), null);
  assert.equal(parseSyncJson('{"repo": ""}'), null);
  assert.equal(parseSyncJson('{"repo": 3}'), null);
  assert.equal(parseSyncJson("[1]"), null);
});

test("the link check's answer", () => {
  assert.deepEqual(parseLinkInfo("@repo\t/r\n@dir\t/r-wt\n@branch\tfeature\n"), { gone: false, repo: "/r", dir: "/r-wt", branch: "feature" });
  assert.deepEqual(parseLinkInfo("@repo\t/r\n@dir\t/r\n@branch\t\n"), { gone: false, repo: "/r", dir: "/r", branch: "" });
  assert.deepEqual(parseLinkInfo("@gone\n"), { gone: true, repo: "", dir: "", branch: "" });
  assert.deepEqual(parseLinkInfo(""), { gone: true, repo: "", dir: "", branch: "" });
});

test("the picked worktree is remembered for one repo and reset when the linked repo changes", () => {
  assert.deepEqual(nextPick({ repo: "/r", dir: "/r-wt" }, "/r"), { repo: "/r", dir: "/r-wt" });
  assert.deepEqual(nextPick({ repo: "/r", dir: "/r-wt" }, "/other"), { repo: "/other", dir: "" });
  assert.deepEqual(nextPick(null, "/r"), { repo: "/r", dir: "" });
  assert.deepEqual(nextPick({ repo: "/r", dir: 5 }, "/r"), { repo: "/r", dir: "" });
});

test("what the panel and the button show", () => {
  const linked = { linked: true, repo: "/r", dir: "/r", branch: "main", remote: "" };
  assert.equal(viewState({ link: undefined, run: null }), "loading");
  assert.equal(viewState({ link: null, run: null }), "loading");
  assert.equal(viewState({ link: { linked: false }, run: null }), "unlinked");
  assert.equal(viewState({ link: linked, run: null }), "ok");
  assert.equal(viewState({ link: linked, run: { syncing: false, ok: true } }), "ok");
  assert.equal(viewState({ link: linked, run: { syncing: true, ok: false } }), "busy");
  assert.equal(viewState({ link: linked, run: { syncing: false, ok: false, message: "boom" } }), "error");
  assert.equal(viewState({ link: { linked: false }, run: { syncing: true } }), "unlinked", "nothing runs without a repo");
});

test("the status line", () => {
  const now = 1_000_000;
  assert.equal(statusLine({ syncing: true, at: now - 5000, watching: true }, now), "Syncing…");
  assert.equal(statusLine({ syncing: false, ok: true, at: now - 12000, watching: true }, now), "Synced 12s ago · watching for changes");
  assert.equal(statusLine({ syncing: false, ok: false, at: now - 12000, message: "The sync script failed: x", watching: true }, now), "The sync script failed: x");
  assert.equal(statusLine({ syncing: false, ok: false, message: "", watching: true }, now), "The last sync failed");
  assert.equal(statusLine(null, now), "Not synced yet");
  assert.equal(statusLine({ watching: true }, now), "Not synced yet · watching for changes");
  assert.equal(statusLine({ ok: true, at: now - 1000, watching: false, watchError: "too many folders" }, now), "Synced just now · not watching (too many folders)");
  assert.equal(statusLine({ ok: true, at: now - 1000, watching: false }, now), "Synced just now");
});

test("the one line shown when nothing is linked", () => {
  assert.equal(NO_REPO, "No repo linked. Run mods/sync/sync.sh from your clone.");
});

test("how long ago", () => {
  assert.equal(ago(0), "");
  assert.equal(ago(1000, 3000), "just now");
  assert.equal(ago(1000, 13000), "12s ago");
  assert.equal(ago(1, 59000), "58s ago");
  assert.equal(ago(1, 5 * 60000 + 1), "5 min ago");
  assert.equal(ago(1, 2 * 3600000 + 1), "2 h ago");
});

test("a folder shown relative to the picked folder, and with ~ for home", () => {
  assert.equal(relativeTo("/r", "/r/mods/a/main.js"), "mods/a/main.js");
  assert.equal(relativeTo("/r/", "/r/mods/a"), "mods/a");
  assert.equal(relativeTo("/r", "/r"), "");
  assert.equal(relativeTo("/r", "/r2/x"), "/r2/x", "a sibling folder with the same prefix is not inside");
  assert.equal(relativeTo("/r", "/elsewhere/x"), "/elsewhere/x");
  assert.equal(tildePath("/Users/me/projects/ws", "/Users/me"), "~/projects/ws");
  assert.equal(tildePath("/Users/me", "/Users/me"), "~");
  assert.equal(tildePath("/Users/mee/x", "/Users/me"), "/Users/mee/x");
  assert.equal(tildePath("/srv/ws", ""), "/srv/ws");
});

test("the script's last words become an outcome", () => {
  assert.deepEqual(parseOutcome("noise\n@result\tok\n@msg\tSynced"), { result: "ok", message: "Synced", extra: {} });
  assert.equal(parseOutcome("@result\tok\n@pushed\t2").extra.pushed, "2");
  assert.equal(parseOutcome("boom").result, "error");
  assert.equal(parseOutcome("boom\nlast words").message, "last words");
});

test("small helpers", () => {
  assert.equal(shortError("a\nb\n  \n"), "b");
  assert.equal(shortError(""), "");
});

test("the worktree, branch and checkout lists", () => {
  const t = parseTargets("@worktree\t/r\tmain\t1700\n@worktree\t/r-wt\tfeature/x\t\n@worktree\t/r-det\t\t5\n@branch\tmain\t1690\n@branch\told\t\n@checkout\t1700\t0\tmain\n@checkout\t1650\t3\tfeature/x\n");
  assert.deepEqual(t.worktrees, [{ path: "/r", branch: "main", at: 1700 }, { path: "/r-wt", branch: "feature/x", at: null }, { path: "/r-det", branch: "", at: 5 }]);
  assert.deepEqual(t.branches, [{ name: "main", at: 1690 }, { name: "old", at: null }]);
  assert.deepEqual(t.checkouts, [{ at: 1700, idx: 0, branch: "main" }, { at: 1650, idx: 3, branch: "feature/x" }]);
  assert.deepEqual(parseTargets(""), { worktrees: [], branches: [], checkouts: [] });
  assert.deepEqual(parseTargets("@checkout\tnot-a-time\t0\tx\n@checkout\t5\t0\t\n").checkouts, [], "unusable checkout lines are dropped");
});
