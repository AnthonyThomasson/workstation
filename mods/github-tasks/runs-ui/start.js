// Starts a workflow on a ticket: gets the ticket's worktree ready, writes what the agents read, starts the orchestrator in
// the background (no parent and no pane: bgrun.js says why) and opens the ticket's own space, rooted at the worktree and named
// for the ticket (the Spaces sidebar nests it under the repo's space), whose first tab shows the orchestrator on the left, with
// the run page (run-page.js), the list of its agents, on the right. Merge closes that space again. From there the
// orchestrator runs the ticket itself (run.js says how).
import { exec, focused, hc, home, knownAgents, notify, panes, readTextFile, run, setShared, shared, spaces, terminals, writeTextFile } from "herdr";
import { connectRun, freshTicket, guarded, launchRun, reapplyRuns, runTabParts, undoRunTab, viewConnect, viewQuick, viewTarget, mainCheckout, prepareWorktree, out, agentArgv, branchName, investigatorPrompt, mergeScript, orchestratorPrompt, reopenProps, reviewerPrompt, runId, spawnScript, ticketFile, ticketKey, ticketName, soloPrompt, workerPrompt, hostArgv, hostOf, remoteProgram, shOn } from "../runs/index.js";
import { loadTask } from "../github/index.js";
import { app, gh, hereOs, localTool } from "../widgets/index.js";
import { blank, ROLES, isEasy, worktreePath, runDir as runDirFor, runPanePath } from "../workflow/index.js";
import { slotKey, FOLDER_LABEL, ROLE_LABEL, RUN_LABEL, TICKET_LABEL } from "../lib/index.js";

// git here, or on a space's machine (`on`): plain git, which Windows runs too, with the forward-slash paths git gives.
const gitOn = (on) => (cwd, ...args) => exec("git", ["-C", cwd, ...args], ...(on ? [{ on }] : []));

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
    app, run, paneOf: (made) => paneOf(made, cx), sleep: (ms) => cx.sleep(ms), localOs: hereOs(),
    // The focused pane is the left one by now: the app says what it shows (an address). Not yet focused counts as not shown.
    isShown: (orchestrator, left) => { const f = focused(); return f?.pane === left && f.shown === orchestrator; },
    warn: (body) => notify({ title: kind.startsWith("investigation") ? "The agent may not be showing" : "The Task Orchestrator may not be showing", body, level: "warning" }),
    setSlot: (runId, slot) => setShared(slotKey(runId), slot),
  }, { id, orchestrator, name: title, space, spaceName: title, folder, props, existing, kind });
}

// A run being started, or a tab being connected: one at a time per run, so View (or Start again) never makes a second tab.
export const connecting = new Set();

// The run page's props for a run, from its orchestrator's terminal (running): the full set Start saved in pane.json, with that terminal
// as the orchestrator; without a usable pane.json, what the terminal's labels and the ticket say. View opens the page with them, and
// herdr-tasks (cli-ui/) reads a run through a page made with them.
export async function runProps(running, { ticket, project } = {}) {
  const { [RUN_LABEL]: id, [FOLDER_LABEL]: folder } = running.labels ?? {};
  const partial = {
    role: "run", id, orchestrator: running.address, title: ticketName(ticket), workflow: "", branch: branchName(ticket), folder: folder ?? "",
    ticket: { number: ticket?.number ?? null, key: ticket?.key ?? null, status: ticket?.status ?? null }, projectId: project?.id ?? null,
  };
  const saved = await readTextFile(runPanePath(home(), id)).catch(() => null);
  return reopenProps(saved, partial, running.address);
}

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
    // pane.json (what Start saved: repoRoot, the main checkout, which the ticket doesn't carry) is read first: both paths find
    // the ticket's own space with it.
    const props = await runProps(running, { ticket, project });
    const workDir = folder ?? props.folder;
    const view = () => ({ slot: shared(slotKey(id)), spaces: spaces(), panes: panes(), name, folder: workDir, repoRoot: props.repoRoot, orchestrators: [running.address, props.orchestrator], terminals: terminals() });
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

// The roles whose agents spawn starts (on the run's machine); the orchestrator and an easy ticket's one agent start here.
const SPAWNED = ["worker", "reviewer", "investigator"];

