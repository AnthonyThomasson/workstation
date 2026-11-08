// When to sync: a pure queue with no Herdr, no git and no real timers (the tests give it a clock).
//
//   change(paths)  the watcher saw these paths change (relative to the synced folder, already without git-ignored ones).
//                  Once nothing has changed for debounceMs, and changed() says the content really differs, sync() runs once.
//   force()        sync() now.
//
// One sync runs at a time. Changes that arrive while one runs, or Force sync pressed, cause exactly one follow-up
// after it ends: a follow-up from a change still waits for debounceMs of quiet (counted from the last change),
// one from Force sync runs at once. The sync's own writes into the repo (skillshare/) never ask for a follow-up,
// and neither does anything inside .git/.
export const DEBOUNCE_MS = 3000;

// Inside any .git folder: git's own bookkeeping, not an edit.
export const isGitInternal = (rel) => String(rel).split("/").includes(".git");
// sync.sh writes into the repo only under skillshare/ (it rewrites config.yaml, and Skillshare reinstalls the recorded skills there).
export const isOwnWrite = (rel) => rel === "skillshare" || String(rel).startsWith("skillshare/");

// createSyncQueue({ sync, changed, now, setTimer, clearTimer, debounceMs }):
//   sync(): runs one sync, resolves when it ends (a rejection is ignored).
//   changed(): resolves to whether the folder's content differs from what the last sync left; asked before a quiet-period sync.
export function createSyncQueue({ sync, changed, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, debounceMs = DEBOUNCE_MS }) {
  // followUp: null | "change" | "now". gen counts rounds; checkingGen is the round whose content check is in flight.
  let running = false, timer = null, lastChange = 0, followUp = null, gen = 0, checkingGen = -1;

  const stop = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const quiet = () => Math.max(0, lastChange + debounceMs - now());
  const arm = (delay, skipCheck) => { stop(); timer = setTimer(() => { timer = null; fire(skipCheck); }, delay); };

  async function start() {
    gen++; stop();
    running = true; followUp = null; // changes that came before this point are covered by this sync
    try { await sync(); } catch { /* the caller reports its own failures */ }
    running = false;
    if (followUp === "now") start();
    else if (followUp === "change") { // the content did change during the sync: no need to ask again
      if (quiet() === 0) start(); else arm(quiet(), true);
    }
  }

  async function fire(skipCheck) {
    if (running) return;
    if (!skipCheck) {
      const mine = ++gen;
      checkingGen = mine;
      let differs = true;
      try { differs = await changed(); } catch { /* when in doubt, sync */ }
      if (mine !== gen || running) return; // a Force sync took over while we looked
      checkingGen = -1;
      if (!differs) {
        const again = followUp === "change"; // something else arrived while we looked
        followUp = null;
        if (again) arm(quiet(), false);
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
        if (real.some((p) => !isOwnWrite(p))) { lastChange = now(); followUp = followUp ?? "change"; }
        return;
      }
      lastChange = now();
      arm(debounceMs, false);
    },
    force() {
      if (running) { followUp = "now"; return; }
      start();
    },
    running: () => running,
    stop() { stop(); followUp = null; gen++; },
  };
}
