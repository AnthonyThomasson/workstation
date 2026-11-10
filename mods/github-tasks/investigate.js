// Investigations, Herdr's side: starts a New Task Orchestrator the way a workflow starts a run (investigations.js has the logic and
// says how it works): a branch and worktree of its own, a folder of its own for its helpers' spawn script and prompts
// (investigation-spawn.js), a host terminal that is its parent in the Agents panel, the agent in the background, its own space and tab. Also brings a
// session's tab to the front again (viewInvestigation) and shows the agents again after an app restart. The tab's page is
// investigation-page.js. The sidebar lists sessions with investigationsHere and opens them with viewInvestigation.
import { exec, hc, home, knownAgents, notify, panes, run, setShared, shared, spaces, terminals, writeTextFile } from "herdr";
import { endHost, guarded, hostKey, openHost, slotKey, undoRunTab, viewConnect, viewQuick } from "./bgrun.js";
import { connect, connecting } from "./start.js";
import { mainCheckout, prepareWorktree } from "./worktree.js";
import { app } from "./ui.js";
import { localTasks } from "./local-tasks-env.js";
import { statusDir } from "./local-tasks.js";
import { localNewTaskPrompt } from "./local-ui.js";
import { newTaskPrompt } from "./model.js";
import { out, worktreePath } from "./run.js";
import { sessionFolder } from "./investigation-spawn.js";
import {
  INVESTIGATIONS_KEY, INVESTIGATION_HOST_LABEL, INVESTIGATION_ROLE, agentOf, beginInvestigation, deleteBranch, investigationsFor, reapplyInvestigations, removeWorktree, tabNameFor,
} from "./investigations.js";

export { investigationsFor };

const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);

const HOST_NOTE = "Host of this session's agents in the Agents panel. Ends when Done is pressed on the session.";

// The sessions to list for a repo: the saved ones started from its main checkout (repoRoot) or for its GitHub name (repo), each with its
// agent's status, an ended agent's too (only Done removes a session). Read from shared state and the core's terminals, so it follows
// an agent coming and going within a poll. `where`: { repoRoot, repo }.
export const investigationsHere = (where) => investigationsFor(shared(INVESTIGATIONS_KEY), where, terminals());

// The first message of the agent: the New Task prompt for GitHub tickets, or for local tasks with the folders and the next id.
// agentsDir: the session's folder, with the spawn script the prompt tells it about.
async function promptFor({ description, repo, project, settings, local }, agentsDir) {
  if (!local) return newTaskPrompt({ repo, project, backlog: settings?.backlog, groomed: settings?.groomed, description, agentsDir });
  const nextId = await localTasks(local.mainRoot).nextId();
  return localNewTaskPrompt({
    mainRoot: local.mainRoot, nextId, description, agentsDir,
    todoDir: statusDir(home(), local.mainRoot, "to-do"), upNextDir: statusDir(home(), local.mainRoot, "up-next"),
  });
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
// space; its first message is the New Task prompt with `description` in it. The agent is started under a host (bgrun.js) so the Agents
// panel lists it; a host that won't open fails the start. It works from a ticket's worktree space too (the branch
// is cut in the repo's main checkout). Throws with a message for the person when it can't, with nothing left behind.
//   args: { agent (of knownAgents()), description, repo, project, settings: { backlog, groomed }, groomer, subAgents: { investigator, worker } (their
//           saved settings), where: { cwd, on }, local: { mainRoot } | null }
//   Resolves with { entry } (investigations.js has its shape).
export async function startInvestigation(args, cx) {
  let id = null, created = null, sessionId = null;
  const { entry, problems } = await beginInvestigation({
    now: () => Date.now(), home: home(), mainCheckout: (cwd) => mainCheckout(git, cwd), prepareWorktree: (repoRoot, branch, target) => prepareWorktree(git, repoRoot, branch, target),
    worktreePath, task: (dir) => promptFor(args, dir), hc, knownAgents: () => knownAgents(), writeSession, removeSession,
    // The agent's parent, so the Agents panel lists host > agent > its helpers (bgrun.js): a tab in the repo's space (a space of its own named
    // for the repo when that isn't open), never in the session's space, so closing that ends neither. Labelled herdr.investigation.host=<id>,
    // and a start fails without it (launchRun's hostRequired). Ended again when the start fails, with the space this start made for it.
    openHost: async (info) => {
      sessionId = info.id;
      const host = await openHost({ app, hc, run }, { id: info.id, name: info.name, repoRoot: info.repoRoot, spaces: spaces(), panes: panes(), label: INVESTIGATION_HOST_LABEL, note: HOST_NOTE });
      setShared(hostKey(info.id), { tab: host.tab, space: host.space, created: host.created });
      return host;
    },
    closeHost: async (host) => {
      await endHost({ id: sessionId, label: INVESTIGATION_HOST_LABEL, hc, terminals, run, spaces: spaces(), panes: panes(), record: shared(hostKey(sessionId)), also: [host?.address], closeSpace: true });
      setShared(hostKey(sessionId), null);
    },
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