// Each role's agent as a command. An agent that isn't on this computer stops the run before anything changes.
// runDir: the run folder the agent may read (--add-dir). host: the run's machine, or null: then the spawned roles run the
// machine's own program (remoteProgram: on its PATH, else ~/.local/bin, .exe on Windows) with runDir there, and a custom
// command goes through Git Bash on Windows; localDir is this computer's run folder, for the orchestrator.
async function resolveAgents(workflow, runDir, host = null, localDir = runDir) {
  const known = await knownAgents().catch(() => []);
  const argv = {};
  const programs = new Map(); // agent -> its program on the host, asked once
  for (const role of [...ROLES, "solo"]) {
    const settings = workflow[role === "solo" ? "worker" : role] ?? blank()[role === "solo" ? "worker" : role]; // an easy ticket's one agent runs on the worker's settings // a workflow from before investigators has none: the defaults
    if (host && SPAWNED.includes(role)) {
      if (settings.agent === "custom") {
        if (!settings.command) throw new Error(`The workflow's ${role} needs the command that opens its agent.`);
        argv[role] = hostArgv(agentArgv(role, settings, [], runDir), host);
        continue;
      }
      if (!programs.has(settings.agent)) programs.set(settings.agent, await remoteProgram(exec, host, settings.agent));
      const program = programs.get(settings.agent);
      if (!program) throw new Error(`The workflow's ${role} runs ${settings.agent}, which isn't on ${host.on} (not on its PATH, nor in ${host.home}/.local/bin).`);
      argv[role] = hostArgv(agentArgv(role, settings, [program], runDir), host, program);
      continue;
    }
    const dir = host ? localDir : runDir; // the orchestrator (and solo) always run here, beside the spawn and merge scripts
    if (settings.agent === "custom") {
      if (!settings.command) throw new Error(`The workflow's ${role} needs the command that opens its agent.`);
      argv[role] = hostArgv(agentArgv(role, settings, [], dir), { os: hereOs() }); // here: Git Bash on Windows, sh -c elsewhere
      continue;
    }
    const entry = known.find((a) => a.key === settings.agent);
    if (entry && !entry.installed) throw new Error(`The workflow's ${role} runs ${entry.name}, which isn't installed on this computer.`);
    argv[role] = agentArgv(role, settings, entry?.run, dir);
  }
  return argv;
}

