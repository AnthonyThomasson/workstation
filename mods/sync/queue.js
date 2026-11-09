// When to sync: a pure queue with no Herdr, no git and no real timers (the tests give it a clock).
//
//   change(paths)  the watcher saw these paths change (relative to the synced folder, already without git-ignored ones).
//                  Once nothing has changed for debounceMs, and changed() says the content really differs, sync() runs once.
//   force()        sync() now.
//
// One sync runs at a time. sync() resolves to true when the folder's content changed while it ran (an edit during the
// copy may have been missed), which is a reason for one more sync that no content check can talk out of: it runs after a
// quiet period and the reason survives any later change(). Events that arrive while a sync runs are not a reason on
// their own (a branch switch's files are reported after the sync began, and the sync already copied them): they only
// ask for a content check once the sync ends. Force sync pressed during a sync runs one more at once. The sync's own
// writes into the repo (skillshare/) are never changes, and neither is anything inside .git/.
export const DEBOUNCE_MS = 3000;

// Inside any .git folder: git's own bookkeeping, not an edit.
export const isGitInternal = (rel) => String(rel).split("/").includes(".git");
// sync.sh writes into the repo only under skillshare/ (it rewrites config.yaml, and Skillshare reinstalls the recorded skills there).
export const isOwnWrite = (rel) => rel === "skillshare" || String(rel).startsWith("skillshare/");

// createSyncQueue({ sync, changed, now, setTimer, clearTimer, debounceMs }):
//   sync(): runs one sync, resolves when it ends, to true if the content changed while it ran (a rejection is ignored).
//   changed(): resolves to whether the folder's content differs from what the last sync started from; asked before a
//     quiet-period sync, never for a sync that reported a change.
export function createSyncQueue({ sync, changed, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, debounceMs = DEBOUNCE_MS }) {
  // followUp: Force sync pressed during a sync. sawChange: events during a sync or a check. dirty: the last sync reported
  // a change. gen counts rounds; checkingGen is the round whose content check is in flight.
  let running = false, timer = null, lastChange = 0, followUp = false, sawChange = false, dirty = false, gen = 0, checkingGen = -1;

  const stop = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const quiet = () => Math.max(0, lastChange + debounceMs - now());
  const arm = (delay) => { stop(); timer = setTimer(() => { timer = null; fire(); }, delay); };
  const schedule = () => { const d = quiet(); if (d === 0) fire(); else arm(d); };

  async function start() {
    gen++; stop();
    running = true; followUp = false; sawChange = false; dirty = false; // what came before is covered by this sync
    let changedDuring = false;
    try { changedDuring = (await sync()) === true; } catch { /* the caller reports its own failures */ }
    running = false;
    if (changedDuring) { dirty = true; lastChange = now(); } // wait for the edits to stop
    if (followUp) start();
    else if (dirty || sawChange) schedule();
  }

  async function fire() {
    if (running) return;
    if (!dirty) {
      const mine = ++gen;
      checkingGen = mine; sawChange = false; // from here on, only what arrives during the check counts as news
      let differs = true;
      try { differs = await changed(); } catch { /* when in doubt, sync */ }
      if (mine !== gen || running) return; // a Force sync took over while we looked
      checkingGen = -1;
      if (!differs) {
        if (sawChange) { sawChange = false; arm(quiet()); } // something arrived while we looked
        return;
      }
    }
    start();
  }

  return {
    change(paths) {
      const real = [...paths].filter((p) => !isGitInternal(p));
      if (!real.length) return;
      if (running || checkingGen === gen) {
        if (real.some((p) => !isOwnWrite(p))) { lastChange = now(); sawChange = true; }
        return;
      }
      lastChange = now();
      arm(debounceMs);
    },
    force() {
      if (running) { followUp = true; return; }
      start();
    },
    running: () => running,
    stop() { stop(); followUp = false; sawChange = false; dirty = false; gen++; },
  };
}
