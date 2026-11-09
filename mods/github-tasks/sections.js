// The Tasks sidebar's sections, from top to bottom, and what each shows. Pure: main.js draws what sectionPlan says, and
// node --test checks it. Investigations are not tickets: their rows are New Task sessions (investigations.js), the same in GitHub
// and in local mode.

export const SECTIONS = [ // open: whether each starts expanded
  { id: "next", label: "Up Next", open: true },
  { id: "investigations", label: "Investigations", open: true },
  { id: "progress", label: "In Progress", open: true },
  { id: "review", label: "In Review", open: true },
  { id: "backlog", label: "Backlog", open: false },
];

// A section's header: "Investigations · 2".
export const sectionText = (label, count) => `${label} · ${count}`;

// What an expanded, empty section says.
export const emptyNote = (label) => `Nothing in ${label}.`;

// The sections to draw for the lists of each section's id, with `open` ({ id: boolean }) saying which are expanded:
// [{ id, label, title, count, open, items, empty }], in order. A collapsed section keeps its count but shows nothing under it.
export function sectionPlan(lists, open = {}) {
  return SECTIONS.map(({ id, label, open: starts }) => {
    const items = lists?.[id] ?? [];
    const expanded = open[id] ?? starts;
    return { id, label, title: sectionText(label, items.length), count: items.length, open: expanded, items: expanded ? items : [], empty: expanded && items.length === 0 ? emptyNote(label) : null };
  });
}

// Which sections start expanded: { next: true, investigations: true, ..., backlog: false }.
export const initialOpen = () => Object.fromEntries(SECTIONS.map((x) => [x.id, x.open]));

// The Investigations section alone, for when the ticket list can't be drawn (no project, a first-load error, still loading, a remote
// space): their rows are the way back to a session (and its Done button), so they stay. [] when no repo is known to look under (no
// context) or none of the places investigationList looks in: the place's main checkout (not on another machine) in local mode, that
// or the GitHub name in GitHub mode. Else sectionPlan's Investigations entry, with its own collapse state.
export function investigationsAlone({ ctx, local, remote, mainRoot, repo, items }, open = {}) {
  if (!ctx) return [];
  if (!((!remote && mainRoot) || (!local && repo))) return [];
  return sectionPlan({ investigations: items }, open).filter((s) => s.id === "investigations");
}
