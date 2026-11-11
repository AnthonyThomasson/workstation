// Starts a workflow on a ticket: gets the ticket's worktree ready, writes what the agents read, starts the orchestrator in
// the background (owned by no tab or pane: bgrun.js, under a small host terminal in the repo's space so the Agents panel lists
// the run's agents) and opens the ticket's own space, rooted at the worktree and named
// for the ticket (the Spaces sidebar nests it under the repo's space), whose first tab shows the orchestrator on the left, with
// the run page (run-page.js), the list of its agents, on the right. Merge closes that space again. From there the
// orchestrator runs the ticket itself (run.js says how).
import { exec, focused, hc, home, knownAgents, notify, panes, readTextFile, run, setShared, shared, spaces, terminals, writeTextFile } from "herdr";
import { connectRun, endHost, findHost, guarded, hostKey, hostTabName, launchRun, openHost, reapplyRuns, runTabParts, slotKey, undoRunTab, viewConnect, viewQuick, viewTarget } from "./bgrun.js";
import { mainCheckout, prepareWorktree } from "./worktree.js";
import { app } from "./ui.js";
import { localTasks, repoHasGithubRemote, tasksConfig } from "./local-tasks-env.js";
import { blank, ROLES } from "./workflow-model.js";
import { out, agentArgv, branchName, FOLDER_LABEL, investigatorPrompt, mergeScript, orchestratorPrompt, reopenProps, reviewerPrompt, ROLE_LABEL, RUN_LABEL, runId, spawnScript, TICKET_LABEL, ticketFile, ticketKey, ticketName, workerPrompt, worktreePath } from "./run.js";

const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);

// The live run's orchestrator for a ticket, or null. Start becomes View while one is going. Runs on different
// tickets can go at once, even in one repo: each has its own worktree.
export const liveRunFor = (repo, ticket) => {
  const key = ticketKey(repo, ticket);
  return terminals().find((k) => k.state === "live" && k.labels?.[ROLE_LABEL] === "orchestrator" && k.labels?.[TICKET_LABEL] === key) ?? null;
};

// What is left of the run's tab, from the slot saved when it was connected (see runTabParts), or null.
export const runTabOf = (id, name, ticketSpace = null) => runTabParts({ slot: shared(slotKey(id)), spaces: spaces(), panes: panes(), name, ticketSpace });

// The tab that connects to a run's orchestrator (placeholder on the left, the orchestrator shown over it, the run page on
// the right). props: the run page's; space: the ticket's space to open it in, or null to make the ticket's space (named
// title, at folder, the ticket's worktree); folder: where the placeholder starts; existing: a tab that is already there and
// lacks a part (see connectRun); kind: "run", or "investigation" / "investigation-ended" (investigate.js reuses this). Resolves with the slot (created: true when this made the space). Throws with the reason.
export function connect({ id, orchestrator, title, space, folder, props, existing = null, kind = "run" }, cx) {
  return connectRun({
    app, run, paneOf: (made) => paneOf(made, cx), sleep: (ms) => cx.sleep(ms),
    // The focused pane is the left one by now: the app says what it shows (an address). Not yet focused counts as not shown.
    isShown: (orchestrator, left) => { const f = focused(); return f?.pane === left && f.shown === orchestrator; },
    warn: (body) => notify({ title: kind.startsWith("investigation") ? "The agent may not be showing" : "The Task Orchestrator may not be showing", body, level: "warning" }),
    setSlot: (runId, slot) => setShared(slotKey(runId), slot),
  }, { id, orchestrator, name: title, space, spaceName: title, folder, props, existing, kind });
}

// A run being started, or a tab being connected: one at a time per run, so View (or Start again) never makes a second tab.
export const connecting = new Set();

