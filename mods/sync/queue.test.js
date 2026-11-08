// The debounce and follow-up logic, with fake time: no timers, no git, no Herdr.
import test from "node:test";
import assert from "node:assert/strict";
import { createSyncQueue, isGitInternal, isOwnWrite, DEBOUNCE_MS } from "./queue.js";

// A clock the test moves by hand, and a sync the test finishes by hand.
function rig({ changed = () => true } = {}) {
  const clock = { t: 1_000_000, timers: [], id: 0 };
  const log = [];
  const sync = { running: 0, finish: [] };
  const q = createSyncQueue({
    now: () => clock.t,
    setTimer: (fn, ms) => { const id = ++clock.id; clock.timers.push({ id, at: clock.t + ms, fn }); return id; },
    clearTimer: (id) => { clock.timers = clock.timers.filter((x) => x.id !== id); },
    sync: () => { log.push({ at: clock.t - clock.start }); sync.running++; return new Promise((resolve) => sync.finish.push(() => { sync.running--; resolve(); })); },
    changed: () => Promise.resolve(changed()),
  });
  clock.start = clock.t;
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const advance = async (ms) => {
    const end = clock.t + ms;
    for (;;) {
      const next = clock.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      clock.timers = clock.timers.filter((x) => x !== next);
      clock.t = next.at;
      next.fn();
      await flush();
    }
    clock.t = end;
    await flush();
  };
  const done = async () => { sync.finish.shift()(); await flush(); };
  return { q, clock, log, sync, advance, done, flush };
}

test("a change syncs once it has been quiet for 3 s", async () => {
  const r = rig();
  r.q.change(["mods/a/main.js"]);
  await r.advance(DEBOUNCE_MS - 1);
  assert.equal(r.log.length, 0);
  await r.advance(1);
  assert.equal(r.log.length, 1);
  assert.equal(DEBOUNCE_MS, 3000);
});

test("a burst of changes is one sync, 3 s after the last one", async () => {
  const r = rig();
  r.q.change(["a"]);
  await r.advance(1000); r.q.change(["b", "c"]);
  await r.advance(1500); r.q.change(["d"]);
  await r.advance(2999);
  assert.equal(r.log.length, 0);
  await r.advance(1);
  assert.equal(r.log.length, 1);
  await r.done();
  await r.advance(60000);
  assert.equal(r.log.length, 1, "nothing else follows");
});

test("changes inside .git/ never start anything", async () => {
  const r = rig();
  r.q.change([".git/index", ".git/refs/heads/main", ".git"]);
  await r.advance(60000);
  assert.equal(r.log.length, 0);
  assert.equal(isGitInternal(".git/HEAD"), true);
  assert.equal(isGitInternal(".git"), true);
  assert.equal(isGitInternal("mods/x/.git/HEAD"), true);
  assert.equal(isGitInternal(".github/workflows/ci.yml"), false);
  assert.equal(isGitInternal(".gitignore"), false);
  assert.equal(isGitInternal("mods/a/.gitkeep"), false);
});

test(".git/ noise does not push a pending sync back", async () => {
  const r = rig();
  r.q.change(["a"]);
  await r.advance(2000); r.q.change([".git/index"]);
  await r.advance(1000);
  assert.equal(r.log.length, 1);
});

test("a change that left the content as it was (the check says so) does not sync", async () => {
  const r = rig({ changed: () => false });
  r.q.change(["mods/a/main.js"]);
  await r.advance(10000);
  assert.equal(r.log.length, 0);
});

test("changes that arrive during a sync cause exactly one follow-up after it ends", async () => {
  const r = rig();
  r.q.change(["a"]);
  await r.advance(3000);
  assert.equal(r.log.length, 1);
  await r.advance(500); r.q.change(["b"]);
  await r.advance(500); r.q.change(["c"]);
  await r.advance(500); r.q.change(["d"]);
  await r.advance(20000);
  assert.equal(r.log.length, 1, "no second sync while the first runs");
  await r.done(); // the sync ends 21.5 s after it started; the last change is long past the quiet period
  assert.equal(r.log.length, 2, "one follow-up, at once");
  await r.done();
  await r.advance(60000);
  assert.equal(r.log.length, 2);
});

