// Pure logic for the branch / worktree picker: how the repo's worktrees and branches are ordered (most recently
// checked out first) and which of them a search shows. No Herdr, no I/O; targets.test.js runs under node.
//   worktree: { path, branch, at }      at = newest entry of its HEAD reflog, seconds (null/absent = no reflog)
//   branch:   { name, at }              at = committer date of its tip, seconds
//   checkout: { branch, at, idx }       a "checkout: moving from X to <branch>" reflog entry; idx = how far down that
//                                       reflog it was (0 = newest), to order checkouts made in the same second

export const RECENT = 5; // shown with an empty search
export const SEARCH_CAP = 50; // shown at most per list while searching

const base = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? String(p ?? "");
const num = (v) => (Number.isFinite(v) ? v : null);

// Worktrees newest reflog first, those without a reflog last (in git's order); branches in checkout order (the newest
// checkout of each wins; a branch that is checked out in a worktree but has no checkout entry counts from that
// worktree's newest reflog entry), then never-checked-out branches by committer date, then name. Every branch gets
// `path`: the worktree it is checked out in, or "".
export function orderTargets(targets) {
  const worktrees = [...(targets?.worktrees ?? [])];
  const branches = [...(targets?.branches ?? [])];
  const checkouts = targets?.checkouts ?? [];

  const sortedWorktrees = worktrees.map((w, i) => ({ w, i }))
    .sort((a, b) => (num(b.w.at) ?? -Infinity) - (num(a.w.at) ?? -Infinity) || a.i - b.i).map((x) => x.w);

  const best = new Map(); // branch -> { at, idx }
  for (const c of checkouts) {
    const at = num(c.at);
    if (!c.branch || at === null) continue;
    const idx = num(c.idx) ?? 0, cur = best.get(c.branch);
    if (!cur || at > cur.at || (at === cur.at && idx < cur.idx)) best.set(c.branch, { at, idx });
  }
  const where = new Map();
  for (const w of worktrees) {
    if (!w.branch) continue;
    where.set(w.branch, w.path);
    const at = num(w.at);
    if (!best.has(w.branch) && at !== null) best.set(w.branch, { at, idx: 0 });
  }
  const sortedBranches = branches.map((b) => ({ ...b, path: where.get(b.name) ?? "" })).sort((a, b) => {
    const x = best.get(a.name), y = best.get(b.name);
    if (x && y) return y.at - x.at || x.idx - y.idx || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (x) return -1;
    if (y) return 1;
    return (num(b.at) ?? 0) - (num(a.at) ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  return { worktrees: sortedWorktrees, branches: sortedBranches };
}

// What the picker shows for a search text. Without one, the first RECENT of each list. With one, every worktree
// (branch or folder name) and branch (name) that contains all of its words, case-insensitively, up to SEARCH_CAP each;
// more* counts the matches not shown.
export function pickerView(ordered, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const searching = words.length > 0, cap = searching ? SEARCH_CAP : RECENT;
  const hit = (text) => { const s = text.toLowerCase(); return words.every((w) => s.includes(w)); };
  const wts = (ordered?.worktrees ?? []).filter((w) => !searching || hit(`${w.branch ?? ""} ${base(w.path)}`));
  const brs = (ordered?.branches ?? []).filter((b) => !searching || hit(String(b.name)));
  return {
    worktrees: wts.slice(0, cap), branches: brs.slice(0, cap),
    moreWorktrees: Math.max(0, wts.length - cap), moreBranches: Math.max(0, brs.length - cap), searching,
  };
}
