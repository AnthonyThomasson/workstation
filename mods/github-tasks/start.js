// Starts a workflow on a ticket: gets the ticket's worktree ready, writes what the agents read, starts the orchestrator in
// the background (owned by no tab or pane: bgrun.js) and opens a tab that shows it on the left, with the run page
// (run-page.js), the list of its agents, on the right. From there the orchestrator runs the ticket itself (run.js says how).
import { exec, focused, hc, home, knownAgents, notify, panes, readTextFile, run, setShared, shared, spaces, terminals, writeTextFile } from "herdr";
import { connectRun, findRunTab, orchestratorRunArgs, parseStarted, reapplyRuns, slotKey, viewTarget } from "./bgrun.js";
import { mainCheckout, prepareWorktree } from "./worktree.js";
import { app } from "./ui.js";
import { localTasks, repoHasGithubRemote, tasksConfig } from "./local-tasks-env.js";
import { ROLES } from "./workflow-model.js";
import { out, agentArgv, branchName, FOLDER_LABEL, mergeScript, orchestratorPrompt, reopenProps, reviewerPrompt, ROLE_LABEL, RUN_LABEL, runId, spawnScript, SPACE_LABEL, TICKET_LABEL, ticketFile, ticketKey, ticketName, workerPrompt, worktreePath } from "./run.js";

const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);

// The live run's orchestrator for a ticket, or null. Start becomes View while one is going. Runs on different
// tickets can go at once, even in one repo: each has its own worktree.
export const liveRunFor = (repo, ticket) => {
  const key = ticketKey(repo, ticket);
  return terminals().find((k) => k.state === "live" && k.labels?.[ROLE_LABEL] === "orchestrator" && k.labels?.[TICKET_LABEL] === key) ?? null;
};

// The run's open tab, from the slot saved when it was connected, or null.
export const runTabOf = (id) => findRunTab({ slot: shared(slotKey(id)), spaces: spaces(), panes: panes() });

// The tab that connects to a run's orchestrator (placeholder on the left, the orchestrator shown over it, the run page on
// the right). props: the run page's; space: where to open it; folder: where the placeholder starts. Throws with the reason.
function connect({ id, orchestrator, title, space, folder, props }, cx) {
  return connectRun({
    app, run, paneOf: (made) => paneOf(made, cx), sleep: (ms) => cx.sleep(ms),
    // The focused pane is the left one by now: the app says what it shows. Unknown (focus not landed yet) counts as not shown.
    isShown: (orchestrator, left) => { const f = focused(); return f?.pane === left && String(f.shown?.terminal ?? f.shown ?? "") === orchestrator; },
    setSlot: (runId, slot) => setShared(slotKey(runId), slot),
  }, { id, orchestrator, name: title, space, folder, props });
}

// Brings a run's tab to the front. When it was closed, opens a tab connected to the same orchestrator, in the space the
// run started in (or the current one if that was closed): the run itself isn't touched. The run page's props come from
// pane.json. A tab that can't be connected is said with the reason; this never fails silently and never throws.
// ticket and repo: what the run is for, to name the tab.
const connecting = new Set();
export async function viewRun(running, cx, { ticket, repo, project } = {}) {
  const { [RUN_LABEL]: id, [FOLDER_LABEL]: folder, [SPACE_LABEL]: started } = running.labels ?? {};
  const name = ticketName(ticket);
  try {
    if (!id) throw new Error("the run has no id, so its details can't be found");
    const open = runTabOf(id);
    if (open) { run("space.select", { id: open.space }); run("tab.select", { id: open.tab }); return; }
    if (connecting.has(id)) return; // a second press while the first is still connecting
    connecting.add(id);
    try {
      const partial = {
        role: "run", id, orchestrator: running.address, title: name, workflow: "", branch: branchName(ticket), folder: folder ?? "",
        ticket: { number: ticket?.number ?? null, key: ticket?.key ?? null }, projectId: project?.id ?? null,
        ...(ticket?.local ? { taskSource: "local", mainRoot: ticket.mainRoot, repoRoot: ticket.mainRoot } : {}), // the saved pane.json has the rest
      };
      // Start saved the full props (repoRoot, statusField, workflow name) beside the run's other files.
      const saved = await readTextFile(`${home()}/.herdr/workflow-runs/${id}/pane.json`).catch(() => null);
      const props = reopenProps(saved, partial, running.address);
      const space = viewTarget({ started: started ?? props.space, spaces: spaces(), current: spaces().find((s) => s.active)?.id });
      const slot = await connect({ id, orchestrator: running.address, title: name, space, folder: folder ?? props.folder, props: { ...props, space: space ?? props.space } }, cx);
      run("space.select", { id: slot.space ?? space });
      run("tab.select", { id: slot.tab });
    } finally { connecting.delete(id); }
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
    const settings = workflow[role];
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
    writeTextFile(`${runDir}/ticket.md`, ticketFile(parts.ticket, parts.repo, parts.local), null),
    writeTextFile(`${runDir}/spawn`, spawnScript({ id, runDir, workDir, branch, argv }), null),
    writeTextFile(`${runDir}/merge`, mergeScript({ id, workDir, branch, number: parts.ticket?.number }), null),
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
  const workDir = await prepareWorktree(git, repoRoot, branch, worktreePath(repoRoot, branch));
  await writeRunFolder(id, { workflow, ticket, repo, runDir, workDir, repoRoot, branch, local: Boolean(found), noRemote: Boolean(found) && !found.githubRemote }, argv);

  const space = spaces().find((s) => s.active)?.id;
  const props = {
    role: "run", id, orchestrator: null, title: ticketName(ticket), workflow: workflow.name, branch, folder: workDir,
    repoRoot, ticket: { number: ticket.number ?? null, key: ticket.key ?? null },
    projectId: board.project?.id ?? null, statusField: board.statusField ?? null, space: space ?? null,
    // A local task: the page moves the task's file, and Create PR and Merge depend on whether origin is on GitHub.
    ...(found ? { taskSource: "local", mainRoot: repoRoot, githubRemote: found.githubRemote } : {}),
  };
  // The orchestrator runs in the background, owned by no tab or pane, so closing the tab never ends it.
  const started = await hc(orchestratorRunArgs({ id, key, workDir, space, argv: argv.orchestrator })).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  const orchestrator = started.code === 0 ? parseStarted(started.stdout) : null;
  if (!orchestrator) throw new Error(`The orchestrator didn't start: ${out(started) || "hc gave no address"}`);
  props.orchestrator = orchestrator;

  // Its first task, as tab.new gave it: once the agent is ready, as spawn does for the workers. Without it the run is
  // nothing, so it is ended again.
  await hc(["wait", orchestrator, "--timeout", "60"]).catch(() => null);
  const sent = await hc(["send", orchestrator, `Read ${runDir}/orchestrator.md and follow it.`]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  if (sent.code !== 0) {
    await hc(["kill", orchestrator]).catch(() => null);
    throw new Error(`The orchestrator didn't take its task, so it was ended: ${out(sent)}`);
  }

  // The orchestrator is running from here on, so what fails now is said without stopping it: View connects it later.
  const problems = [];
  await writeTextFile(`${runDir}/pane.json`, JSON.stringify(props), null).catch(() => {}); // View reconnects from this
  try {
    await connect({ id, orchestrator, title: props.title, space, folder: workDir, props }, cx);
  } catch (e) {
    problems.push(`Its tab didn't open: ${e?.message ?? e}. It is running; View connects to it.`);
  }
  if (problems.length) notify({ title: "The workflow started, with a problem", body: problems.join(" "), level: "warning" });
  return { resumed: false };
}