test("the follow-up still waits for 3 quiet seconds after the last change", async () => {
  const r = rig();
  r.q.change(["a"]);
  await r.advance(3000);
  await r.advance(1000); r.q.change(["b"]);
  await r.done(); // ends right after the change
  assert.equal(r.log.length, 1);
  await r.advance(2999);
  assert.equal(r.log.length, 1);
  await r.advance(1);
  assert.equal(r.log.length, 2);
});

test("the sync's own writes (skillshare/) during a sync cause no follow-up", async () => {
  const r = rig();
  r.q.change(["a"]);
  await r.advance(3000);
  r.q.change(["skillshare/config.yaml"]);
  r.q.change(["skillshare/skills/.metadata.json", "skillshare/skills/installed/SKILL.md", ".git/index"]);
  await r.done();
  await r.advance(60000);
  assert.equal(r.log.length, 1);
  assert.equal(isOwnWrite("skillshare/config.yaml"), true);
  assert.equal(isOwnWrite("skillshare/skills/x"), true);
  assert.equal(isOwnWrite("skillshare"), true);
  assert.equal(isOwnWrite("mods/skillshare/main.js"), false);
  assert.equal(isOwnWrite("skillshare-notes.md"), false);
});

test("a real change mixed in with the sync's own writes still gets its follow-up", async () => {
  const r = rig();
  r.q.change(["a"]);
  await r.advance(3000);
  r.q.change(["skillshare/config.yaml", "mods/b/main.js"]);
  await r.done();
  await r.advance(3000);
  assert.equal(r.log.length, 2);
});

test("Force sync syncs right away and drops a pending quiet-period sync", async () => {
  const r = rig();
  r.q.change(["a"]);
  await r.advance(1000);
  r.q.force();
  await r.flush();
  assert.equal(r.log.length, 1);
  await r.done();
  await r.advance(60000);
  assert.equal(r.log.length, 1, "the change it already covered does not sync again");
});

test("Force sync while a sync runs is one follow-up right after it, however many times it is pressed", async () => {
  const r = rig();
  r.q.force();
  await r.flush();
  assert.equal(r.log.length, 1);
  r.q.force(); r.q.force(); r.q.force();
  await r.advance(10000);
  assert.equal(r.log.length, 1, "never two at once");
  assert.equal(r.sync.running, 1);
  await r.done();
  assert.equal(r.log.length, 2);
  assert.equal(r.sync.running, 1);
  await r.done();
  await r.advance(60000);
  assert.equal(r.log.length, 2);
});

test("Force sync runs even when nothing changed", async () => {
  const r = rig({ changed: () => false });
  r.q.force();
  await r.flush();
  assert.equal(r.log.length, 1);
});

test("a follow-up that has changes in it syncs again; each sync is one at a time", async () => {
  const r = rig();
  r.q.force();
  await r.flush();
  r.q.change(["a"]);
  await r.done();
  await r.advance(3000);
  assert.equal(r.log.length, 2);
  r.q.change(["b"]);
  await r.done();
  await r.advance(3000);
  assert.equal(r.log.length, 3);
  assert.equal(r.sync.running, 1);
});

test("a Force sync pressed while the content check runs does not start a second sync", async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const r = rig({ changed: () => gate.then(() => true) });
  r.q.change(["a"]);
  await r.advance(3000); // the check is waiting
  r.q.force();
  await r.flush();
  assert.equal(r.log.length, 1);
  release();
  await r.flush();
  assert.equal(r.log.length, 1, "the stale check is dropped");
  assert.equal(r.sync.running, 1);
});

test("a change that arrives while the content check runs is not lost", async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  let calls = 0;
  const r = rig({ changed: () => { calls++; return calls === 1 ? gate.then(() => false) : true; } });
  r.q.change(["a"]);
  await r.advance(3000); // the first check is waiting and will say "unchanged"
  r.q.change(["b"]);
  release();
  await r.flush();
  await r.advance(3000);
  assert.equal(r.log.length, 1);
});

test("a sync that throws does not wedge the queue", async () => {
  let calls = 0;
  const q = createSyncQueue({
    now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout, changed: async () => true,
    sync: async () => { calls++; if (calls === 1) throw new Error("boom"); },
  });
  q.force(); await new Promise((r) => setTimeout(r, 10));
  assert.equal(q.running(), false);
  q.force(); await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 2);
});

test("stop() cancels everything pending", async () => {
  const r = rig();
  r.q.change(["a"]);
  r.q.stop();
  await r.advance(60000);
  assert.equal(r.log.length, 0);
});
