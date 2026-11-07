// The detached job runner against real sh and the real file system.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner, JOB_MINUTES } from "./jobs.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = () => mkdtempSync(join(tmpdir(), "sync-jobs-"));
const runnerIn = (tmp, extra = {}) => createRunner({
  exec: (script, args) => new Promise((resolve) => execFile("sh", ["-c", script, "t", ...args], { env: { ...process.env, TMPDIR: tmp }, maxBuffer: 8 << 20 }, (e, stdout, stderr) => resolve({ code: e?.code ?? 0, stdout, stderr }))),
  readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
  pollMs: 20, ...extra,
});
const folders = (tmp) => readdirSync(tmp).filter((n) => n.startsWith("sync-mod-job."));

test("a script runs detached, gets its arguments, and its output, error and exit code come back", async () => {
  const tmp = scratch();
  try {
    const r = await runnerIn(tmp).job(["a b", "c"], { script: 'echo "got:$1|$2"; echo oops >&2; exit 3', sleep });
    assert.equal(r.code, 3);
    assert.equal(r.stdout.trim(), "got:a b|c");
    assert.equal(r.stderr.trim(), "oops");
    assert.deepEqual(folders(tmp), [], "the job folder is removed once read");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("a job outlives Herdr's 30 s exec by being polled, not waited on: the starter returns at once", async () => {
  const tmp = scratch();
  try {
    const runner = runnerIn(tmp);
    const t0 = Date.now();
    const r = await runner.job([], { script: "sleep 1; echo slow", sleep });
    assert.equal(r.stdout.trim(), "slow");
    assert.ok(Date.now() - t0 >= 1000);
    const start = Date.now();
    const raw = await runner.sh("sleep 0; echo quick");
    assert.ok(Date.now() - start < 1000 && raw.stdout.trim() === "quick");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("a job that is killed before it writes an exit code is reported, not waited on", async () => {
  const tmp = scratch();
  try {
    const r = await runnerIn(tmp, { aliveEvery: 2 }).job([], { script: 'kill -9 $PPID; sleep 5', sleep });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /stopped|Killed|killed/i);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("a job past its budget resolves with code 1", async () => {
  const tmp = scratch();
  try {
    const r = await runnerIn(tmp, { budgetMs: 100 }).job([], { script: "sleep 3", sleep });
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`${JOB_MINUTES} minutes`));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("the first job on a machine sweeps stale job folders, never a fresh one", async () => {
  const tmp = scratch();
  try {
    await runnerIn(tmp).sh('mkdir "$TMPDIR/sync-mod-job.old"; echo 0 > "$TMPDIR/sync-mod-job.old/code"; touch -t 200001010000 "$TMPDIR/sync-mod-job.old"; mkdir "$TMPDIR/sync-mod-job.new"; echo 0 > "$TMPDIR/sync-mod-job.new/code"');
    await runnerIn(tmp).job([], { script: "true", sleep });
    await sleep(200);
    assert.deepEqual(folders(tmp), ["sync-mod-job.new"]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
