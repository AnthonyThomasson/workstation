// The detached job runner against real sh and the real file system.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner, spellBudget, JOB_MINUTES, START } from "./jobs.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = () => mkdtempSync(join(tmpdir(), "sync-jobs-"));
const runnerIn = (tmp, extra = {}) => createRunner({
  exec: (script, args) => new Promise((resolve) => execFile("sh", ["-c", script, "t", ...args], { env: { ...process.env, TMPDIR: tmp }, maxBuffer: 8 << 20 }, (e, stdout, stderr) => resolve({ code: e?.code ?? 0, stdout, stderr }))),
  readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
  // A job that never shows its code fails here in 30 s, well inside the test timeout, rather than polling for JOB_MINUTES.
  pollMs: 20, budgetMs: 30000, ...extra,
});
// Removes a test's temp folder. On Windows a job's leftover child (the killed job's sleep) can still hold a file in it open for a
// few seconds: retry a little, then leave the folder to the OS's temp cleanup rather than fail or hang the run.
const cleanup = (tmp) => {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { if (process.platform !== "win32") throw e; }
};
// Waits (up to 10 s) until the temp folder's job folders are `want`, since the sweep runs beside the job, not before it.
const foldersBecome = async (tmp, want) => {
  for (let i = 0; i < 100 && JSON.stringify(folders(tmp)) !== JSON.stringify(want); i++) await sleep(100);
  return folders(tmp);
};
const folders = (tmp) => readdirSync(tmp).filter((n) => n.startsWith("sync-mod-job."));

test("a script runs detached, gets its arguments, and its output, error and exit code come back", async () => {
  const tmp = scratch();
  try {
    const r = await runnerIn(tmp).job(["a b", "c"], { script: 'echo "got:$1|$2"; echo oops >&2; exit 3', sleep });
    assert.equal(r.code, 3);
    assert.equal(r.stdout.trim(), "got:a b|c");
    assert.equal(r.stderr.trim(), "oops");
    assert.deepEqual(folders(tmp), [], "the job folder is removed once read");
  } finally { cleanup(tmp); }
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
  } finally { cleanup(tmp); }
});

test("a job that is killed before it writes an exit code is reported, not waited on", async () => {
  const tmp = scratch();
  try {
    const r = await runnerIn(tmp, { aliveEvery: 2 }).job([], { script: 'kill -9 $PPID; sleep 5', sleep });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /stopped|Killed|killed/i);
  } finally { cleanup(tmp); }
});

test("a job past its budget resolves with code 1", async () => {
  const tmp = scratch();
  try {
    const r = await runnerIn(tmp, { budgetMs: 100 }).job([], { script: "sleep 3", sleep });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^The job took longer than 0\.1 seconds/, "the budget it was given, not the default");
  } finally { cleanup(tmp); }
});

test("the first job on a machine sweeps stale job folders, never a fresh one", async () => {
  const tmp = scratch();
  try {
    await runnerIn(tmp).sh('mkdir "$TMPDIR/sync-mod-job.old"; echo 0 > "$TMPDIR/sync-mod-job.old/code"; touch -t 200001010000 "$TMPDIR/sync-mod-job.old"; mkdir "$TMPDIR/sync-mod-job.new"; echo 0 > "$TMPDIR/sync-mod-job.new/code"');
    await runnerIn(tmp).job([], { script: "true", sleep });
    assert.deepEqual(await foldersBecome(tmp, ["sync-mod-job.new"]), ["sync-mod-job.new"]);
  } finally { cleanup(tmp); }
});

test("the budget is said as it is: the default as minutes, a short one as seconds", () => {
  assert.equal(spellBudget(JOB_MINUTES * 60 * 1000), "15 minutes");
  assert.equal(spellBudget(60000), "1 minute");
  assert.equal(spellBudget(1000), "1 second");
  assert.equal(spellBudget(100), "0.1 seconds");
});

test("the budget is wall time: slow polls end the job at the budget, not after budget / pollMs polls", async () => {
  let clock = 0, polls = 0;
  const runner = createRunner({
    exec: async (script) => ({ code: 0, stdout: script === START ? "/tmp/sync-mod-job.x\n" : "", stderr: "" }),
    readText: () => null, pollMs: 20, budgetMs: 1000, aliveEvery: 1000, now: () => clock,
  });
  const r = await runner.job([], { script: "true", sleep: async () => { polls++; clock += 250; } });
  assert.equal(r.code, 1);
  assert.equal(polls, 4, "four 250 ms polls fill a 1 s budget");
});

test("the job folder is START's last line, so whatever a shell prints before it does not matter", async () => {
  const tmp = scratch();
  try {
    const real = runnerIn(tmp);
    const seen = [];
    const noisy = createRunner({
      exec: async (script, args) => {
        const r = await real.sh(script, args);
        return script === START ? { ...r, stdout: `warning: in the working copy of 'x', LF will be replaced by CRLF\r\n${r.stdout}` } : r;
      },
      readText: (path) => { seen.push(path); try { return readFileSync(path, "utf8"); } catch { return null; } },
      pollMs: 20, budgetMs: 30000,
    });
    const r = await noisy.job(["x"], { script: 'echo "got:$1"', sleep });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "got:x");
    assert.ok(seen.every((p) => !p.includes("warning")), seen[0]);
  } finally { cleanup(tmp); }
});

test("on Git Bash and Cygwin the job runs without job control, which would stop it when it starts a Windows program", () => {
  assert.match(START, /case "\$\{OSTYPE:-\}" in msys\*\|cygwin\*\) ;; \*\) set -m ;; esac/);
});
