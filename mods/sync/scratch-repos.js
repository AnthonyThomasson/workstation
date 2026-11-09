import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner } from "./jobs.js";

const here = dirname(fileURLToPath(import.meta.url));
const MOUNT = join(here, "sync.sh");

// Throwaway git repositories for the tests: a bare remote and two clones (a is the linked repo whose Herdr
// folder is HERDR_APP_HOME, b is "another clone"), the real sync.sh inside a, and a stub herdr-app. Nothing outside
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
  // The sync goes through the detached job runner, as it does in Herdr.
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
  mkdirSync(join(w.a, "mods/sync"), { recursive: true });
  cpSync(MOUNT, join(w.a, "mods/sync/sync.sh"));
  const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  put(w.a, "mods/demo/main.js", "one\n");
  put(w.a, "mods/demo/mod.json", "{}\n");
  put(w.a, "mods/other/main.js", "other\n");
  put(w.a, "skillshare/skills/mine/.keep", "");
  put(w.a, "layouts/Tony.json", "{}\n");
  put(w.a, "preview.png", "png\n");
  w.put = put;
  w.git(w.a, "add", "-A"); w.git(w.a, "commit", "-q", "-m", "start");
  w.git(w.a, "remote", "add", "origin", w.remote);
  w.git(w.a, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", w.remote, w.b], { env });
  // Herdr starts out matching the repo.
  execFileSync("sh", [join(w.a, "mods/sync/sync.sh")], { env, cwd: w.a });
  return w;
};
export const cleanWorld = (w) => rmSync(w.base, { recursive: true, force: true });
