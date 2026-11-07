// Starts a workflow on a ticket: gets the folder ready, writes what the agents read, and opens a tab with the
// orchestrator's terminal on the left and the Workflows mod's list of its agents on the right. From there the
// orchestrator runs the ticket itself (run.js says how).
import { exec, hc, home, knownAgents, notify, panes, run, spaces, terminals, writeTextFile } from "herdr";
import { agentArgv, branchName, FOLDER_LABEL, orchestratorPrompt, reviewerPrompt, ROLE_LABEL, RUN_LABEL, runId, spawnScript, TICKET_LABEL, ticketFile, ticketKey, ticketName, workerPrompt, worktreePath } from "./run.js";

const ROLES = ["orchestrator", "worker", "reviewer"];
const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);
const out = (r) => (r.stderr || r.stdout).trim();

// A live orchestrator with this label value.
const liveOrchestrator = (label, value) => terminals().find((k) => k.state === "live" && k.labels?.[ROLE_LABEL] === "orchestrator" && k.labels?.[label] === value) ?? null;

// The live run's orchestrator for a ticket, or null. Start becomes View while one is going.
export const liveRunFor = (repo, ticket) => liveOrchestrator(TICKET_LABEL, ticketKey(repo, ticket));

// Brings a run's tab to the front with the run's own pane (the Workflows mod's list of its agents) beside the
// orchestrator. The pane is opened again when it's gone: closed, or never made because that part of Start failed.
// ticket and repo: what the run is for, to name the pane. Doesn't throw; a pane that can't open leaves the tab as it is.
export async function viewRun(running, cx, { ticket, repo, project } = {}) {
  const { "herdr.space": space, "herdr.tab": tab, [RUN_LABEL]: id, [FOLDER_LABEL]: folder } = running.labels;
  if (space) run("space.select", { id: space });
  if (tab) run("tab.select", { id: tab });
  if (!tab || !id || panes().some((p) => p.tab === tab && p.mod === "workflows")) return;
  try {
    const pane = panes().find((p) => p.terminal === running.address)?.pane;
    if (!pane) return;
    await app("pane.split", {
      pane, direction: "right", mod: "workflows",
      props: {
        role: "run", id, orchestrator: running.address, title: ticketName(ticket), workflow: "", branch: branchName(ticket), folder: folder ?? "",
        ticket: { number: ticket?.number ?? null, key: ticket?.key ?? null }, projectId: project?.id ?? null,
      },
    });
    run("pane.focus", { pane });
  } catch { /* the tab is showing; only the list of agents is missing */ }
}

// One app command, waited for, with what it made ({ tab, terminal, pane, ... }).
async function app(name, args) {
  const r = await exec("herdr-app", ["do", name, ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, typeof v === "string" ? v : JSON.stringify(v)])]);
  let made = {};
  try { made = JSON.parse(r.stdout || "{}"); } catch { /* it said nothing we can read */ }
  if (r.code !== 0 || made.error) throw new Error(made.error || r.stderr.trim() || `${name} failed`);
  return made;
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

const onBranch = async (dir) => (await git(dir, "branch", "--show-current")).stdout.trim();
const branchExists = async (dir, branch) => (await git(dir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)).code === 0;

// Work on the branch in the repo's own folder. Coming back to a branch resumes it. Otherwise uncommitted changes
// stop it here, because they would go along into the ticket's commits.
async function prepareBranch(repoRoot, branch) {
  if ((await onBranch(repoRoot)) === branch) return repoRoot;
  const status = await git(repoRoot, "status", "--porcelain");
  if (status.code !== 0) throw new Error(`git couldn't read ${repoRoot}: ${out(status)}`);
  const changed = status.stdout.split("\n").filter(Boolean);
  if (changed.length) throw new Error(`${repoRoot} has ${changed.length} uncommitted change${changed.length > 1 ? "s" : ""}. Commit or stash ${changed.length > 1 ? "them" : "it"} first, or use a workflow with the Worktree strategy.`);
  const r = (await branchExists(repoRoot, branch)) ? await git(repoRoot, "switch", branch) : await git(repoRoot, "switch", "-c", branch);
  if (r.code !== 0) throw new Error(`Couldn't switch to ${branch}: ${out(r)}`);
  return repoRoot;
}

