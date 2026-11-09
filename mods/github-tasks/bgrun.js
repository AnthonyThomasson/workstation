// A run's orchestrator runs in the background, owned by no tab or pane (`hc run --bg`, with none of the herdr.space /
// herdr.tab labels that would adopt it into a pane). Its tab only shows it: a placeholder terminal on the left with the
// orchestrator shown over it (terminal.show), and the run page on the right. Closing the tab ends the placeholder, not
// the run. Pure apart from the deps it is handed, so node --test runs it.
import { FOLDER_LABEL, ROLE_LABEL, RUN_LABEL, SPACE_LABEL, TICKET_LABEL, shQuote } from "./run.js";

// Where the run's tab is saved (shared state, as herdr.tab labels are gone): { tab, left, space }.
export const slotKey = (id) => `github-tasks.runtab.${id}`;

// `hc run` for the orchestrator: no parent, so nothing but a kill or Merge ends it; its labels are set at birth.
export function orchestratorRunArgs({ id, key, workDir, space, argv }) {
  const labels = [`${RUN_LABEL}=${id}`, `${ROLE_LABEL}=orchestrator`, `${TICKET_LABEL}=${key}`, `${FOLDER_LABEL}=${workDir}`, ...(space ? [`${SPACE_LABEL}=${space}`] : [])];
  return ["run", "--bg", "--json", "--no-parent", "--cwd", workDir, ...labels.flatMap((l) => ["--label", l]), "--", ...argv];
}

// The address in the answer of `hc run --json`, or null.
export function parseStarted(stdout) {
  try { return JSON.parse(stdout)?.address || null; } catch { return null; }
}

// The program the tab's own terminal runs: a note, then it waits for ever (a program that exits closes its pane).
// The orchestrator is shown over it, so the note only reads when the connection is lost.
export const placeholderArgv = (orchestrator) => ["sh", "-c", `printf '%s\\n' ${shQuote(`Connecting to the orchestrator ${orchestrator}... View reconnects it.`)}; exec tail -f /dev/null`];

// The run's open tab: the saved slot, while its tab and its left pane still exist. Else null.
export function findRunTab({ slot, spaces, panes }) {
  if (!slot?.tab || !slot?.left) return null;
  const space = (spaces ?? []).find((s) => (s.tabs ?? []).some((t) => t.id === slot.tab));
  if (!space || !(panes ?? []).some((p) => p.pane === slot.left && p.tab === slot.tab)) return null;
  return { tab: slot.tab, left: slot.left, space: space.id };
}

// The space View opens a tab in: the one the run started in, or the current one when that is closed.
export const viewTarget = ({ started, spaces, current }) => ((spaces ?? []).some((s) => s.id === started) ? started : current);

const why = (e) => String(e?.message ?? e);

// Opens a tab connected to the orchestrator: placeholder on the left, orchestrator shown over it, run page on the right,
// the left focused. Throws with the reason; a tab it made is closed again then, so a retry never leaves two.
//   deps: { app(name, args) -> made, paneOf(made) -> pane id | null, run(name, args), setSlot(id, slot) }
export async function connectRun(deps, { id, orchestrator, name, space, folder, props }) {
  let made;
  try {
    made = await deps.app("tab.new", { name, ...(folder ? { folder } : {}), argv: placeholderArgv(orchestrator), ...(space ? { space } : {}) });
  } catch (e) { throw new Error(`the tab couldn't be made (${why(e)})`); }
  try {
    const left = await deps.paneOf(made);
    if (!left) throw new Error("the tab's pane didn't appear");
    deps.run("space.select", { id: made.space ?? space });
    deps.run("tab.select", { id: made.tab });
    const show = async () => {
      try { await deps.app("terminal.show", { terminal: orchestrator, pane: left }); }
      catch (e) { throw new Error(`the orchestrator ${orchestrator} couldn't be shown (${why(e)})`); }
    };
    await show(); // fails here, before the page opens, when the orchestrator can't be shown at all
    try { await deps.app("pane.split", { pane: left, direction: "right", mod: "github-tasks", props }); }
    catch (e) { throw new Error(`the run page couldn't open (${why(e)})`); }
    const slot = { tab: made.tab, left, space: made.space ?? space ?? null };
    deps.setSlot(id, slot);
    deps.run("pane.focus", { pane: left });
    await holdShown(deps, { orchestrator, left, show });
    return slot;
  } catch (e) {
    try { deps.run("tab.close", { id: made.tab }); } catch { /* it stays; View finds nothing saved and makes another */ }
    throw e;
  }
}

// A terminal.show made while the new tab is settling is lost (found out live: the placeholder stayed on screen until a
// later show), so it is repeated until the app says it holds (focused().shown, via deps.isShown), or a few times when
// it can't say. A show that keeps failing is left: the tab is there, and View connects again.
export async function holdShown(deps, { orchestrator, left, show, tries = 10, wait = 300 }) {
  for (let i = 0; i < tries; i++) {
    await deps.sleep(wait);
    if (deps.isShown?.(orchestrator, left)) return true;
    try { await show(); } catch { /* tried again next time round */ }
  }
  return Boolean(deps.isShown?.(orchestrator, left));
}

// After a Herdr restart a terminal.show is gone: show each live orchestrator again over the left pane of the one tab its
// run has. Runs with no tab are left for View. Resolves with how many were shown; one that fails doesn't stop the rest.
export async function reapplyRuns({ terminals, slot, spaces, panes, show }) {
  let shown = 0;
  for (const k of terminals ?? []) {
    const id = k.labels?.[RUN_LABEL];
    if (k.state !== "live" || k.labels?.[ROLE_LABEL] !== "orchestrator" || !id) continue;
    const open = findRunTab({ slot: slot(id), spaces, panes });
    if (!open) continue;
    try { await show({ terminal: k.address, pane: open.left }); shown++; } catch { /* the next pass or View tries again */ }
  }
  return shown;
}

// Merge's end of a run: the workers and reviewers, then the orchestrator, are killed on purpose (nothing else ends a
// background run), then the run's tab is closed if it is open. A closed tab is not a failure.
//   deps: { hc(args), run(name, args), terminals, slot, spaces, panes, clearSlot() }. Resolves with { tabClosed }.
export async function endRun({ id, orchestrator, terminals, hc, run, slot, spaces, panes, clearSlot }) {
  const others = (terminals ?? []).filter((k) => k.labels?.[RUN_LABEL] === id && k.address !== orchestrator);
  for (const address of [...others.map((k) => k.address), orchestrator]) {
    if (!address) continue;
    await hc(["kill", address]).catch(() => {});
    await hc(["rm", address]).catch(() => {});
  }
  const open = findRunTab({ slot, spaces, panes });
  clearSlot();
  if (!open) return { tabClosed: false };
  run("tab.close", { id: open.tab });
  return { tabClosed: true };
}
