import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS, normalizeSettings, settingsFor, parseCheck, parseOutcome, changedFiles, badge, viewState,
  commitMessage, plural, shortError, ago, pushBlocked, canPush, parseTargets,
  fetchBlocksCheck, FETCH_GUARD_MS,
} from "./model.js";

test("settings default to ./scripts/sync/sync.sh, with no repo and no picked worktree", () => {
  assert.deepEqual(normalizeSettings(undefined), { repo: "", script: "./scripts/sync/sync.sh", dir: "" });
  assert.deepEqual(normalizeSettings({ repo: "  ~/cfg ", script: " " }), { repo: "~/cfg", script: "./scripts/sync/sync.sh", dir: "" });
  assert.deepEqual(normalizeSettings({ repo: "/r", script: "sh sync.sh", dir: " /r-wt " }), { repo: "/r", script: "./scripts/sync/sync.sh", dir: "/r-wt" });
  assert.equal(DEFAULTS.script, "./scripts/sync/sync.sh");
});

test("the sync script is not configurable: it is always ./scripts/sync/sync.sh", () => {
  assert.equal(normalizeSettings({ script: "./mount.sh" }).script, "./scripts/sync/sync.sh");
  assert.equal(normalizeSettings({ script: "sh other.sh" }).script, "./scripts/sync/sync.sh");
  assert.equal(settingsFor({ vps: { script: "x.sh" } }, "vps").script, "./scripts/sync/sync.sh");
});
test("settings are kept per machine, this computer under the empty key", () => {
  const all = { "": { repo: "/a" }, vps: { repo: "/b" } };
  assert.equal(settingsFor(all, "").repo, "/a");
  assert.deepEqual(settingsFor(all, "vps"), { repo: "/b", script: "./scripts/sync/sync.sh", dir: "" });
  assert.equal(settingsFor(all, "other").repo, "");
  assert.equal(settingsFor(null, "").repo, "");
});

const CHECK = [
  "@top\t/work/cfg",
  "@host\tmac",
  "@branch\tmain\torigin/main",
  "@behind\tabc1234\tFix the thing",
  "@behind\tdef5678\tAdd a mod",
  "@ahead\t9999999\tSync 1 file",
  "@file\t M\tmods/sync/main.js",
  "@file\t??\tskillshare/skills/mine/new/SKILL.md",
  "@file\tUU\tREADME.md",
  "@inprogress\trebase",
  "@herdr\tmods/sync/main.js",
  "@herdr\tlayouts/Tony.json",
  "to repo: mods/sync/main.js",
  "to repo (new): layouts/Tony.json",
  "to Herdr: mods/usage/main.js",
  "@end",
].join("\n");

test("reads the check script's output", () => {
  const s = parseCheck(CHECK);
  assert.equal(s.repo, true);
  assert.equal(s.top, "/work/cfg");
  assert.equal(s.host, "mac");
  assert.equal(s.branch, "main");
  assert.equal(s.upstream, "origin/main");
  assert.deepEqual(s.behind, [{ hash: "abc1234", subject: "Fix the thing" }, { hash: "def5678", subject: "Add a mod" }]);
  assert.deepEqual(s.unpushed, [{ hash: "9999999", subject: "Sync 1 file" }]);
  assert.deepEqual(s.uncommitted.map((f) => f.path), ["mods/sync/main.js", "skillshare/skills/mine/new/SKILL.md", "README.md"]);
  assert.deepEqual(s.unmerged, ["README.md"]);
  assert.equal(s.inProgress, "rebase");
  assert.deepEqual(s.herdr, ["mods/sync/main.js", "layouts/Tony.json"]);
});

test("a folder that is not a repo, or a missing script, is reported", () => {
  assert.deepEqual(parseCheck("@norepo\n"), { repo: false, error: null });
  assert.equal(parseCheck("@top\t/x\n@noscript\t./scripts/sync/sync.sh\n@end").error, "./scripts/sync/sync.sh was not found in the repo");
  assert.equal(parseCheck("@top\t/x\n@recipe\t1\n@noscript\t./scripts/sync/sync.sh\n@end").noScript, true);
  assert.equal(parseCheck("@top\t/x\n@recipe\t1\n@end").recipe, true);
  assert.equal(parseCheck("").error, "No answer from the repo");
});

test("a failed script or fetch is reported without losing the rest", () => {
  assert.equal(parseCheck("@top\t/x\n@scripterr\tboom\n@end").error, "The sync script failed: boom");
  const s = parseCheck("@top\t/x\n@fetcherr\tCould not resolve host\n@end");
  assert.equal(s.fetchError, "Could not resolve host");
  assert.equal(s.error, null);
});

test("a Herdr file already copied into the repo counts once", () => {
  const files = changedFiles({
    herdr: ["mods/sync/main.js", "layouts/Tony.json"],
    uncommitted: [{ code: "M", path: "mods/sync/main.js" }, { code: "??", path: "skillshare/skills/mine/x/SKILL.md" }],
  });
  assert.deepEqual(files.map((f) => f.path), ["mods/sync/main.js", "layouts/Tony.json", "skillshare/skills/mine/x/SKILL.md"]);
  assert.deepEqual(files.map((f) => f.where), ["herdr", "herdr", "repo"]);
});

