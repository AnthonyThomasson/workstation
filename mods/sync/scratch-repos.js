// Throwaway git repositories for the tests: a bare remote and two clones (a, b) with skills and a
// .metadata.json committed. Nothing outside the scratch folder is touched.
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner } from "./jobs.js";

const here = dirname(fileURLToPath(import.meta.url));
const MOUNT = join(here, "../../scripts/sync/sync.sh");

export const world = () => {
  const base = mkdtempSync(join(tmpdir(), "sync-conf-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.com", GIT_CONFIG_GLOBAL: join(base, "gitconfig") };
  writeFileSync(env.GIT_CONFIG_GLOBAL, "[init]\n\tdefaultBranch = main\n[pull]\n\trebase = false\n");
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, encoding: "utf8" });
  const sh = (script, args) => new Promise((resolve) => execFile("sh", ["-c", script, "t", ...args], { env }, (e, stdout, stderr) => resolve({ code: e?.code ?? 0, stdout, stderr })));
  const w = { base, a: join(base, "a"), b: join(base, "b"), remote: join(base, "r.git"), git, io: { sh, job: sh } };
  const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  const commit = (cwd, msg) => { git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", msg); };
  Object.assign(w, { put, commit });
  execFileSync("git", ["init", "-q", "--bare", w.remote], { env });
  mkdirSync(w.a); git(w.a, "init", "-q");
  put(w.a, "skills/x/SKILL.md", "line1\nline2\nline3\n");
  put(w.a, "skills/y/SKILL.md", "y1\ny2\n");
  put(w.a, ".metadata.json", JSON.stringify({ entries: { alpha: { installed_at: "2026-01-01T00:00:00Z", v: 1 } } }, null, 2));
  commit(w.a, "base"); git(w.a, "remote", "add", "origin", w.remote); git(w.a, "push", "-q", "-u", "origin", "main");
  git(base, "clone", "-q", w.remote, "b");
  return w;
};

// The config repo as the ops tests use it: a bare remote and two clones (a is the config repo whose Herdr
// folder is HERDR_APP_HOME, b is "another machine"), the real sync.sh as the sync script. Nothing outside
// the scratch folder is touched.
export const syncWorld = (name) => {
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
  // A stand-in for the running Herdr's CLI, so tests never reach the real one: every mod loads, status has no errors.
  mkdirSync(join(w.home, ".local/bin"), { recursive: true });
  writeFileSync(join(w.home, ".local/bin/herdr-app"), '#!/bin/sh\ncase "$1" in status) echo \'{ "errors": [] }\' ;; *) echo "check passed" ;; esac\n', { mode: 0o755 });
  writeFileSync(env.GIT_CONFIG_GLOBAL, "[init]\n\tdefaultBranch = main\n[pull]\n\trebase = true\n");
  execFileSync("git", ["init", "-q", "--bare", w.remote], { env });
  mkdirSync(w.a, { recursive: true });
  w.git(w.a, "init", "-q");
  mkdirSync(join(w.a, "scripts/sync"), { recursive: true });
  cpSync(MOUNT, join(w.a, "scripts/sync/sync.sh"));
  const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  put(w.a, "mods/demo/main.js", "one\n");
  put(w.a, "mods/demo/mod.json", "{}\n");
  put(w.a, "mods/other/main.js", "other\n");
  put(w.a, "skillshare/skills/mine/.keep", "");
  put(w.a, "layouts/Tony.json", "{}\n");
  w.put = put;
  w.git(w.a, "add", "-A"); w.git(w.a, "commit", "-q", "-m", "start");
  w.git(w.a, "remote", "add", "origin", w.remote);
  w.git(w.a, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", w.remote, w.b], { env });
  // Herdr starts out matching the repo.
  execFileSync("sh", [join(w.a, "scripts/sync/sync.sh")], { env, cwd: w.a });
  w.cfg = { repo: w.a, script: "./scripts/sync/sync.sh", agent: "claude" };
  return w;
};
export const cleanWorld = (w) => rmSync(w.base, { recursive: true, force: true });
export const laterMtime = (p) => { const t = new Date(Date.now() + 5000); utimesSync(p, t, t); }; // a newer mtime, as an edit would leave