// A run on another machine has two run folders. On the machine (parts.runDir): what its agents read (the role prompts and the
// ticket). Here (localDir): what the Task Orchestrator reads and runs, which stays on this computer (orchestrator.md, ticket.md,
// spawn and merge, and later pane.json). The scripts are not copied to the machine: they only run here, and a copy there could
// be mistaken for one that works. hc file write makes missing folders, but a folder is made first anyway, as for a local run.
async function writeRemoteRunFolder(id, parts, argv, host, localDir) {
  const { runDir, workDir, branch } = parts;
  const remote = await shOn({ exec, localOs: hereOs() }, host.on, 'mkdir -p "$1"', [runDir]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  if (remote.code !== 0) throw new Error(`Couldn't make ${runDir} on ${host.on}: ${out(remote)}`);
  const local = await localTool("mkdir", ["-p", localDir]);
  if (local.code !== 0) throw new Error(`Couldn't make ${localDir}: ${out(local)}`);
  const there = (name, text) => writeTextFile(`${runDir}/${name}`, text, null, { on: host.on });
  const here = (name, text) => writeTextFile(`${localDir}/${name}`, text, null);
  const ticket = ticketFile(parts.ticket, parts.repo);
  const orchestrator = orchestratorPrompt({ ...parts, id, on: host.on, scriptsDir: localDir });
  await Promise.all([
    there("worker.md", workerPrompt(parts)),
    there("reviewer.md", reviewerPrompt(parts)),
    there("investigator.md", investigatorPrompt(parts)),
    there("ticket.md", ticket),
    there("orchestrator.md", orchestrator), // for whoever looks there; the Task Orchestrator reads its copy here
    here("orchestrator.md", orchestrator),
    here("ticket.md", ticket),
    here("spawn", spawnScript({ id, runDir, workDir, branch, argv, host })),
    here("merge", mergeScript({ id, workDir, branch, number: parts.ticket?.number, runDir: localDir, host })),
  ]);
  const chmod = await localTool("chmod", ["+x", `${localDir}/spawn`, `${localDir}/merge`]);
  if (chmod.code !== 0) throw new Error(`Couldn't make the spawn and merge scripts runnable: ${out(chmod)}`);
}

async function writeRunFolder(id, parts, argv) {
  const { runDir, workDir, branch, solo } = parts;
  const made = await localTool("mkdir", ["-p", runDir]);
  if (made.code !== 0) throw new Error(`Couldn't make ${runDir}: ${out(made)}`);
  await Promise.all([
    writeTextFile(`${runDir}/orchestrator.md`, solo ? soloPrompt(parts) : orchestratorPrompt({ ...parts, id }), null),
    writeTextFile(`${runDir}/worker.md`, workerPrompt(parts), null),
    writeTextFile(`${runDir}/reviewer.md`, reviewerPrompt(parts), null),
    writeTextFile(`${runDir}/investigator.md`, investigatorPrompt(parts), null),
    writeTextFile(`${runDir}/ticket.md`, ticketFile(parts.ticket, parts.repo), null),
    writeTextFile(`${runDir}/spawn`, spawnScript({ id, runDir, workDir, branch, argv }), null),
    writeTextFile(`${runDir}/merge`, mergeScript({ id, workDir, branch, number: parts.ticket?.number, runDir }), null),
  ]);
  const chmod = await localTool("chmod", ["+x", `${runDir}/spawn`, `${runDir}/merge`]);
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
// A space on another machine (where.on) runs there: the ticket's worktrees, the run folder its agents read and the agents
// themselves are on that machine (asked what it runs first: probeMachine), while the Task Orchestrator, its spawn and merge
// scripts and pane.json stay on this computer. The orchestrator starts in this computer's run folder, which also roots the
// ticket's space here, since the worktree's path means nothing on this computer.
export async function startRun(workflow, ticket, repo, where, cx, board = {}) {
  if (!where?.cwd) throw new Error("This space has no folder to work in.");

  const key = ticketKey(repo, ticket);
  const running = liveRunFor(repo, ticket);
  if (running) {
    await viewRun(running, cx, { ticket, repo, project: board.project });
    return { resumed: true };
  }

  // The board query has no body. Read the whole ticket before anything is prepared or written; a failure keeps its reason.
  ticket = await freshTicket(ticket, (listed) => loadTask(gh, repo, listed, where));

  const host = where.on ? await hostOf({ exec }, where.on) : null; // { on, os, home }: before anything changes
  const git = gitOn(host?.on);
  const repoRoot = await mainCheckout(git, where.cwd); // the main checkout, even when Start is used from one of its worktrees

  // the easy label: the worker does the whole ticket alone, in the orchestrator's place. Not on another machine: that agent
  // writes the code, and it would start here, away from the worktree, so such a run gets an orchestrator and a worker there.
  const solo = isEasy(ticket) && !host;
  const id = runId(ticket);
  const localDir = runDirFor(home(), id);
  const runDir = host ? runDirFor(host.home, id) : localDir; // what the agents read, where they run
  const argv = await resolveAgents(workflow, runDir, host, localDir); // before the worktree: this fails without changing anything
  const branch = branchName(ticket);
  const workDir = await prepareWorktree(git, repoRoot, branch, worktreePath(repoRoot, branch, host?.home ?? home()));
  const parts = { solo, workflow, ticket, repo, runDir, workDir, repoRoot, branch };
  if (host) await writeRemoteRunFolder(id, parts, argv, host, localDir);
  else await writeRunFolder(id, parts, argv);
  const folder = host ? localDir : workDir; // where the orchestrator starts and the ticket's space is rooted, on this computer

  const name = ticketName(ticket);
  const props = {
    role: "run", id, orchestrator: null, title: name, workflow: workflow.name, branch, folder,
    // A run on another machine: the machine, what it runs, the ticket worktree and the agents' run folder there. The run page's Merge
    // runs its git and gh there and removes both run folders (run-page.js); View finds the ticket's space here by `folder`.
    ...(host ? { on: host.on, os: host.os, worktree: workDir, remoteRunDir: runDir } : {}),
    repoRoot, ticket: { number: ticket.number ?? null, key: ticket.key ?? null, status: ticket.status ?? null }, // status: what it is now, so a launch never moves it back
    projectId: board.project?.id ?? null, statusField: board.statusField ?? null,
    // What a new orchestrator needs if this one ends and the person presses the red Merge button (bgrun.js restartOrchestrator).
    orchestratorArgv: solo ? argv.solo : argv.orchestrator, ticketLabel: key, solo,
  };
  // The orchestrator runs in the background, owned by no tab or pane, so closing the tab never ends it. It is guarded as
  // a whole: from the moment it exists View and Start see it, and the tab is opened here, not by them (bgrun.js launchRun).
  // The run goes in the ticket's space: the one an earlier run of this ticket left (a failed or ended run), else a new one at
  // the worktree, which is taken down again if the start fails (closeTab).
  const space = viewTarget({ spaces: spaces(), panes: panes(), folder, repoRoot });
  let created = null; // the space this Start made
  const launched = await guarded(connecting, id, () => launchRun({
    hc, writePaneJson: (p) => writeTextFile(runPanePath(home(), id), JSON.stringify(p), null),
    connect: async (p) => { const slot = await connect({ id, orchestrator: p.orchestrator, title: p.title, space, folder, props: p }, cx); created = slot.created ? slot.space : null; return slot; },
    closeTab: () => { undoRunTab({ created, part: runTabOf(id), run: (n, a) => run(n, a) }); created = null; setShared(slotKey(id), null); },
    // workDir here is the orchestrator's --cwd and folder label (bgrun.js orchestratorRunArgs): this computer's run folder for a run elsewhere
  }, { id, key, workDir: folder, argv: solo ? argv.solo : argv.orchestrator, task: `Read ${localDir}/orchestrator.md and follow it.`, props }));
  if (launched.problems.length) notify({ title: "The workflow started, with a problem", body: launched.problems.join(" "), level: "warning" });
  return { resumed: false };
}
