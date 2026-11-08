// Starts a workflow on a ticket: gets the ticket's worktree ready, writes what the agents read, and opens a tab with the
// orchestrator's terminal on the left and the run page (run-page.js), the list of its agents, on the right. From there the
// orchestrator runs the ticket itself (run.js says how).
import { exec, hc, home, knownAgents, notify, panes, readTextFile, run, spaces, terminals, writeTextFile } from "herdr";
import { mainCheckout, prepareWorktree } from "./worktree.js";
import { app } from "./ui.js";
import { viewRunWith } from "./view-run.js";
import { ROLES } from "./workflow-model.js";
import { out, agentArgv, branchName, FOLDER_LABEL, mergeScript, orchestratorPrompt, reviewerPrompt, ROLE_LABEL, RUN_LABEL, runId, spawnScript, TICKET_LABEL, ticketFile, ticketKey, ticketName, workerPrompt, worktreePath } from "./run.js";

const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);

// The live run's orchestrator for a ticket, or null. Start becomes View while one is going. Runs on different
// tickets can go at once, even in one repo: each has its own worktree.
export const liveRunFor = (repo, ticket) => {
  const key = ticketKey(repo, ticket);
  return terminals().find((k) => k.state === "live" && k.labels?.[ROLE_LABEL] === "orchestrator" && k.labels?.[TICKET_LABEL] === key) ?? null;
};

// Brings a run's tab to the front (view-run.js says how); this wires it to Herdr.
export const viewRun = (running, cx, args) => viewRunWith(running, cx, args, { run, panes, app, readTextFile, home, notify });

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

async function writeRunFolder(id, parts, argv) {
  const { runDir, workDir, branch } = parts;
  const made = await exec("mkdir", ["-p", runDir]);
  if (made.code !== 0) throw new Error(`Couldn't make ${runDir}: ${out(made)}`);
  await Promise.all([
    writeTextFile(`${runDir}/orchestrator.md`, orchestratorPrompt({ ...parts, id }), null),
    writeTextFile(`${runDir}/worker.md`, workerPrompt(parts), null),
    writeTextFile(`${runDir}/reviewer.md`, reviewerPrompt(parts), null),
    writeTextFile(`${runDir}/ticket.md`, ticketFile(parts.ticket, parts.repo), null),
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

  const id = runId(ticket);
  const runDir = `${home()}/.herdr/workflow-runs/${id}`;
  const argv = await resolveAgents(workflow, runDir); // before the worktree: this fails without changing anything
  const branch = branchName(ticket);
  const workDir = await prepareWorktree(git, repoRoot, branch, worktreePath(repoRoot, branch));
  await writeRunFolder(id, { workflow, ticket, repo, runDir, workDir, repoRoot, branch }, argv);

  const space = spaces().find((s) => s.active)?.id;
  const made = await app("tab.new", {
    name: ticketName(ticket), folder: workDir, argv: argv.orchestrator,
    task: `Read ${runDir}/orchestrator.md and follow it.`,
    ...(space ? { space } : {}),
  });

  // The orchestrator is running from here on, so what fails now is said without stopping it.
  const problems = [];
  const labels = await hc(["label", made.terminal, `${RUN_LABEL}=${id}`, `${ROLE_LABEL}=orchestrator`, `${TICKET_LABEL}=${key}`, `${FOLDER_LABEL}=${workDir}`]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
  if (labels.code !== 0) problems.push(`Start won't find this run again (${out(labels)}).`);
  const pane = await paneOf(made, cx);
  try {
    if (!pane) throw new Error("its pane didn't appear");
    const props = {
      role: "run", id, orchestrator: made.terminal, title: ticketName(ticket), workflow: workflow.name, branch, folder: workDir,
      repoRoot, ticket: { number: ticket.number ?? null, key: ticket.key ?? null },
      projectId: board.project?.id ?? null, statusField: board.statusField ?? null,
    };
    await writeTextFile(`${runDir}/pane.json`, JSON.stringify(props), null).catch(() => {}); // View reopens the pane from this
    await app("pane.split", { pane, direction: "right", mod: "github-tasks", props });
    run("pane.focus", { pane }); // the person answers the orchestrator there
  } catch (e) {
    problems.push(`The list of its agents didn't open (${e?.message ?? e}).`);
  }
  if (problems.length) notify({ title: "The workflow started, with a problem", body: problems.join(" "), level: "warning" });
  return { resumed: false };
}
