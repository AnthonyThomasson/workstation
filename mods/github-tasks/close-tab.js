// Guards the key that closes a tab. Closing a tab ends every terminal in it, so closing a running workflow's tab loses
// the orchestrator and all its agents with one key press. keys.json binds the key to "github-tasks.close_tab" (main.js
// hands that to closeFocusedTab): a tab holding a live orchestrator asks first (close-confirm.js is the question); any
// other tab closes as the plain key would. Everything Herdr gives comes in as `deps`, so node --test runs it against fakes:
//   deps.focused()  deps.panes()  deps.terminals()  deps.tabName(id)  deps.run(command, args)  deps.ask({ tab, name })  deps.asking(tab)
//   deps.dismiss()  deps.notify(note)
// (asking: a question for that tab is already on screen.)
import { ROLE_LABEL, RUN_LABEL } from "./run.js";

// The live orchestrator of a run that has a pane in this tab, or null.
export const liveRunIn = (tab, deps) => {
  const here = new Set(deps.panes().filter((p) => p.tab === tab && p.terminal).map((p) => p.terminal));
  return deps.terminals().find((k) => here.has(k.address) && k.state === "live" && k.labels?.[ROLE_LABEL] === "orchestrator" && k.labels?.[RUN_LABEL]) ?? null;
};

// shared(ASKING): { [tab]: when the question opened }, so a second key press doesn't open a second one. The dialog removes its
// entry when it goes away (Cancel, Close, Esc and app quit all end in its close()), so an entry never expires by itself.
export const ASKING = "github-tasks.closeAsking";
export const isAsking = (map, tab) => Boolean(map && tab in map);

// shared() survives a restart, so a crash with the dialog open leaves a mark that would swallow that tab's key for good.
// No dialog can be open when the mod starts: it clears them all (deps.setShared).
export const forgetAsking = (deps) => deps.setShared(ASKING, {});

export const closeMessage = (name) => `${name} is still running. Closing its tab stops the orchestrator and all its workers and reviewers.`;

const fail = (deps, e) => deps.notify({ title: "Couldn't close the tab", body: String(e?.message ?? e), level: "error" });

// What the key does. Doesn't throw. deps.run may be async: its failure is reported too.
export async function closeFocusedTab(deps) {
  try {
    const tab = deps.focused()?.tab;
    if (!tab) throw new Error("No tab is focused.");
    if (liveRunIn(tab, deps)) { if (!deps.asking?.(tab)) deps.ask({ tab, name: deps.tabName(tab) }); }
    else await deps.run("tab.close", { id: tab });
  } catch (e) { fail(deps, e); }
}

// The dialog's Cancel: it goes away and nothing is closed.
export const cancelClose = (deps) => deps.dismiss();

// The dialog's Close: the person has seen the warning. The dialog goes away first, then the tab closes.
export async function confirmClose(props, deps) {
  deps.dismiss();
  await closeConfirmed(props, deps);
}

export async function closeConfirmed({ tab }, deps) {
  try { await deps.run("tab.close", { id: tab, confirmed: true }); } catch (e) { fail(deps, e); }
}
