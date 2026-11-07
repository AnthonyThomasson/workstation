// Runs the check, pull and push scripts against throwaway git repositories: a bare remote and two
// clones (A is the config repo whose Herdr folder is HERDR_APP_HOME, B is "another machine"), with the
// real mount.sh as the sync script. Nothing outside the scratch folder is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRepo, pull, push, finishMerge } from "./ops.js";
import { prepare, applyChoices } from "./conflicts.js";
import { createRunner } from "./jobs.js";
import { badge, changedFiles } from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));
const MOUNT = join(here, "../../../../mount.sh");

const world = (name) => {
  const base = mkdtempSync(join(tmpdir(), `sync-${name}-`));
  const w = { base, remote: join(base, "remote.git"), a: join(base, "a"), b: join(base, "b"), herdr: join(base, "herdr-home"), home: join(base, "home") };
  const env = {
    ...process.env, HOME: w.home, HERDR_APP_HOME: w.herdr, SKILLSHARE_HOME: join(base, "ss"),
    GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: join(base, "gitconfig"), PATH: `${process.env.PATH}`,
  };
  w.env = env;
  w.git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  const sh = (script, args) => new Promise((resolve) => execFile("sh", ["-c", script, "sync", ...args], { env, maxBuffer: 8 << 20 }, (e, stdout, stderr) => resolve({ code: e?.code ?? 0, stdout, stderr })));
  // pull, push and fetch go through the detached job runner, as they do in Herdr.
  const runner = createRunner({ exec: sh, readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } }, pollMs: 20 });
  w.io = { sh, job: (script, args) => runner.job(args, { script, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }) };
  mkdirSync(w.home, { recursive: true }); mkdirSync(w.herdr, { recursive: true });
  writeFileSync(env.GIT_CONFIG_GLOBAL, "[init]\n\tdefaultBranch = main\n[pull]\n\trebase = true\n");
  execFileSync("git", ["init", "-q", "--bare", w.remote], { env });
  mkdirSync(w.a, { recursive: true });
  w.git(w.a, "init", "-q");
  cpSync(MOUNT, join(w.a, "mount.sh"));
  const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  put(w.a, "herdr/demo/mods/demo/main.js", "one\n");
  put(w.a, "herdr/demo/mods/demo/mod.json", "{}\n");
  put(w.a, "herdr/other/mods/other/main.js", "other\n");
  put(w.a, "skillshare/skills/mine/.keep", "");
  put(w.a, "herdr/tony/layouts/Tony.json", "{}\n");
  w.put = put;
  w.git(w.a, "add", "-A"); w.git(w.a, "commit", "-q", "-m", "start");
  w.git(w.a, "remote", "add", "origin", w.remote);
  w.git(w.a, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", w.remote, w.b], { env });
  // Herdr starts out matching the repo, and Tony's copies exist.
  execFileSync("sh", [join(w.a, "mount.sh")], { env, cwd: w.a });
  w.git(w.a, "add", "-A"); w.git(w.a, "commit", "-q", "-m", "tony copies"); w.git(w.a, "push", "-q");
  w.git(w.b, "pull", "-q");
  w.cfg = { repo: w.a, script: "./mount.sh", agent: "claude" };
  return w;
};
const clean = (w) => rmSync(w.base, { recursive: true, force: true });
const later = (p) => { const t = new Date(Date.now() + 5000); utimesSync(p, t, t); }; // a newer mtime, as an edit would leave

test("a fresh clone with Herdr in step shows no badge", async () => {
  const w = world("fresh");
  try {
    const s = await checkRepo(w.io, w.cfg);
    assert.equal(s.repo, true);
    assert.equal(s.error, null);
    assert.equal(s.branch, "main");
    assert.equal(s.upstream, "origin/main");
    assert.deepEqual(s.herdr, []);
    assert.equal(badge(s).text, "");
    assert.ok(s.host);
  } finally { clean(w); }
});

test("a commit from another clone shows as ↓1 after a fetch, not before", async () => {
  const w = world("behind");
  try {
    w.put(w.b, "herdr/demo/mods/demo/main.js", "two\n");
    w.git(w.b, "commit", "-q", "-am", "Change the demo"); w.git(w.b, "push", "-q");
    assert.equal(badge(await checkRepo(w.io, w.cfg)).text, "");
    const s = await checkRepo(w.io, w.cfg, { fetch: true });
    assert.equal(badge(s).text, "↓1");
    assert.deepEqual(s.behind.map((c) => c.subject), ["Change the demo"]);
    assert.equal(badge(await checkRepo(w.io, w.cfg)).text, "↓1"); // fetched refs stay
  } finally { clean(w); }
});

