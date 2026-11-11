// Investigations, Herdr's side: starts a New Task Orchestrator the way a workflow starts a run (investigations.js has the logic and
// says how it works): a branch and worktree of its own, a folder of its own for its helpers' spawn script and prompts
// (investigation-spawn.js), the agent in the background (no parent, no pane: bgrun.js says why), its own space and tab. Also brings a
// session's tab to the front again (viewInvestigation) and shows the agents again after an app restart. The tab's page is
// investigation-page.js. The sidebar lists sessions with investigationsHere and opens them with viewInvestigation.
import { exec, hc, home, knownAgents, notify, panes, run, setShared, shared, spaces, terminals, writeTextFile } from "herdr";
import { guarded, undoRunTab, viewConnect, viewQuick, mainCheckout, prepareWorktree, out } from "../runs/index.js";
import { connect, connecting } from "../runs-ui/index.js";
import { app } from "../widgets/index.js";
import { newTaskPrompt, refactorPrompt, slotKey, INVESTIGATIONS_KEY } from "../lib/index.js";
import { normalizeRefactor, worktreePath, sessionFolder } from "../workflow/index.js";
import { INVESTIGATION_ROLE, agentOf, beginInvestigation, deleteBranch, investigationsFor, reapplyInvestigations, removeWorktree, tabNameFor } from "../investigations/index.js";

export { investigationsFor };

const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);

// The sessions to list for a repo: the saved ones started from its main checkout (repoRoot) or for its GitHub name (repo), each with its
// agent's status, an ended agent's too (only Done removes a session). Read from shared state and the core's terminals, so it follows
// an agent coming and going within a poll. `where`: { repoRoot, repo }.
export const investigationsHere = (where) => investigationsFor(shared(INVESTIGATIONS_KEY), where, terminals());

// The first message of the agent: the New Task prompt, or the Refactor Orchestrator's instead when `refactor` is set.
// agentsDir: the session's folder, with the spawn script the prompt tells it about.
function promptFor({ description, repo, project, settings, refactor }, agentsDir) {
  const type = refactor && normalizeRefactor(refactor.type), focus = refactor?.focus ?? "";
  const common = { repo, project, backlog: settings?.backlog, groomed: settings?.groomed, agentsDir };
  return type ? refactorPrompt({ ...common, type, focus }) : newTaskPrompt({ ...common, description });
}

// Writes the session's folder: the spawn script (runnable) and the prompts its helpers read. Throws with the reason.
async function writeSession(dir, files) {
  const made = await exec("mkdir", ["-p", dir]);
  if (made.code !== 0) throw new Error(`Couldn't make ${dir}: ${out(made)}`);
  await Promise.all(Object.entries(files).map(([name, text]) => writeTextFile(`${dir}/${name}`, text, null)));
  const chmod = await exec("chmod", ["+x", `${dir}/spawn`]);
  if (chmod.code !== 0) throw new Error(`Couldn't make the spawn script runnable: ${out(chmod)}`);
}

// Takes a folder writeSession made back, once a start fails. Recursive, so only a folder sessionFolder names for its own id is removed.
async function removeSession(dir) {
  if (sessionFolder(home(), String(dir).split("/").pop()) === dir) await exec("rm", ["-rf", dir]);
}