test("the badge counts commits behind and unique changed files; nothing at zero", () => {
  const base = { repo: true, behind: [], herdr: [], uncommitted: [], unpushed: [{ hash: "a", subject: "x" }] };
  assert.deepEqual(badge(base), { down: 0, up: 0, text: "" }); // unpushed commits are not in the badge
  assert.equal(badge({ ...base, behind: [{}, {}, {}] }).text, "↓3");
  assert.equal(badge({ ...base, herdr: ["a", "b"], uncommitted: [{ code: "M", path: "x/a" }, { code: "M", path: "z" }] }).text, "↑3");
  assert.equal(badge({ ...base, behind: [{}], herdr: ["a"] }).text, "↓1 ↑1");
  assert.equal(badge(null).text, "");
});

test("the button's state", () => {
  const ok = { repo: true, behind: [], herdr: [], uncommitted: [], unmerged: [], inProgress: null };
  assert.equal(viewState({ settings: { repo: "" }, state: null }), "unset");
  assert.equal(viewState({ settings: { repo: "/r" }, state: null }), "loading");
  assert.equal(viewState({ settings: { repo: "/r" }, state: { repo: false } }), "norepo");
  assert.equal(viewState({ settings: { repo: "/r" }, state: { ...ok, error: "x" } }), "error");
  assert.equal(viewState({ settings: { repo: "/r" }, state: ok }), "ok");
  assert.equal(viewState({ settings: { repo: "/r" }, state: ok, busy: "Pulling" }), "busy");
});

test("how long ago", () => {
  assert.equal(ago(0), "");
  assert.equal(ago(1000, 20000), "just now");
  assert.equal(ago(0 + 1, 5 * 60000 + 1), "5 min ago");
  assert.equal(ago(1, 2 * 3600000 + 1), "2 h ago");
});

test("the default commit message names the count and the machine", () => {
  assert.equal(commitMessage(5, "mac"), "Sync 5 files from Herdr on mac");
  assert.equal(commitMessage(1, "mac"), "Sync 1 file from Herdr on mac");
  assert.equal(commitMessage(0, ""), "Sync from Herdr");
  assert.equal(commitMessage(2, ""), "Sync 2 files from Herdr");
});

test("the script's last words become an outcome", () => {
  assert.deepEqual(parseOutcome("noise\n@result\tok\n@msg\tPushed 2 files"), { result: "ok", message: "Pushed 2 files", extra: {} });
  assert.equal(parseOutcome("@result\tok\n@pushed\t2").extra.pushed, "2");
  assert.equal(parseOutcome("boom").result, "error");
  assert.equal(parseOutcome("boom\nlast words").message, "last words");
});

test("repo files newer than Herdr are kept apart from Herdr changes, block Push and are not in ↑", () => {
  const s = parseCheck("@top\t/r\n@herdr\tmods/a/main.js\n@newer\tmods/b/main.js\n@newer\tmods/c/main.js\n@end\n");
  assert.deepEqual(s.herdr, ["mods/a/main.js"]);
  assert.deepEqual(s.repoNewer, ["mods/b/main.js", "mods/c/main.js"]);
  assert.equal(badge(s).up, 1);
  assert.equal(pushBlocked(s), true);
  assert.equal(pushBlocked(parseCheck("@top\t/r\n@end\n")), false);
  assert.equal(pushBlocked(null), false);
});

test("small helpers", () => {
  assert.equal(plural(1, "commit"), "1 commit");
  assert.equal(plural(3, "commit"), "3 commits");
  assert.equal(shortError("a\nb\n  \n"), "b");
  assert.equal(shortError(""), "");
});

test("a fetch in flight blocks plain checks for about 60 s, then stops blocking", () => {
  const t0 = 1_000_000;
  assert.equal(fetchBlocksCheck(undefined, t0), false);
  assert.equal(fetchBlocksCheck(null, t0), false);
  assert.equal(fetchBlocksCheck(t0, t0 + 20000), true);
  assert.equal(fetchBlocksCheck(t0, t0 + FETCH_GUARD_MS - 1), true);
  assert.equal(fetchBlocksCheck(t0, t0 + FETCH_GUARD_MS), false, "a hung fetch no longer freezes the badge");
});

test("Push is only for main", () => {
  assert.equal(canPush({ branch: "main" }), true);
  assert.equal(canPush({ branch: "workflow/x" }), false);
  assert.equal(canPush({ branch: null }), false);
  assert.equal(canPush(null), false);
});

test("the worktree and branch lists", () => {
  const t = parseTargets("@worktree\t/r\tmain\n@worktree\t/r-wt\tfeature/x\n@branch\tmain\t/r\n@branch\told\t\n");
  assert.deepEqual(t.worktrees, [{ path: "/r", branch: "main" }, { path: "/r-wt", branch: "feature/x" }]);
  assert.deepEqual(t.branches, [{ name: "main", path: "/r" }, { name: "old", path: "" }]);
  assert.deepEqual(parseTargets(""), { worktrees: [], branches: [] });
});
