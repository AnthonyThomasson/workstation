// The source section's logic: where the source's git repo is and whether it is the config repo (real
// git repos, with a symlink like ~/.config/skillshare/skills), and pull / push / both ways / resolve
// against a fake skillshare (the real CLI is never run).
import test from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { world } from "./scratch-repos.js";
import { checkSource, readSource, standalone, sourceGuidance, pullSource, pushSource, bothSource, resolveSource } from "./source.js";
import { sourceCommitMessage } from "./model.js";

// A fake skillshare: `answers` maps the first args to a { code, stdout, stderr } or a function; calls are recorded.
const fake = (w, source, answers = {}) => {
  const calls = [];
  const answer = (args) => {
    calls.push(args.join(" "));
    const a = answers[args[0]] ?? answers[args.slice(0, 2).join(" ")];
    return typeof a === "function" ? a(args, calls) : a ?? { code: 0, stdout: "", stderr: "" };
  };
  return {
    calls,
    run: async (args) => (args[0] === "status" ? { code: 0, stdout: JSON.stringify({ source: { path: source } }), stderr: "" } : answer(args)),
    job: async (args, o) => (o?.script ? w.io.sh(o.script, args) : answer(args)),
    sh: (script, args) => w.io.sh(script, args),
  };
};

test("a source that is a symlink into the config repo is the config repo (no separate section)", async () => {
  const w = world();
  mkdirSync(join(w.a, "skillshare"), { recursive: true });
  const link = join(w.base, "skills-link");
  symlinkSync(join(w.a, "skills"), link);
  const s = await checkSource(fake(w, link), { configRepo: w.a });
  assert.equal(s.same, true);
  assert.equal(standalone(s), false);
});

test("a source in its own repo reads its remote, state and changed files; fetch shows what is behind", async () => {
  const w = world();
  w.put(w.b, "skills/new/SKILL.md", "n\n"); w.commit(w.b, "B adds"); w.git(w.b, "push", "-q");
  w.put(w.a, "skills/x/SKILL.md", "changed\nline2\nline3\n");
  const quiet = await readSource(fake(w, w.a), { path: join(w.a, "skills"), configRepo: "/somewhere/else" });
  assert.equal(quiet.same, false);
  assert.equal(quiet.remote, w.remote);
  assert.deepEqual(quiet.uncommitted.map((f) => f.path), ["skills/x/SKILL.md"]);
  assert.equal(quiet.behind.length, 0); // not fetched yet
  const s = await readSource(fake(w, w.a), { path: w.a, configRepo: "", fetch: true });
  assert.equal(standalone(s), true);
  assert.equal(s.behind.length, 1);
  assert.equal(s.upstream, "origin/main");
});

test("a source outside git, and no source at all", async () => {
  const w = world();
  const outside = join(w.base, "plain"); mkdirSync(outside);
  const s = await checkSource(fake(w, outside), {});
  assert.equal(s.repo, false);
  const none = await checkSource({ run: async () => ({ code: 0, stdout: "{}", stderr: "" }) }, {});
  assert.equal(none, null);
});

test("guidance: pull is blocked by uncommitted changes, push is rejected when origin is ahead", () => {
  const g = (o) => sourceGuidance({ upstream: "origin/main", uncommitted: [], behind: [], unpushed: [], ...o });
  assert.equal(g({ uncommitted: [{}], behind: [{}] }).canPull, false);
  assert.match(g({ uncommitted: [{}], behind: [{}] }).pullBlocked, /Pull blocked while uncommitted changes/);
  assert.match(g({ uncommitted: [{}], behind: [{}] }).pushRejected, /Push rejected, origin has newer commits/);
  assert.equal(g({ behind: [{}] }).canPull, true);
  assert.equal(g({ unpushed: [{}] }).canPush, true);
  assert.equal(g({ unpushed: [{}], behind: [{}] }).canPush, false);
  assert.match(g({ unpushed: [{}], behind: [{}] }).needsMerge, /need merging/);
  assert.equal(sourceGuidance({ upstream: null, uncommitted: [{}] }).canPush, false);
});

test("the generated commit message names the files and the host, and is never the old text", () => {
  assert.equal(sourceCommitMessage(3, "mac"), "Update 3 files in the skillshare source on mac");
  assert.equal(sourceCommitMessage(1, ""), "Update 1 file in the skillshare source");
  assert.match(sourceCommitMessage(0, "x"), /^Update skills in the skillshare source on x$/);
});

