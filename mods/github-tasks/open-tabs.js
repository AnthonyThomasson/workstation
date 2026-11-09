// One tab per workflow: the opener records the pane its tab.new made, and opening the same subject
// again selects that tab instead.
import { panes, run, shared, setShared } from "herdr";
import { recordedTab } from "./wontdo.js";

const slot = (subject) => `github-tasks.open:${subject}`;
const modPanes = () => panes().filter((p) => p.mod === "github-tasks");

// Selects the tab already open for the subject. False when there is none (or it has since been closed).
export function focusOpen(subject) {
  const at = subject && shared(slot(subject));
  if (!at || !modPanes().some((p) => p.pane === at.pane && p.tab === at.tab)) return false;
  run("tab.select", { id: at.tab });
  return true;
}

// Closes the tab open for the subject, by the id the opener recorded, so a tab the person moved to meanwhile is never the
// one that closes. False when none is recorded (a window opened without a subject) or it has since been closed.
export function closeOpen(subject) {
  const tab = recordedTab(subject && shared(slot(subject)), modPanes());
  if (!tab) return false;
  run("tab.close", { id: tab, confirmed: true }); // confirmed: it may be the space's last tab
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
      if (made) { setShared(slot(subject), { pane: made.pane, tab: made.tab }); return; }
      await cx.sleep(100);
    }
  });
}

export const workflowSubject = (scope, id) => (id ? `workflow:${scope}:${id}` : null);