// Brings a run's tab to the front, showing its orchestrator again. When the tab was closed, opens a tab connected to the
// same orchestrator, in the ticket's space (or, if that was closed too, in a new one at the worktree); when it lost its left pane
// or its run page, makes that good in the tab that is there. The run itself isn't touched. The run page's props come from
// pane.json. A tab that can't be connected is said with the reason; this never fails silently and never throws.
// ticket and repo: what the run is for, to name the tab.
export async function viewRun(running, cx, { ticket, repo, project } = {}) {
  const { [RUN_LABEL]: id, [FOLDER_LABEL]: folder } = running.labels ?? {};
  const name = ticketName(ticket);
  try {
    if (!id) throw new Error("the run has no id, so its details can't be found");
    // pane.json (what Start saved: repoRoot, the main checkout, which a GitHub ticket doesn't carry) is read first: both paths find
    // the ticket's own space with it.
    const partial = {
      role: "run", id, orchestrator: running.address, title: name, workflow: "", branch: branchName(ticket), folder: folder ?? "",
      ticket: { number: ticket?.number ?? null, key: ticket?.key ?? null, status: ticket?.status ?? null }, projectId: project?.id ?? null,
      ...(ticket?.local ? { taskSource: "local", mainRoot: ticket.mainRoot, repoRoot: ticket.mainRoot } : {}),
    };
    const saved = await readTextFile(`${home()}/.herdr/workflow-runs/${id}/pane.json`).catch(() => null);
    const props = reopenProps(saved, partial, running.address);
    const workDir = folder ?? props.folder;
    const view = () => ({ slot: shared(slotKey(id)), spaces: spaces(), panes: panes(), name, folder: workDir, repoRoot: props.repoRoot ?? ticket?.mainRoot, orchestrators: [running.address, props.orchestrator], terminals: terminals() });
    if (viewQuick({
      ...view(), setSlot: (slot) => setShared(slotKey(id), slot), run,
      show: (left) => { app("terminal.show", { terminal: running.address, pane: left }).catch(() => {}); }, // if it had slipped off, put it back
    })) return;
    const did = await guarded(connecting, id, async () => {
      await viewConnect({
        ...view(), closeTab: (tab) => run("tab.close", { id: tab, confirmed: true }),
        connect: (existing, space) => connect({ id, orchestrator: running.address, title: name, space, folder: workDir, props, existing }, cx),
      });
      return true;
    });
    if (did === false) notify({ title: name, body: "This run's tab is still being opened. It will be in front in a moment.", level: "info" });
  } catch (e) {
    notify({ title: `Couldn't connect to ${name}`, body: `${e?.message ?? e}. The run itself is still going.`, level: "error" });
  }
}

// After a Herdr restart the terminals shown in tabs are not kept: show each live run's orchestrator again in the tab it
// has, so each run shows in exactly one tab. Waits for the app to list its spaces, panes and terminals. Safe to repeat.
export async function reconnectRuns(cx) {
  for (let i = 0; i < 40 && !(spaces().length && panes().length && terminals().length); i++) await cx.sleep(500);
  return reapplyRuns({ terminals: terminals(), slot: (id) => shared(slotKey(id)), spaces: spaces(), panes: panes(), show: (a) => app("terminal.show", a) });
}

// Each role's agent as a command. An agent that isn't on this computer stops the run before anything changes.
async function resolveAgents(workflow, runDir) {
  const known = await knownAgents().catch(() => []);
  const argv = {};
  for (const role of ROLES) {
    const settings = workflow[role] ?? blank()[role]; // a workflow from before investigators has none: the defaults
    if (settings.agent === "custom") {
      if (!settings.command) throw new Error(`The workflow's ${role} needs the command that opens its agent.`);
      argv[role] = agentArgv(role, settings, [], runDir);
      continue;
    }
    const entry = known.find((a) => a.key === settings.agent);
    if (entry && !entry.installed) throw new Error(`The workflow's ${role} runs ${entry.name}, which isn't installed on this computer.`);
    argv[role] = agentArgv(role, settings, entry?.run, runDir);
  }
  return argv;
}

// With a local task source, the task as its file holds it: { ticket, local: { task, githubRemote } }; the ticket is the one Start was
// given with the file's title, text, labels and status (the file is the truth, the sidebar's copy may be a few seconds old).
// Nothing for a repo on GitHub tasks, so GitHub mode goes through unchanged. Throws with a message when the task's file is gone.
async function localTaskFor(repoRoot, ticket) {
  const local = (await tasksConfig.read(repoRoot)) === "local";
  // The list the person clicked in was the other source (tasks.json changed since): don't start the wrong ticket.
  if (Boolean(ticket?.local) !== local) throw new Error("The task source changed; refresh the list and try again.");
  if (!local) return null;
  const task = ticket?.number ? await localTasks(repoRoot).get(ticket.number) : null;
  if (!task) throw new Error(`There is no local task #${ticket?.number ?? "?"} in ${repoRoot}'s tasks. Refresh the list and try again.`);
  return {
    task, githubRemote: await repoHasGithubRemote(repoRoot),
    ticket: { ...ticket, number: task.id, title: task.title, body: task.description, labels: task.labels, status: task.status, url: undefined },
  };
}

async function writeRunFolder(id, parts, argv) {
  const { runDir, workDir, branch } = parts;
  const made = await exec("mkdir", ["-p", runDir]);
  if (made.code !== 0) throw new Error(`Couldn't make ${runDir}: ${out(made)}`);
  await Promise.all([
    writeTextFile(`${runDir}/orchestrator.md`, orchestratorPrompt({ ...parts, id }), null),
    writeTextFile(`${runDir}/worker.md`, workerPrompt(parts), null),
    writeTextFile(`${runDir}/reviewer.md`, reviewerPrompt(parts), null),
    writeTextFile(`${runDir}/investigator.md`, investigatorPrompt(parts), null),
    writeTextFile(`${runDir}/ticket.md`, ticketFile(parts.ticket, parts.repo, parts.local), null),
    writeTextFile(`${runDir}/spawn`, spawnScript({ id, runDir, workDir, branch, argv }), null),
    writeTextFile(`${runDir}/merge`, mergeScript({ id, workDir, branch, number: parts.ticket?.number, runDir }), null),
  ]);
  const chmod = await exec("chmod", ["+x", `${runDir}/spawn`, `${runDir}/merge`]);
  if (chmod.code !== 0) throw new Error(`Couldn't make the spawn and merge scripts runnable: ${out(chmod)}`);
}