// Work in a git worktree of its own, beside the repo. One that already has the branch is used again.
async function prepareWorktree(repoRoot, branch) {
  const list = await git(repoRoot, "worktree", "list", "--porcelain");
  if (list.code !== 0) throw new Error(`git couldn't list worktrees: ${out(list)}`);
  let path = null;
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    else if (line === `branch refs/heads/${branch}` && path) return path;
  }
  const target = worktreePath(repoRoot, branch);
  const r = (await branchExists(repoRoot, branch))
    ? await git(repoRoot, "worktree", "add", target, branch)
    : await git(repoRoot, "worktree", "add", "-b", branch, target);
  if (r.code !== 0) throw new Error(`Couldn't make a worktree at ${target}: ${out(r)}`);
  return target;
}

async function writeRunFolder(id, parts, argv) {
  const { runDir, workDir } = parts;
  const made = await exec("mkdir", ["-p", runDir]);
  if (made.code !== 0) throw new Error(`Couldn't make ${runDir}: ${out(made)}`);
  await Promise.all([
    writeTextFile(`${runDir}/orchestrator.md`, orchestratorPrompt(parts), null),
    writeTextFile(`${runDir}/worker.md`, workerPrompt(parts), null),
    writeTextFile(`${runDir}/reviewer.md`, reviewerPrompt(parts), null),
    writeTextFile(`${runDir}/ticket.md`, ticketFile(parts.ticket, parts.repo), null),
    writeTextFile(`${runDir}/spawn`, spawnScript({ id, runDir, workDir, argv }), null),
  ]);
  const chmod = await exec("chmod", ["+x", `${runDir}/spawn`]);
  if (chmod.code !== 0) throw new Error(`Couldn't make the spawn script runnable: ${out(chmod)}`);
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
// though a branch or worktree already made stays for the next try. Returns { resumed } when the run was already going.
export async function startRun(workflow, ticket, repo, where, cx, board = {}) {
  if (where?.on) throw new Error(`This space is on ${where.on}. Workflows only run on this computer for now.`);
  if (!where?.cwd) throw new Error("This space has no folder to work in.");

  const key = ticketKey(repo, ticket);
  const running = liveOrchestrator(TICKET_LABEL, key);
  if (running) {
    await viewRun(running, cx, { ticket, repo, project: board.project });
    return { resumed: true };
  }

  const top = await git(where.cwd, "rev-parse", "--show-toplevel");
  if (top.code !== 0) throw new Error(`${where.cwd} isn't in a git repo: ${out(top)}`);
  const repoRoot = top.stdout.trim();

  // Two runs on a branch in one folder would pull it out from under each other.
  if (workflow.strategy !== "worktree" && liveOrchestrator(FOLDER_LABEL, repoRoot)) {
    throw new Error(`Another run is already working in ${repoRoot}. Wait for it, or use a workflow with the Worktree strategy.`);
  }

  const id = runId(ticket);
  const runDir = `${home()}/.herdr/workflow-runs/${id}`;
  const argv = await resolveAgents(workflow, runDir); // before the branch: this fails without changing anything
  const branch = branchName(ticket);
  const workDir = workflow.strategy === "worktree" ? await prepareWorktree(repoRoot, branch) : await prepareBranch(repoRoot, branch);
  await writeRunFolder(id, { workflow, ticket, repo, runDir, workDir, branch }, argv);

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
    await app("pane.split", {
      pane, direction: "right", mod: "workflows",
      props: {
        role: "run", id, orchestrator: made.terminal, title: ticketName(ticket), workflow: workflow.name, branch, folder: workDir,
        strategy: workflow.strategy, repoRoot, ticket: { number: ticket.number ?? null, key: ticket.key ?? null },
        projectId: board.project?.id ?? null, statusField: board.statusField ?? null,
      },
    });
    run("pane.focus", { pane }); // the person answers the orchestrator there
  } catch (e) {
    problems.push(`The list of its agents didn't open (${e?.message ?? e}).`);
  }
  if (problems.length) notify({ title: "The workflow started, with a problem", body: problems.join(" "), level: "warning" });
  return { resumed: false };
}
