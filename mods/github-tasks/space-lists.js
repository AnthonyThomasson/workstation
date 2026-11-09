// The Tasks sidebar's list state, and each space's last list kept in memory (until the app restarts) so that
// switching back to a space shows it at once while the reload runs. Pure: the sidebar passes itself in as `view`
// (a plain object with the fields newList sets), so space-lists.test.js can run it without Herdr.

// The key of a space in the sidebar: its id and machine.
export const spaceKey = (ctx) => (ctx ? `${ctx.space}|${ctx.on}` : null);

// A view with no list: placeholders until a load finishes. `restored` is set while a saved list is on screen
// and the reload that checks it is still running.
export function newList(ctx) {
  const view = { token: 0, restored: null };
  resetList(view, ctx);
  return view;
}

// A new place starts over, and whatever is still loading for the old one is dropped (its token is no longer current).
export function resetList(view, ctx) {
  view.ctx = ctx;
  view.token = (view.token ?? 0) + 1;
  view.loading = false;
  view.restored = null;
  forgetRepo(view);
  view.place = null; // readPlace's answer: { folder, on, mainRoot, remote, source }
  view.placeCache = null;
  view.source = "github"; // which source the list shows: "local" or "github"
  view.localStages = null; // local mode's sections, null until loaded
  view.localError = null;
  view.error = null;
  view.setupError = null;
  view.startError = null;
}

export function forgetRepo(view) {
  view.repo = null;
  view.repoFolder = null;
  view.projects = [];
  view.project = null;
  clearTickets(view);
}

export function clearTickets(view) {
  view.groups = { open: [], closed: [] };
  view.truncated = false;
  view.loaded = false;
}

// A load only counts if no new place started over since it began.
export const isCurrent = (view, token) => token === view.token;

// What is on screen, if there is a list to keep; null when only placeholders, an error or "no project" show.
// A GitHub list counts only while its repo was found for the folder the space is in now: after a cd the old
// repo's tickets stay up until the new folder's repo is known, and they must not be kept as this space's.
// Errors are never kept.
export function snapshotOf(view) {
  if (view.source === "local") {
    if (!view.localStages) return null;
    return { source: "local", place: view.place, localStages: view.localStages };
  }
  if (!view.loaded || !view.project || !view.repo || view.repoFolder !== view.ctx?.folder) return null;
  return {
    source: "github", place: view.place, repo: view.repo, repoFolder: view.repoFolder,
    projects: view.projects.slice(), project: view.project, groups: view.groups, truncated: view.truncated,
  };
}

// Puts a saved list on screen, on a view that was just reset, and marks it as unchecked until its reload finishes.
export function restoreList(view, snap) {
  view.source = snap.source;
  view.place = snap.place;
  if (snap.source === "local") {
    view.localStages = snap.localStages;
  } else {
    view.repo = snap.repo;
    view.repoFolder = snap.repoFolder;
    view.projects = snap.projects.slice();
    view.project = snap.project;
    view.groups = snap.groups;
    view.truncated = snap.truncated;
    view.loaded = true;
  }
  view.restored = { source: snap.source, mainRoot: snap.place?.mainRoot, projectId: snap.project?.id };
}

// Each space's last list, by spaceKey.
export class SpaceLists {
  constructor() { this.map = new Map(); }

  has(key) { return this.map.has(key); }

  // Leaving a space (or at any time): keeps what the view shows for the key, or forgets the key's list when
  // the view shows none.
  save(key, view) {
    if (key == null) return;
    const snap = snapshotOf(view);
    if (snap) this.map.set(key, snap);
    else this.map.delete(key);
  }

  // Entering a space: puts its saved list on a freshly reset view. False for a space not opened yet.
  restore(key, view) {
    const snap = key == null ? null : this.map.get(key);
    if (!snap) return false;
    restoreList(view, snap);
    return true;
  }
}

// The reload's checks of a restored list. Each drops the list when the fresh answer is not the one it was for,
// so the placeholders show until the new list loads. All of them do nothing once the list was loaded here.

// The place's source is known: a change of source (or of local repo) starts the list over. True when it changed.
export function applyPlace(view, place) {
  const changed = place.source !== view.source || (place.source === "local" && place.mainRoot !== view.place?.mainRoot);
  view.place = place;
  view.placeCache = place.cache;
  view.source = place.source;
  if (changed) {
    forgetRepo(view);
    view.error = null;
    view.localStages = null;
    view.localError = null;
  }
  return changed;
}

// The repo was found: another repo than the list's drops it. True when it changed.
export function applyRepo(view, repo) {
  if (repo === view.repo) return false;
  forgetRepo(view);
  view.repo = repo;
  return true;
}

// The project was chosen (view.project): another one than the restored list's, or none, drops the list.
export function applyProject(view) {
  if (view.restored && view.project?.id !== view.restored.projectId) clearTickets(view);
}

// The reload failed, for any reason: a restored list goes, so only the error shows, as when nothing was loaded.
// True when a list was dropped.
export function failReload(view) {
  if (!view.restored) return false;
  forgetRepo(view);
  view.localStages = null;
  view.restored = null;
  return true;
}

// The reload finished: whatever is on screen is the fresh answer.
export function doneReload(view) {
  view.restored = null;
}