test("Pull applies the remote's commit to Herdr, backs up what it replaces, and the badge clears", async () => {
  const w = world("pull");
  try {
    // As a Push from another machine leaves it: the entry folder and Tony's copy both changed.
    for (const root of ["herdr/demo/mods/demo", "herdr/tony/mods/demo"]) { w.put(w.b, `${root}/main.js`, "two\n"); w.put(w.b, `${root}/icon.svg`, "<svg/>\n"); }
    w.git(w.b, "add", "-A"); w.git(w.b, "commit", "-q", "-m", "Change the demo"); w.git(w.b, "push", "-q");
    assert.equal(badge(await checkRepo(w.io, w.cfg, { fetch: true })).text, "↓1");
    const out = await pull(w.io, w.cfg);
    assert.equal(out.result, "ok", out.message);
    assert.equal(out.extra.pulled, "1");
    assert.equal(readFileSync(join(w.herdr, "mods/demo/main.js"), "utf8"), "two\n");
    assert.ok(existsSync(join(w.herdr, "mods/demo/icon.svg")));
    assert.ok(readdirSync(join(w.herdr, ".workstation-backup")).length > 0, "a backup of the replaced Herdr file");
    const s = await checkRepo(w.io, w.cfg);
    assert.equal(badge(s).text, "");
  } finally { clean(w); }
});

test("Editing a Herdr mod shows as ↑1; Push copies it, refreshes Tony, commits, pushes, and the badge clears", async () => {
  const w = world("push");
  try {
    const f = join(w.herdr, "mods/demo/main.js");
    writeFileSync(f, "edited in Herdr\n"); later(f);
    const s = await checkRepo(w.io, w.cfg);
    assert.deepEqual(s.herdr, ["mods/demo/main.js"]);
    assert.equal(badge(s).text, "↑1");
    const out = await push(w.io, w.cfg, "Sync 1 file from Herdr on test");
    assert.equal(out.result, "ok", out.message);
    assert.equal(out.extra.pushed, "1");
    assert.equal(readFileSync(join(w.a, "herdr/demo/mods/demo/main.js"), "utf8"), "edited in Herdr\n");
    assert.equal(readFileSync(join(w.a, "herdr/tony/mods/demo/main.js"), "utf8"), "edited in Herdr\n");
    w.git(w.b, "pull", "-q");
    assert.equal(readFileSync(join(w.b, "herdr/demo/mods/demo/main.js"), "utf8"), "edited in Herdr\n");
    assert.equal(readFileSync(join(w.b, "herdr/tony/mods/demo/main.js"), "utf8"), "edited in Herdr\n");
    assert.equal(w.git(w.b, "log", "-1", "--format=%s").trim(), "Sync 1 file from Herdr on test");
    assert.equal(badge(await checkRepo(w.io, w.cfg)).text, "");
    assert.equal(w.git(w.a, "status", "--porcelain").trim(), "");
  } finally { clean(w); }
});

test("an uncommitted skill in the repo counts toward ↑ and is included in the push", async () => {
  const w = world("skill");
  try {
    w.put(w.a, "skillshare/skills/mine/new-skill/SKILL.md", "# new\n");
    const s = await checkRepo(w.io, w.cfg);
    assert.equal(badge(s).text, "↑1");
    assert.deepEqual(changedFiles(s).map((x) => x.path), ["skillshare/skills/mine/new-skill/SKILL.md"]);
    const out = await push(w.io, w.cfg, "add skill");
    assert.equal(out.result, "ok", out.message);
    w.git(w.b, "pull", "-q");
    assert.ok(existsSync(join(w.b, "skillshare/skills/mine/new-skill/SKILL.md")));
    assert.equal(badge(await checkRepo(w.io, w.cfg)).text, "");
  } finally { clean(w); }
});

test("Push with nothing to push says so", async () => {
  const w = world("nothing");
  try {
    const out = await push(w.io, w.cfg, "x");
    assert.equal(out.result, "ok");
    assert.equal(out.extra.pushed, "0");
  } finally { clean(w); }
});

test("Push when the remote also moved, without a conflict, rebases and then updates Herdr", async () => {
  const w = world("rebase");
  try {
    w.put(w.b, "herdr/other/mods/other/main.js", "other changed remotely\n");
    w.git(w.b, "commit", "-q", "-am", "Remote edit"); w.git(w.b, "push", "-q");
    const f = join(w.herdr, "mods/demo/main.js");
    writeFileSync(f, "edited in Herdr\n"); later(f);
    const out = await push(w.io, w.cfg, "Sync");
    assert.equal(out.result, "ok", out.message);
    assert.equal(out.extra.pulled, "1");
    assert.equal(readFileSync(join(w.herdr, "mods/other/main.js"), "utf8"), "other changed remotely\n");
    assert.equal(w.git(w.remote, "log", "-1", "--format=%s").trim(), "Sync");
  } finally { clean(w); }
});

