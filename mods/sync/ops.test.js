// Runs the link, sync, snapshot, ignore, list and switch scripts against throwaway git repositories: a bare
// remote and two clones (A is the linked repo whose Herdr folder is HERDR_APP_HOME, B is "another clone"), with the
// real sync.sh as the sync script and a stub herdr-app. Nothing outside the scratch folder is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { syncFolder, readLink, snapshot, unignored, listTargets, switchBranch, SYNC } from "./ops.js";
import { syncWorld as world, cleanWorld as clean } from "./scratch-repos.js";
import { parseSyncJson } from "./model.js";

const link = (w) => parseSyncJson(readFileSync(join(w.herdr, "sync.json"), "utf8"));
const touch = (p) => { const t = new Date(Date.now() + 5000); utimesSync(p, t, t); };

test("Sync makes Herdr match the picked folder, with no backup and nothing written to the repo", async () => {
  const w = world("sync");
  try {
    w.put(w.a, "mods/demo/main.js", "two\n"); w.put(w.a, "mods/demo/icon.svg", "<svg/>\n");
    const out = await syncFolder(w.io, w.a);
    assert.equal(out.result, "ok", out.message);
    assert.match(out.message, /loaded \d+ mods with no errors/);
    assert.equal(readFileSync(join(w.herdr, "mods/demo/main.js"), "utf8"), "two\n");
    assert.ok(existsSync(join(w.herdr, "mods/demo/icon.svg")));
    assert.deepEqual(readdirSync(w.herdr).filter((n) => n.includes("backup")), [], "no backup folder");
    assert.deepEqual(w.git(w.a, "status", "--porcelain", "--", "mods").split("\n").map((l) => l.trim()).filter(Boolean).sort(), ["?? mods/demo/icon.svg", "M mods/demo/main.js"], "only the edits this test made");
  } finally { clean(w); }
});

test("Sync is one way: Herdr's own edit is replaced by the repo's file, and a file the repo dropped is removed", async () => {
  const w = world("one-way");
  try {
    const f = join(w.herdr, "mods/demo/main.js");
    writeFileSync(f, "edited in Herdr\n"); touch(f);
    const stale = join(w.herdr, "mods/demo/old.js");
    writeFileSync(stale, "stale\n");
    const foreign = join(w.herdr, "mods/shipped/main.js");
    mkdirSync(dirname(foreign), { recursive: true }); writeFileSync(foreign, "not ours\n");
    const out = await syncFolder(w.io, w.a);
    assert.equal(out.result, "ok", out.message);
    assert.equal(readFileSync(f, "utf8"), "one\n");
    assert.equal(existsSync(stale), false);
    assert.ok(existsSync(foreign), "a mod the repo does not own is left alone");
    assert.equal(w.git(w.a, "status", "--porcelain").trim(), "", "nothing in the repo changed");
  } finally { clean(w); }
});

test("Sync from a worktree on another branch copies that checkout, and sync.json then names the worktree", async () => {
  const w = world("worktree");
  try {
    const wt = join(w.base, "wt");
    w.git(w.a, "worktree", "add", "-q", "-b", "feature", wt);
    writeFileSync(join(wt, "mods/demo/main.js"), "from the feature branch\n");
    const out = await syncFolder(w.io, wt);
    assert.equal(out.result, "ok", out.message);
    assert.equal(readFileSync(join(w.herdr, "mods/demo/main.js"), "utf8"), "from the feature branch\n");
    assert.equal(link(w).repo, w.git(wt, "rev-parse", "--show-toplevel").trim());
    assert.notEqual(link(w).repo, w.git(w.a, "rev-parse", "--show-toplevel").trim());
  } finally { clean(w); }
});

test("Sync runs the script of the picked folder and says when it is missing", async () => {
  const w = world("no-script");
  try {
    rmSync(join(w.a, "mods/sync/sync.sh"));
    const out = await syncFolder(w.io, w.a);
    assert.equal(out.result, "error");
    assert.match(out.message, /mods\/sync\/sync\.sh was not found/);
  } finally { clean(w); }
});

test("a script that fails is an error with its last words; a folder that is gone is an error too", async () => {
  const w = world("fails");
  try {
    writeFileSync(join(w.a, "mods/sync/sync.sh"), "#!/bin/sh\necho 'halfway'\necho 'it broke' >&2\nexit 1\n");
    const out = await syncFolder(w.io, w.a);
    assert.equal(out.result, "error");
    assert.match(out.message, /The sync script failed: it broke/);
    const gone = await syncFolder(w.io, join(w.base, "nowhere"));
    assert.equal(gone.result, "error");
    assert.match(gone.message, /Not a folder/);
  } finally { clean(w); }
});

