// A Pull or Push that stopped on a rebase conflict: a conflict in .metadata.json alone is merged without
// asking and the push finishes; other files are asked about; a Pull conflict does not open the agent.
// Against real git repositories (scratch-repos.js), with the real mount.sh as the sync script.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pull, push } from "./ops.js";
import { settleRepoConflict } from "./repo-conflict.js";
import { syncWorld as world, cleanWorld as clean, laterMtime as later } from "./scratch-repos.js";

const meta = (...names) => JSON.stringify({ entries: Object.fromEntries(names.map((n) => [n, { installed_at: "2026-02-01T00:00:00Z", n }])) });
const DEMO = "herdr/demo/mods/demo/main.js";

// Both sides add a different entry to the skill records (one line, so the edits clash).
const metadataClash = (w) => {
  w.put(w.a, ".metadata.json", meta("alpha")); w.git(w.a, "add", "-A"); w.git(w.a, "commit", "-q", "-m", "records"); w.git(w.a, "push", "-q");
  w.git(w.b, "pull", "-q");
  w.put(w.b, ".metadata.json", meta("alpha", "fromB")); w.git(w.b, "commit", "-q", "-am", "B records"); w.git(w.b, "push", "-q");
  w.put(w.a, ".metadata.json", meta("alpha", "fromA")); // uncommitted in the repo: a Push commits it
};

test("a push that conflicts only in .metadata.json is merged entry by entry and the push completes", async () => {
  const w = world("meta-push");
  try {
    metadataClash(w);
    const out = await push(w.io, w.cfg, "Sync");
    assert.equal(out.result, "conflict", out.message);
    assert.deepEqual(out.files.map((f) => f.path), [".metadata.json"]);
    const r = await settleRepoConflict(w.io, w.cfg, { repo: w.a, push: true });
    assert.equal(r.kind, "done", r.text);
    assert.equal(r.openAgent, false);
    const entries = JSON.parse(w.git(w.remote, "show", "main:.metadata.json")).entries;
    assert.ok(entries.alpha && entries.fromA && entries.fromB, "the pushed records hold both sides' entries");
    assert.equal(w.git(w.a, "rev-list", "--count", "origin/main..HEAD").trim(), "0", "nothing left unpushed");
    assert.equal(w.git(w.a, "status", "--porcelain", "--", ".", ":(exclude).sync-backup").trim(), "");
    assert.deepEqual(JSON.parse(readFileSync(join(w.a, ".metadata.json"), "utf8")).entries, entries);
  } finally { clean(w); }
});

test("with other files conflicting too, .metadata.json is not asked about and a push opens the agent", async () => {
  const w = world("meta-mixed");
  try {
    metadataClash(w);
    w.put(w.b, DEMO, "remote version\n"); w.git(w.b, "commit", "-q", "-am", "B demo"); w.git(w.b, "push", "-q");
    w.git(w.b, "pull", "-q");
    const f = join(w.herdr, "mods/demo/main.js");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(f, "herdr version\n"); later(f);
    const remoteTip = w.git(w.remote, "rev-parse", "main").trim();
    const out = await push(w.io, w.cfg, "Sync");
    assert.equal(out.result, "conflict", out.message);
    assert.ok(out.files.some((x) => x.path === ".metadata.json") && out.files.some((x) => x.path === DEMO));
    const r = await settleRepoConflict(w.io, w.cfg, { repo: w.a, push: true });
    assert.equal(r.kind, "stopped");
    assert.deepEqual(r.stopped.files, [DEMO]);
    assert.equal(r.stopped.target, "repo");
    assert.equal(r.stopped.push, true);
    assert.equal(r.openAgent, true);
    assert.equal(w.git(w.remote, "rev-parse", "main").trim(), remoteTip, "nothing was pushed");
    assert.equal(w.git(w.a, "status", "--porcelain").includes("UU"), false, "the merge was undone");
  } finally { clean(w); }
});

test("a pull conflict shows the picker data and does not open the agent", async () => {
  const w = world("pull-conflict");
  try {
    w.put(w.b, DEMO, "remote version\n"); w.git(w.b, "commit", "-q", "-am", "B demo"); w.git(w.b, "push", "-q");
    w.put(w.a, DEMO, "local version\n"); w.git(w.a, "commit", "-q", "-am", "A demo");
    const out = await pull(w.io, w.cfg);
    assert.equal(out.result, "conflict", out.message);
    const r = await settleRepoConflict(w.io, w.cfg, { repo: w.a, push: false });
    assert.equal(r.kind, "stopped");
    assert.deepEqual(r.stopped.files, [DEMO]);
    assert.equal(r.stopped.push, false);
    assert.equal(r.openAgent, false, "a pull never opens the agent on its own");
    assert.ok(r.stopped.previews[DEMO].local && r.stopped.previews[DEMO].remote);
    assert.equal(r.stopped.shown, 1);
    assert.equal(w.git(w.a, "status", "--porcelain").trim(), "");
  } finally { clean(w); }
});

test("a pull that conflicts only in .metadata.json is merged, Herdr updated, and not pushed", async () => {
  const w = world("meta-pull");
  try {
    metadataClash(w);
    w.git(w.a, "commit", "-q", "-am", "A records"); // a local commit, so the pull rebases over the remote's
    const out = await pull(w.io, w.cfg);
    assert.equal(out.result, "conflict", out.message);
    const r = await settleRepoConflict(w.io, w.cfg, { repo: w.a, push: false });
    assert.equal(r.kind, "done", r.text);
    assert.equal(r.openAgent, false);
    const entries = JSON.parse(readFileSync(join(w.a, ".metadata.json"), "utf8")).entries;
    assert.ok(entries.fromA && entries.fromB);
    assert.equal(w.git(w.a, "rev-list", "--count", "origin/main..HEAD").trim(), "2", "the merge is local; a pull pushes nothing");
  } finally { clean(w); }
});