test("pull, push and both ways run the skillshare commands, with the person's commit message", async () => {
  const w = world();
  let f = fake(w, w.a);
  assert.equal((await pullSource(f, { repo: w.a })).kind, "done");
  assert.deepEqual(f.calls, ["pull"]);
  f = fake(w, w.a);
  assert.equal((await pushSource(f, { message: "my words" })).kind, "done");
  assert.deepEqual(f.calls, ["push -m my words"]);
  f = fake(w, w.a);
  assert.equal((await bothSource(f, { repo: w.a, message: "both msg" })).kind, "done");
  assert.deepEqual(f.calls, ["push --pull -m both msg"]);
  f = fake(w, w.a, { push: { code: 1, stdout: "", stderr: "push rejected" } });
  const r = await pushSource(f, { message: "x" });
  assert.deepEqual([r.kind, r.text], ["error", "push rejected"]);
});

const diverge = () => {
  const w = world();
  w.put(w.b, "skills/x/SKILL.md", "line1\nB\nline3\n"); w.commit(w.b, "B"); w.git(w.b, "push", "-q");
  w.put(w.a, "skills/x/SKILL.md", "line1\nA\nline3\n"); w.commit(w.a, "A"); w.git(w.a, "fetch", "-q");
  return w;
};
const conflictFail = { code: 1, stdout: "", stderr: "Both changed the same files. The merge was undone" };

test("a pull that conflicts stops with both sides and changes nothing; choosing then merges and syncs targets", async () => {
  const w = diverge();
  const head = w.git(w.a, "rev-parse", "HEAD").trim();
  let f = fake(w, w.a, { pull: conflictFail });
  const r = await pullSource(f, { repo: w.a });
  assert.equal(r.kind, "warn");
  assert.deepEqual(r.stopped.files, ["skills/x/SKILL.md"]);
  assert.ok(r.stopped.previews["skills/x/SKILL.md"].local.lines.some((l) => l.text === "A"));
  assert.equal(r.stopped.push, false);
  assert.equal(w.git(w.a, "rev-parse", "HEAD").trim(), head);
  f = fake(w, w.a);
  const done = await resolveSource(f, { stopped: r.stopped, choices: { "skills/x/SKILL.md": "remote" } });
  assert.equal(done.kind, "done");
  assert.deepEqual(f.calls, ["sync --all --json -g"]); // linked again, not pushed
  assert.equal(readFileSync(join(w.a, "skills/x/SKILL.md"), "utf8"), "line1\nB\nline3\n");
});

test("both ways that conflicts, once resolved, pushes with the same message", async () => {
  const w = diverge();
  const r = await bothSource(fake(w, w.a, { push: conflictFail }), { repo: w.a, message: "keep this message" });
  assert.equal(r.kind, "warn");
  assert.equal(r.stopped.push, true);
  const f = fake(w, w.a);
  const done = await resolveSource(f, { stopped: r.stopped, choices: { "skills/x/SKILL.md": "local" } });
  assert.equal(done.kind, "done");
  assert.deepEqual(f.calls, ["push --pull -m keep this message"]);
});

test("when the remote moved since the person chose, the choices are not applied and it asks again", async () => {
  const w = diverge();
  const r = await pullSource(fake(w, w.a, { pull: conflictFail }), { repo: w.a });
  w.put(w.b, "skills/x/SKILL.md", "line1\nB again\nline3\n"); w.commit(w.b, "B2"); w.git(w.b, "push", "-q");
  const f = fake(w, w.a);
  const again = await resolveSource(f, { stopped: r.stopped, choices: { "skills/x/SKILL.md": "remote" } });
  assert.equal(again.kind, "warn");
  assert.match(again.text, /remote changed/);
  assert.notEqual(again.stopped.upHash, r.stopped.upHash);
  assert.deepEqual(f.calls, []);
});

test("a failure that is not a conflict is an error and nothing is read", async () => {
  const w = world();
  const f = fake(w, w.a, { pull: { code: 1, stdout: "", stderr: "could not resolve host" } });
  const r = await pullSource(f, { repo: w.a });
  assert.deepEqual([r.kind, r.text], ["error", "could not resolve host"]);
});