// The terminal's pane, which the new tab may not list for a moment.
async function paneOf(made, cx) {
  if (made.pane) return made.pane;
  for (let i = 0; i < 20; i++) {
    const found = panes().find((p) => p.tab === made.tab && p.terminal === made.terminal);
    if (found) return found.pane;
    await cx.sleep(100);
  }
  return null;
}

// Starts it. ticket: as GitHub holds it. Throws with a message for the person; nothing is left running then,
// though the ticket's worktree and branch, once made, stay for the next try. Returns { resumed } when the run was already going.
export async function startRun(workflow, ticket, repo, where, cx, board = {}) {
  if (where?.on) throw new Error(`This space is on ${where.on}. Workflows only run on this computer for now.`);
  if (!where?.cwd) throw new Error("This space has no folder to work in.");

  const key = ticketKey(repo, ticket);
  const running = liveRunFor(repo, ticket);
  if (running) {
    await viewRun(running, cx, { ticket, repo, project: board.project });
    return { resumed: true };
  }

  const repoRoot = await mainCheckout(git, where.cwd); // the main checkout, even when Start is used from one of its worktrees
  const found = await localTaskFor(repoRoot, ticket); // a local task: its file describes the run; the project and its status field are not used
  if (found) { ticket = found.ticket; board = {}; repo = repo || repoRoot.split("/").filter(Boolean).pop(); }

  const id = runId(ticket);
  const runDir = `${home()}/.herdr/workflow-runs/${id}`;
  const argv = await resolveAgents(workflow, runDir); // before the worktree: this fails without changing anything
  const branch = branchName(ticket);
  const workDir = await prepareWorktree(git, repoRoot, branch, worktreePath(repoRoot, branch, home()));
  await writeRunFolder(id, { workflow, ticket, repo, runDir, workDir, repoRoot, branch, local: Boolean(found), noRemote: Boolean(found) && !found.githubRemote }, argv);

  const name = ticketName(ticket);
  const props = {
    role: "run", id, orchestrator: null, title: name, workflow: workflow.name, branch, folder: workDir,
    repoRoot, ticket: { number: ticket.number ?? null, key: ticket.key ?? null, status: ticket.status ?? null }, // status: what it is now, so a launch never moves it back
    projectId: board.project?.id ?? null, statusField: board.statusField ?? null,
    // What a new orchestrator needs if this one ends and the person presses the red Merge button (bgrun.js restartOrchestrator).
    orchestratorArgv: argv.orchestrator, ticketLabel: key,
    // A local task: the page moves the task's file, and Merge depends on whether origin is on GitHub (no remote: a local squash).
    ...(found ? { taskSource: "local", mainRoot: repoRoot, githubRemote: found.githubRemote } : {}),
  };
  // The orchestrator runs in the background, owned by no tab or pane, so closing the tab never ends it. It is guarded as
  // a whole: from the moment it exists View and Start see it, and the tab is opened here, not by them (bgrun.js launchRun).
  // The run goes in the ticket's space: the one an earlier run of this ticket left (a failed or ended run), else a new one at
  // the worktree, which is taken down again if the start fails (closeTab).
  const space = viewTarget({ spaces: spaces(), panes: panes(), folder: workDir, repoRoot });
  let created = null; // the space this Start made
  const launched = await guarded(connecting, id, () => launchRun({
    hc, writePaneJson: (p) => writeTextFile(`${runDir}/pane.json`, JSON.stringify(p), null),
    connect: async (p) => { const slot = await connect({ id, orchestrator: p.orchestrator, title: p.title, space, folder: workDir, props: p }, cx); created = slot.created ? slot.space : null; return slot; },
    closeTab: () => { undoRunTab({ created, part: runTabOf(id), run: (n, a) => run(n, a) }); created = null; setShared(slotKey(id), null); },
    // The run's host (bgrun.js): the orchestrator's parent, so the Agents panel lists the run's agents. Ended again when the start fails.
    openHost: async () => {
      const host = await openHost({ app, hc, run }, { id, name: hostTabName(ticket), repoRoot, spaces: spaces(), panes: panes() });
      setShared(hostKey(id), { tab: host.tab, space: host.space, created: host.created });
      return host;
    },
    closeHost: async (host) => {
      await endHost({ id, hc, terminals, run, spaces: spaces(), panes: panes(), record: shared(hostKey(id)), also: [host?.address] });
      setShared(hostKey(id), null);
    },
  }, { id, key, workDir, argv: argv.orchestrator, task: `Read ${runDir}/orchestrator.md and follow it.`, props }));
  if (launched.problems.length) notify({ title: "The workflow started, with a problem", body: launched.problems.join(" "), level: "warning" });
  return { resumed: false };
}
