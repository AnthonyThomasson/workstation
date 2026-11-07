import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS, normalizeSettings, settingsFor, parseCheck, parseOutcome, changedFiles, badge, viewState,
  commitMessage, conflictBrief, resolved, plural, shortError, ago,
} from "./model.js";

test("settings default to ./mount.sh and Claude Code, with no repo", () => {
  assert.deepEqual(normalizeSettings(undefined), { repo: "", script: "./mount.sh", agent: "claude" });
  assert.deepEqual(normalizeSettings({ repo: "  ~/cfg ", script: " ", agent: "" }), { repo: "~/cfg", script: "./mount.sh", agent: "claude" });
  assert.deepEqual(normalizeSettings({ repo: "/r", script: "sh sync.sh", agent: "codex" }), { repo: "/r", script: "sh sync.sh", agent: "codex" });
  assert.equal(DEFAULTS.script, "./mount.sh");
});

test("settings are kept per machine, this computer under the empty key", () => {
  const all = { "": { repo: "/a" }, vps: { repo: "/b", agent: "codex" } };
  assert.equal(settingsFor(all, "").repo, "/a");
  assert.deepEqual(settingsFor(all, "vps"), { repo: "/b", script: "./mount.sh", agent: "codex" });
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
  "@file\t M\therdr/sync/mods/sync/main.js",
  "@file\t??\tskillshare/skills/mine/new/SKILL.md",
  "@file\tUU\tREADME.md",
  "@inprogress\trebase",
  "@herdr\tmods/sync/main.js",
  "@herdr\tlayouts/Tony.json",
  "to repo: mods/sync/main.js",
  "to repo (new): layouts/Tony.json",
  "to Herdr: mods/usage/main.js",
  "Tony copy (changed): herdr/tony/mods/sync/main.js",
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
  assert.deepEqual(s.uncommitted.map((f) => f.path), ["herdr/sync/mods/sync/main.js", "skillshare/skills/mine/new/SKILL.md", "README.md"]);
  assert.deepEqual(s.unmerged, ["README.md"]);
  assert.equal(s.inProgress, "rebase");
  assert.deepEqual(s.herdr, ["mods/sync/main.js", "layouts/Tony.json"]);
});

test("a folder that is not a repo, or a missing script, is reported", () => {
  assert.deepEqual(parseCheck("@norepo\n"), { repo: false, error: null });
  assert.equal(parseCheck("@top\t/x\n@noscript\t./mount.sh\n@end").error, "The sync script ./mount.sh was not found in the repo");
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
    uncommitted: [{ code: "M", path: "herdr/sync/mods/sync/main.js" }, { code: "??", path: "skillshare/skills/mine/x/SKILL.md" }],
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
  assert.equal(viewState({ settings: { repo: "/r" }, state: ok, conflict: { files: [] } }), "conflict");
  assert.equal(viewState({ settings: { repo: "/r" }, state: ok, conflict: { files: [] }, busy: "Pushing" }), "busy");
});

test("a conflict is resolved once nothing is half done and the remote is contained", () => {
  assert.equal(resolved({ inProgress: null, unmerged: [], behind: [] }), true);
  assert.equal(resolved({ inProgress: "rebase", unmerged: [], behind: [] }), false);
  assert.equal(resolved({ inProgress: null, unmerged: ["a"], behind: [] }), false);
  assert.equal(resolved({ inProgress: null, unmerged: [], behind: [{}] }), false);
  assert.equal(resolved(null), false);
  // A copy conflict stays until its files are no longer uncommitted.
  const copy = { kind: "copy", files: [{ path: "a.js" }] };
  assert.equal(resolved({ inProgress: null, unmerged: [], behind: [], uncommitted: [{ path: "a.js" }] }, copy), false);
  assert.equal(resolved({ inProgress: null, unmerged: [], behind: [], uncommitted: [{ path: "b.js" }] }, copy), true);
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
  assert.deepEqual(parseOutcome("noise\n@result\tok\n@msg\tPushed 2 files"), { result: "ok", message: "Pushed 2 files", files: [], extra: {} });
  const c = parseOutcome("@result\tconflict\n@conflict\tREADME.md\tEdit readme\tReword readme\n@conflict\ta/b.js\t\tx\n@saved\t.sync-backup/conflict-1");
  assert.equal(c.result, "conflict");
  assert.deepEqual(c.files, [{ path: "README.md", remote: "Edit readme", local: "Reword readme" }, { path: "a/b.js", remote: "", local: "x" }]);
  assert.equal(c.extra.saved, ".sync-backup/conflict-1");
  assert.equal(parseOutcome("boom").result, "error");
  assert.equal(parseOutcome("boom\nlast words").message, "last words");
});

test("the brief for the conflict agent names every file and both sides", () => {
  const brief = conflictBrief({
    repo: "/work/cfg", script: "./mount.sh", kind: "rebase",
    files: [{ path: "README.md", remote: "Edit readme; Fix typo", local: "Reword readme" }, { path: "mods/x.js", remote: "", local: "Change x" }],
  });
  assert.match(brief, /\/work\/cfg/);
  assert.match(brief, /README\.md/);
  assert.match(brief, /Edit readme; Fix typo/);
  assert.match(brief, /Reword readme/);
  assert.match(brief, /mods\/x\.js/);
  assert.match(brief, /git pull --rebase/);
  assert.match(brief, /\.\/mount\.sh --push/);
  const copy = conflictBrief({ repo: "/r", script: "./mount.sh", kind: "copy", files: [{ path: "herdr/a.js", remote: "", local: "", saved: ".sync-backup/conflict-1/herdr/herdr/a.js" }] });
  assert.match(copy, /uncommitted/);
  assert.match(copy, /\.sync-backup\/conflict-1/);
});

test("small helpers", () => {
  assert.equal(plural(1, "commit"), "1 commit");
  assert.equal(plural(3, "commit"), "3 commits");
  assert.equal(shortError("a\nb\n  \n"), "b");
  assert.equal(shortError(""), "");
});

test("the brief for a conflict in the skillshare source says how to finish it there", () => {
  const b = conflictBrief({ repo: "/s", script: "./mount.sh", kind: "rebase", target: "source", files: [{ path: "skills/x/SKILL.md", remote: "B", local: "A" }] });
  assert.match(b, /skillshare source at \/s/);
  assert.match(b, /skills\/x\/SKILL\.md/);
  assert.match(b, /skillshare sync --all -g/);
  assert.ok(!/mount\.sh/.test(b));
});
