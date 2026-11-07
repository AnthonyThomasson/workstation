// Throwaway git repositories for the tests: a bare remote and two clones (a, b) with skills and a
// .metadata.json committed. Nothing outside the scratch folder is touched.
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

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
