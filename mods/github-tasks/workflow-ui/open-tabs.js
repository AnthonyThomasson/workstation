// One tab per workflow or refactor type (see kinds.js kindSubject): the opener records the pane its tab.new made, and opening the same subject
// again selects that tab instead.
import { panes, run, shared, setShared } from "herdr";
import { openKey } from "../lib/index.js";

const modPanes = () => panes().filter((p) => p.mod === "github-tasks");

// Selects the tab already open for the subject. False when there is none (or it has since been closed).
export function focusOpen(subject) {
  const at = subject && shared(openKey(subject));
  if (!at || !modPanes().some((p) => p.pane === at.pane && p.tab === at.tab)) return false;
  run("tab.select", { id: at.tab });
  return true;
}

// Opens the tab, or selects the one already open for the subject. A subject of null always opens a new tab.
export function openOnce(subject, args, cx) {
  if (focusOpen(subject)) return;
  const before = new Set(modPanes().map((p) => p.pane));
  run("tab.new", args);
  if (!subject) return;
  cx.spawn(async (cx) => {
    for (let i = 0; i < 30; i++) {
      const made = modPanes().find((p) => !before.has(p.pane));
      if (made) { setShared(openKey(subject), { pane: made.pane, tab: made.tab }); return; }
      await cx.sleep(100);
    }
  });
}