test("Sync reports a mod the running Herdr cannot load, and errors Herdr lists", async () => {
  const w = world("loaded");
  try {
    const stub = join(w.home, ".local/bin/herdr-app");
    writeFileSync(stub, '#!/bin/sh\ncase "$1" in status) echo \'{ "errors": [] }\' ;; *) case "$2" in mods/other) echo bad; exit 1 ;; esac ;; esac\n', { mode: 0o755 });
    let out = await syncFolder(w.io, w.a);
    assert.equal(out.result, "error");
    assert.match(out.message, /Herdr could not load: other/);
    writeFileSync(stub, '#!/bin/sh\ncase "$1" in status) echo \'{ "errors": ["x"] }\' ;; *) echo ok ;; esac\n', { mode: 0o755 });
    out = await syncFolder(w.io, w.a);
    assert.equal(out.result, "error");
    assert.match(out.message, /reports errors/);
    writeFileSync(stub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    out = await syncFolder(w.io, w.a);
    assert.equal(out.result, "error", "an unloadable mod is an error whatever status says");
  } finally { clean(w); }
});

test("the sync script is the only thing the mod runs from the repo, with no network git in it", () => {
  assert.doesNotMatch(SYNC, /git (fetch|pull|push)/);
});

// ---- the link ----

test("the link: the repo from sync.json, the picked worktree and its branch", async () => {
  const w = world("link");
  try {
    const top = w.git(w.a, "rev-parse", "--show-toplevel").trim();
    let l = await readLink(w.io, { file: top, stored: "", pick: "" });
    assert.deepEqual(l, { gone: false, repo: top, dir: top, branch: "main" });
    l = await readLink(w.io, { file: top, stored: top, pick: "" });
    assert.equal(l.repo, top);

    const wt = join(w.base, "wt");
    w.git(w.a, "worktree", "add", "-q", "-b", "feature", wt);
    const wtTop = w.git(wt, "rev-parse", "--show-toplevel").trim();
    l = await readLink(w.io, { file: top, stored: top, pick: wtTop });
    assert.deepEqual(l, { gone: false, repo: top, dir: wtTop, branch: "feature" });

    // Running the script from the worktree rewrites sync.json to the worktree: the link to the repo is kept.
    l = await readLink(w.io, { file: wtTop, stored: top, pick: wtTop });
    assert.deepEqual(l, { gone: false, repo: top, dir: wtTop, branch: "feature" });
    // With nothing remembered, the worktree is the link (it is a repo too) and so is picked.
    l = await readLink(w.io, { file: wtTop, stored: "", pick: "" });
    assert.equal(l.repo, wtTop);
    assert.equal(l.dir, wtTop);

    // A picked worktree that was removed falls back to the repo.
    w.git(w.a, "worktree", "remove", "--force", wt);
    l = await readLink(w.io, { file: top, stored: top, pick: wtTop });
    assert.deepEqual(l, { gone: false, repo: top, dir: top, branch: "main" });
    // A pick that is not a worktree of this repo is ignored.
    l = await readLink(w.io, { file: top, stored: top, pick: w.base });
    assert.equal(l.dir, top);
  } finally { clean(w); }
});

test("running the script from a different clone moves the link to it; a repo that is gone is not linked", async () => {
  const w = world("relink");
  try {
    const a = w.git(w.a, "rev-parse", "--show-toplevel").trim(), b = w.git(w.b, "rev-parse", "--show-toplevel").trim();
    let l = await readLink(w.io, { file: b, stored: a, pick: a });
    assert.equal(l.repo, b, "another clone is another link");
    assert.equal(l.dir, b, "and the old pick is dropped");
    rmSync(w.a, { recursive: true, force: true });
    l = await readLink(w.io, { file: a, stored: a, pick: "" });
    assert.equal(l.gone, true);
    l = await readLink(w.io, { file: b, stored: a, pick: "" });
    assert.equal(l.repo, b, "the remembered repo is gone, the file names a live one");
    l = await readLink(w.io, { file: join(w.base, "nowhere"), stored: "", pick: "" });
    assert.equal(l.gone, true);
    l = await readLink(w.io, { file: w.base, stored: "", pick: "" });
    assert.equal(l.gone, true, "a folder that is not a git repository is not a link");
  } finally { clean(w); }
});

test("the link check takes no git locks and makes no network call", async () => {
  const w = world("link-quiet");
  try {
    const before = w.git(w.a, "status", "--porcelain");
    await readLink(w.io, { file: w.a, stored: w.a, pick: "" });
    assert.equal(w.git(w.a, "status", "--porcelain"), before);
  } finally { clean(w); }
});

// ---- the snapshot: has the content really changed ----

test("the snapshot changes when a file's content changes, not when it is only touched or rewritten the same", async () => {
  const w = world("snapshot");
  try {
    const s0 = await snapshot(w.io, w.a);
    assert.ok(s0, "a snapshot");
    assert.equal(await snapshot(w.io, w.a), s0, "stable");
    const f = join(w.a, "mods/demo/main.js");
    touch(f);
    assert.equal(await snapshot(w.io, w.a), s0, "touched: same");
    writeFileSync(f, "one\n");
    assert.equal(await snapshot(w.io, w.a), s0, "rewritten with the same content: same");
    writeFileSync(f, "two\n");
    const s1 = await snapshot(w.io, w.a);
    assert.notEqual(s1, s0);
    writeFileSync(f, "one\n");
    assert.equal(await snapshot(w.io, w.a), s0, "changed back: same as before");
    w.put(w.a, "mods/demo/new.js", "x\n");
    const s2 = await snapshot(w.io, w.a);
    assert.notEqual(s2, s0, "a new file");
    rmSync(join(w.a, "mods/demo/new.js"));
    assert.equal(await snapshot(w.io, w.a), s0);
    rmSync(f);
    assert.notEqual(await snapshot(w.io, w.a), s0, "a deleted file");
  } finally { clean(w); }
});

test("the snapshot ignores git-ignored files and .git", async () => {
  const w = world("snapshot-ignored");
  try {
    w.put(w.a, ".gitignore", "skillshare/skills/*\n!skillshare/skills/mine\nnode_modules/\n");
    w.git(w.a, "add", "-A"); w.git(w.a, "commit", "-q", "-m", "ignore");
    const s0 = await snapshot(w.io, w.a);
    w.put(w.a, "skillshare/skills/installed/SKILL.md", "installed\n");
    w.put(w.a, "node_modules/x/index.js", "x\n");
    w.git(w.a, "commit", "-q", "--allow-empty", "-m", "empty");
    assert.equal(await snapshot(w.io, w.a), s0);
    w.put(w.a, "skillshare/skills/mine/new/SKILL.md", "mine\n");
    assert.notEqual(await snapshot(w.io, w.a), s0, "a tracked-folder file counts");
  } finally { clean(w); }
});

test("the sync's own writes into the repo (normalising skillshare/config.yaml) are in the snapshot taken after it, so a second sync changes nothing", async () => {
  const w = world("self-write");
  try {
    w.put(w.a, "skillshare/config.yaml", `preserve_tilde_on_save: true\nsources:\n  skills: ${w.home}/.config/skillshare/skills\n`);
    w.git(w.a, "add", "-A"); w.git(w.a, "commit", "-q", "-m", "config");
    const before = await snapshot(w.io, w.a);
    let out = await syncFolder(w.io, w.a);
    assert.equal(out.result, "ok", out.message);
    assert.match(readFileSync(join(w.a, "skillshare/config.yaml"), "utf8"), /skills: ~\/\.config/);
    const after = await snapshot(w.io, w.a);
    assert.notEqual(after, before, "the script did write into the repo");
    out = await syncFolder(w.io, w.a);
    assert.equal(out.result, "ok", out.message);
    assert.equal(await snapshot(w.io, w.a), after, "and a second run writes nothing new");
  } finally { clean(w); }
});

// ---- which changed paths git ignores ----

test("paths git ignores are dropped; tracked, new and removed ones are kept", async () => {
  const w = world("unignored");
  try {
    w.put(w.a, ".gitignore", "skillshare/skills/*\n!skillshare/skills/mine\nnode_modules/\n*.log\n");
    w.git(w.a, "add", "-A"); w.git(w.a, "commit", "-q", "-m", "ignore");
    w.put(w.a, "skillshare/skills/installed/SKILL.md", "i\n");
    w.put(w.a, "node_modules/x/index.js", "x\n");
    w.put(w.a, "debug.log", "x\n");
    const kept = await unignored(w.io, w.a, [
      "mods/demo/main.js", "skillshare/skills/installed", "skillshare/skills/installed/SKILL.md", "node_modules", "node_modules/x/index.js",
      "debug.log", "skillshare/skills/mine/.keep", "mods/demo/removed.js", ".gitignore", "a b/with space.txt",
    ]);
    assert.deepEqual(kept, ["mods/demo/main.js", "skillshare/skills/mine/.keep", "mods/demo/removed.js", ".gitignore", "a b/with space.txt"]);
    assert.deepEqual(await unignored(w.io, w.a, []), []);
    assert.deepEqual(await unignored(w.io, w.a, ["debug.log"]), []);
  } finally { clean(w); }
});

test("when git cannot be asked, every path is kept", async () => {
  const w = world("unignored-broken");
  try {
    assert.deepEqual(await unignored(w.io, join(w.base, "nowhere"), ["a", "b"]), ["a", "b"]);
  } finally { clean(w); }
});

// ---- the picker's lists and switching ----

test("worktrees and local branches are listed, and a branch in another worktree cannot be switched to", async () => {
  const w = world("list");
  try {
    const wt = join(w.base, "wt");
    w.git(w.a, "worktree", "add", "-q", "-b", "feature", wt);
    const list = await listTargets(w.io, w.a);
    assert.deepEqual(list.worktrees.map((x) => x.branch).sort(), ["feature", "main"]);
    assert.equal(list.branches.find((b) => b.name === "feature").path.endsWith("/wt"), true);
    const sw = await switchBranch(w.io, w.a, "feature");
    assert.equal(sw.result, "error");
    w.git(w.a, "branch", "other");
    const ok = await switchBranch(w.io, w.a, "other");
    assert.equal(ok.result, "ok", ok.message);
    assert.equal(w.git(w.a, "symbolic-ref", "--short", "HEAD").trim(), "other");
    assert.deepEqual(await listTargets(w.io, join(w.base, "nowhere")), { worktrees: [], branches: [] });
  } finally { clean(w); }
});