test("when the remote and Herdr change the same file, Push pushes nothing and names the file", async () => {
  const w = world("conflict");
  try {
    w.put(w.b, "herdr/demo/mods/demo/main.js", "remote version\n");
    w.git(w.b, "commit", "-q", "-am", "Remote edit of the demo"); w.git(w.b, "push", "-q");
    const remoteTip = w.git(w.remote, "rev-parse", "main").trim();
    const f = join(w.herdr, "mods/demo/main.js");
    writeFileSync(f, "herdr version\n"); later(f);
    const out = await push(w.io, w.cfg, "Sync");
    assert.equal(out.result, "conflict", out.message);
    assert.deepEqual(out.files.map((x) => x.path), ["herdr/demo/mods/demo/main.js"]);
    assert.match(out.files[0].remote, /Remote edit of the demo/);
    assert.match(out.files[0].local, /Sync/);
    assert.equal(w.git(w.remote, "rev-parse", "main").trim(), remoteTip, "nothing was pushed");
    const s = await checkRepo(w.io, w.cfg);
    assert.equal(s.inProgress, null, "the rebase was undone");
    assert.deepEqual(s.unmerged, []);
    assert.equal(s.unpushed.length, 1);
    assert.equal(s.behind.length, 1);
  } finally { clean(w); }
});

test("a push conflict can be settled by choosing a side: the merge is committed, Herdr matches and it is pushed", async () => {
  const w = world("choose");
  try {
    w.put(w.b, "herdr/demo/mods/demo/main.js", "remote version\n");
    w.git(w.b, "commit", "-q", "-am", "Remote edit of the demo"); w.git(w.b, "push", "-q");
    const f = join(w.herdr, "mods/demo/main.js");
    writeFileSync(f, "herdr version\n"); later(f);
    assert.equal((await push(w.io, w.cfg, "Sync")).result, "conflict");
    const p = await prepare(w.io, { repo: w.a });
    assert.equal(p.kind, "stopped");
    assert.deepEqual(p.stopped.files, ["herdr/demo/mods/demo/main.js"]);
    const a = await applyChoices(w.io, { repo: w.a, choices: { "herdr/demo/mods/demo/main.js": "remote" }, upHash: p.stopped.upHash });
    assert.equal(a.kind, "applied");
    const out = await finishMerge(w.io, w.cfg, { push: true });
    assert.equal(out.result, "ok", out.message);
    assert.equal(readFileSync(f, "utf8"), "remote version\n", "Herdr now matches the repo");
    const s = await checkRepo(w.io, w.cfg, { fetch: true });
    assert.equal(s.behind.length + s.unpushed.length, 0, "pushed");
    assert.equal(w.git(w.remote, "show", "main:herdr/demo/mods/demo/main.js"), "remote version\n");
  } finally { clean(w); }
});

test("Push will not overwrite an uncommitted edit in the repo with Herdr's copy", async () => {
  const w = world("copy-conflict");
  try {
    w.put(w.a, "herdr/demo/mods/demo/main.js", "repo edit, uncommitted\n");
    const f = join(w.herdr, "mods/demo/main.js");
    writeFileSync(f, "herdr edit\n"); later(f);
    const out = await push(w.io, w.cfg, "Sync");
    assert.equal(out.result, "conflict", out.message);
    assert.equal(out.extra.kind, "copy");
    assert.deepEqual(out.files.map((x) => x.path), ["herdr/demo/mods/demo/main.js"]);
    assert.equal(readFileSync(join(w.a, "herdr/demo/mods/demo/main.js"), "utf8"), "repo edit, uncommitted\n");
    assert.equal(readFileSync(join(w.a, out.extra.saved, "herdr/herdr/demo/mods/demo/main.js"), "utf8"), "herdr edit\n");
    assert.equal(w.git(w.remote, "log", "-1", "--format=%s").trim(), "tony copies");
  } finally { clean(w); }
});

test("a folder that is not a git repository, and a missing script, are reported", async () => {
  const w = world("bad");
  try {
    assert.equal((await checkRepo(w.io, { ...w.cfg, repo: w.base })).repo, false);
    assert.match((await checkRepo(w.io, { ...w.cfg, script: "./nope.sh" })).error, /not found/);
    assert.equal((await pull(w.io, { ...w.cfg, script: "./nope.sh" })).result, "error");
  } finally { clean(w); }
});

test("a repo path can start with ~", async () => {
  const w = world("tilde");
  try {
    cpSync(w.a, join(w.home, "cfg"), { recursive: true });
    const s = await checkRepo(w.io, { ...w.cfg, repo: "~/cfg" });
    assert.equal(s.repo, true);
    assert.equal(s.top, realpathSync(join(w.home, "cfg")));
  } finally { clean(w); }
});