// Starts an Investigation: a New Task Orchestrator working in a worktree of its own, from the repo's default branch, in a tab of its own
// space; its first message is the New Task prompt with `description` in it. The agent has no parent and no pane (bgrun.js), so no tab close ends it.
// It works from a ticket's worktree space too (the branch
// is cut in the repo's main checkout). Throws with a message for the person when it can't, with nothing left behind.
//   args: { agent (of knownAgents()), description, repo, project, settings: { backlog, groomed }, groomer, subAgents: { investigator, worker } (their
//           saved settings), where: { cwd, on }, refactor: { type, focus } | null (investigations.js beginInvestigation) }
//   Resolves with { entry } (investigations.js has its shape).
export async function startInvestigation(args, cx) {
  let id = null, created = null;
  const { entry, problems } = await beginInvestigation({
    now: () => Date.now(), home: home(), mainCheckout: (cwd) => mainCheckout(git, cwd), prepareWorktree: (repoRoot, branch, target) => prepareWorktree(git, repoRoot, branch, target),
    worktreePath, task: (dir) => promptFor(args, dir), hc, knownAgents: () => knownAgents(), writeSession, removeSession,
    // A new space at the worktree, named for the session, its first tab the agent's; the Spaces sidebar nests it under the repo's.
    connect: async (props) => {
      id = props.id;
      const slot = await connect({ id, orchestrator: props.orchestrator, title: tabNameFor(props.title), space: null, folder: props.folder, props, kind: "investigation" }, cx);
      created = slot.created ? slot.space : null;
      return slot;
    },
    closeTab: () => {
      if (!id) return;
      undoRunTab({ created, part: tabParts(id), run: (n, a) => run(n, a) });
      created = null;
      setShared(slotKey(id), null);
    },
    load: () => shared(INVESTIGATIONS_KEY), save: (list) => setShared(INVESTIGATIONS_KEY, list),
    guard: (key, fn) => guarded(connecting, key, fn),
    cleanup: async (repoRoot, branch, workDir) => { await removeWorktree(git, repoRoot, workDir); await deleteBranch(git, repoRoot, branch); },
  }, args);
  if (problems.length) notify({ title: "The investigation started, with a problem", body: problems.join(" "), level: "warning" });
  return { entry };
}

// What is left of a session's tab, from its saved slot.
const tabParts = (id) => {
  const slot = shared(slotKey(id));
  const tab = slot?.tab;
  return tab && (spaces() ?? []).some((s) => (s.tabs ?? []).some((t) => t.id === tab)) ? { tab } : null;
};

// Brings a session's tab to the front, showing its agent again (switching to its space). When the tab was closed, opens a new one
// connected to the same agent, in its space or a new one at the worktree; when it lost its left pane or its page, makes that good.
// The agent itself isn't touched. A tab that can't be connected is said with the reason; this never throws.
// An agent that ended on its own is handled too: its tab opens with the page (Done is there) and a note on the left saying it ended,
// so the worktree isn't stranded.
//   entry: one of investigationsFor's.
export async function viewInvestigation(entry, cx) {
  const name = tabNameFor(entry.label);
  try {
    const props = { role: INVESTIGATION_ROLE, id: entry.id, orchestrator: entry.agent, title: entry.label, branch: entry.branch, folder: entry.workDir, repoRoot: entry.repoRoot };
    const kind = agentOf(entry, terminals()).live ? "investigation" : "investigation-ended"; // read once: the same for the quick and slow path
    const view = () => ({ slot: shared(slotKey(entry.id)), spaces: spaces(), panes: panes(), name, folder: entry.workDir, repoRoot: entry.repoRoot, orchestrators: [entry.agent], terminals: terminals() });
    if (viewQuick({
      ...view(), setSlot: (slot) => setShared(slotKey(entry.id), slot), run,
      show: (left) => { app("terminal.show", { terminal: entry.agent, pane: left }).catch(() => {}); }, // if it had slipped off, put it back
    })) return;
    const did = await guarded(connecting, entry.id, async () => {
      await viewConnect({
        ...view(), closeTab: (tab) => run("tab.close", { id: tab, confirmed: true }),
        connect: (existing, space) => connect({ id: entry.id, orchestrator: entry.agent, title: name, space, folder: entry.workDir, props, existing, kind }, cx),
      });
      return true;
    });
    if (did === false) notify({ title: name, body: "This investigation's tab is still being opened. It will be in front in a moment.", level: "info" });
  } catch (e) {
    notify({ title: `Couldn't connect to ${name}`, body: `${e?.message ?? e}. The agent itself is still going.`, level: "error" });
  }
}

// After a Herdr restart the terminals shown in tabs are not kept: show each live session's agent again in the tab it has. Waits for
// the app to list its spaces, panes and terminals. Safe to repeat.
export async function reconnectInvestigations(cx) {
  for (let i = 0; i < 40 && !(spaces().length && panes().length && terminals().length); i++) await cx.sleep(500);
  return reapplyInvestigations({ saved: shared(INVESTIGATIONS_KEY), terminals: terminals(), slot: (id) => shared(slotKey(id)), spaces: spaces(), panes: panes(), show: (a) => app("terminal.show", a) });
}
