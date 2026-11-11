// An Investigation: a New Task Orchestrator that works like a workflow run. It has a branch and a git worktree of its own
// (investigate/<what it is about>-<time>), runs in the background owned by no tab (hc run --bg, like a run's orchestrator),
// and is shown in the first tab of a space of its own at the worktree, which the Spaces sidebar nests under the repo's.
// Like a ticket run's orchestrator it has a **host** (bgrun.js): a tiny terminal in a tab of the repo's space (a space of its own named for the repo
// when that isn't open) that is the agent's parent, so Herdr's Agents panel (which lists only terminals in a pane, and their children) lists host > agent > its helpers. A host
// that won't open fails the start (the agent would be listed nowhere). It is labelled herdr.investigation.host=<id>; the agent's own
// label stays herdr.investigation=<id>.
// The host is not in the session's space, so closing that space or its tab ends neither the host nor the agent.
// Done ends the agent and everything it started (investigators and prototype workers, their worktrees and branches, its host and
// its session folder), closes that space, removes the worktree and deletes the branch. Pure apart from the deps it is handed
// (no Herdr imports), so node --test runs it; investigate.js is Herdr's side, investigation-page.js the page in the tab.
import { FOLDER_LABEL, ROLE_LABEL, shQuote } from "./run.js";
import { slug, normalizeRefactor, validateRefactor } from "./workflow/index.js";
import { normalizeSubAgent } from "./lib/index.js";
import { INVESTIGATION_LABEL, newTaskAgentArgv, refactorAgentArgv, sessionFiles, sessionFolder, subAgentArgv } from "./investigation-spawn.js";
import { endHost, findTicketSpace, launchRun, runTabParts } from "./bgrun.js";
import { row as terminalRow } from "./runview.js";

// The list of investigations still to track (shared state): [{ id, label, repoRoot, repo, branch, workDir, agent }].
// The tab's own slot ({ tab, left, space }) is kept beside it, per id, by bgrun.js's slotKey, as a run's is.
export const INVESTIGATIONS_KEY = "github-tasks.investigations";
export const INVESTIGATION_HOST_LABEL = "herdr.investigation.host"; // on the session's host terminal: the investigation's id. Never INVESTIGATION_LABEL: the host is not the agent, and investigationsFor reads the agent's status by that one
export { INVESTIGATION_LABEL, sessionFolder }; // the label on the agent and on each of its helpers: the investigation's id; the session's folder (both in investigation-spawn.js)
export const INVESTIGATION_ROLE = "investigation"; // its herdr.role label, and the mod pane's props.role
export const TAB_NAME_MAX = 40;

// "inv-" and the time in base 36: short, and unique enough for the one person starting them.
export const investigationId = (now = Date.now()) => `inv-${now.toString(36)}`;

// The first line of what the person typed that has any text in it, trimmed.
export const firstLine = (description) => String(description ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";

// What the session is called in the saved list and the sidebar: its description's first line, else "New task <repo>".
export const investigationLabel = (description, repo) => firstLine(description) || `New task ${String(repo ?? "").split("/").filter(Boolean).pop() ?? ""}`.trim();

// Its tab (and space) name: the label cut at 40.
export const tabNameFor = (label) => String(label).slice(0, TAB_NAME_MAX).trimEnd();

// investigate/fix-the-login-redirect-lq3k9f2: the slug of the first line (40 at most), then the time, so two on one subject never share a branch.
export const investigationBranch = (description, now = Date.now()) => `investigate/${slug(firstLine(description), 40) || "investigation"}-${now.toString(36)}`;

// The session's host tab name: its description's first line cut at 40 and trimmed, and " agents" (`New task agents` with no description).
export const investigationHostName = (description) => `${tabNameFor(firstLine(description) || "New task")} agents`;

// A refactor session's names. Label (the sidebar row, the tab and space, and the host's name before " agents"): `Refactor · <Name>`, with
// `: <first line of the focus>` when there is one; the tab and host cut it at 40 as for any session. Branch: `investigate/refactor-<type id>-<time>`,
// the id cut so that `refactor-<id>` is 40 at most. It starts investigate/, so Done accepts it as it does any session's.
export const refactorLabel = (type, focus) => `Refactor · ${type.name}${firstLine(focus) ? `: ${firstLine(focus)}` : ""}`;
export const refactorBranch = (type, now = Date.now()) => `investigate/${slug(`refactor-${type.id || slug(type.name)}`, 40)}-${now.toString(36)}`;
export const refactorHostName = (type, focus) => `${tabNameFor(refactorLabel(type, focus))} agents`;

// `hc run` for the agent: in the background, owned by no tab (none of the herdr.space / herdr.tab labels that would adopt it into a
// pane), labelled so it can be found again. Under `parent` (the session's host, bgrun.js) it outlives it and types no notes into it,
// so the Agents panel lists host > agent > its helpers; without one it has no parent. `key` is unused: launchRun passes the same
// fields as for a run.
export function investigationRunArgs({ id, workDir, argv, parent = null }) {
  const labels = [`${INVESTIGATION_LABEL}=${id}`, `${ROLE_LABEL}=${INVESTIGATION_ROLE}`, `${FOLDER_LABEL}=${workDir}`];
  const family = parent ? ["--parent", parent, "--outlive-parent", "--no-notify"] : ["--no-parent"];
  return ["run", "--bg", "--json", ...family, "--cwd", workDir, ...labels.flatMap((l) => ["--label", l]), "--", ...argv];
}

// ---- The saved list -----------------------------------------------------------------------------------

const valid = (e) => e && typeof e === "object" && typeof e.id === "string" && typeof e.agent === "string" && e.agent && typeof e.repoRoot === "string";

// The saved list as an array of well-formed entries; anything else saved there is ignored.
export const savedList = (raw) => (Array.isArray(raw) ? raw.filter(valid) : []);

// The list with this entry added, or replacing the one with the same id.
export function withEntry(raw, entry) {
  const list = savedList(raw);
  return list.some((e) => e.id === entry.id) ? list.map((e) => (e.id === entry.id ? entry : e)) : [...list, entry];
}

// The list without that id.
export const withoutEntry = (raw, id) => savedList(raw).filter((e) => e.id !== id);

// Whether this entry's agent is still alive: a live terminal at its address that carries the entry's id (an address could be reused).
const alive = (entry, terminals) => (terminals ?? []).some((k) => k.address === entry.agent && k.state === "live" && k.labels?.[INVESTIGATION_LABEL] === entry.id);

// The session's agent as the sidebar shows it: { live, status }. A live terminal that carries the entry's id shows its own status
// (working, idle, needs you...); anything else (the agent ended on its own, was closed, or its address went to another terminal) is
// "finished", which the sidebar draws in the finished colour. Only Done removes an entry, so an ended one stays to be cleaned up.
export function agentOf(entry, terminals) {
  const k = (terminals ?? []).find((x) => x.address === entry.agent && x.labels?.[INVESTIGATION_LABEL] === entry.id);
  if (!k) return { live: false, status: "finished" };
  const { live, status } = terminalRow(k);
  return { live, status };
}

// The investigations to show for a repo: the saved ones started from it, oldest first, each with its agent's { live, status }.
// `where` is the repo's main checkout (a path), or { repoRoot, repo }: a session also belongs to the repo it was started for
// (entry.repo, "owner/name" for a GitHub repo), so a clone elsewhere of the same repo lists it too. Ended sessions are kept: the
// person has to open them to press Done, which is the only thing that removes the worktree.
export function investigationsFor(saved, where, terminals) {
  const { repoRoot = null, repo = null } = typeof where === "string" ? { repoRoot: where } : where ?? {};
  return savedList(saved)
    .filter((e) => (repoRoot && e.repoRoot === repoRoot) || (repo && e.repo === repo))
    .map((e) => ({ ...e, ...agentOf(e, terminals) }));
}

// The sidebar row of a session: what it says, how it is coloured (a status word runview's statusColor takes) and what its tooltip says.
export function investigationRow(entry) {
  const ended = entry.live === false;
  return {
    id: entry.id, text: firstLine(entry.label) || entry.label || "New task", status: entry.status ?? "unknown", ended,
    tip: ended ? "The agent has ended. Click to open it, then Done removes its worktree and branch." : "Click to open this session.",
  };
}

// Every saved investigation whose agent is alive, whatever the repo (to show them again after an app restart).
export const liveInvestigations = (saved, terminals) => savedList(saved).filter((e) => alive(e, terminals));

// After an app restart the terminals shown in tabs are not kept: show each live investigation's agent again over the left pane
// of its tab. Entries with no tab are left for viewInvestigation. Resolves with how many were shown; one that fails doesn't stop the rest.
//   args: { saved, terminals, slot(id), spaces, panes, show({ terminal, pane }) }
export async function reapplyInvestigations({ saved, terminals, slot, spaces, panes, show }) {
  let shown = 0;
  for (const e of liveInvestigations(saved, terminals)) {
    const parts = runTabParts({ slot: slot(e.id), spaces, panes });
    if (!parts?.left) continue;
    try { await show({ terminal: e.agent, pane: parts.left }); shown++; } catch { /* viewInvestigation shows it later */ }
  }
  return shown;
}

// ---- Starting one -------------------------------------------------------------------------------------

// What Start checks first, before anything is made. Throws with a message for the person.
// A refactor session runs the agent its type names, so it needs none chosen here (refactor: set).
export function checkStart({ agent, where, refactor = null }) {
  if (where?.on) throw new Error(`This space is on ${where.on}. Tasks' agents only start on this computer for now.`);
  if (!where?.cwd) throw new Error("This space has no folder to work in.");
  if (!refactor && !agent?.run?.length) throw new Error("Pick an agent that is installed on this computer.");
}

// The refactor type as a session runs it (refactor-model.js's shape), or throws, with nothing made, saying what is missing from it.
function refactorTypeOf(raw) {
  const type = normalizeRefactor(raw), problems = validateRefactor(type);
  if (problems.length) throw new Error(`The ${type.name || "refactor"} refactor can't start: ${problems.map((p) => p.message).join(" ")}`);
  return type;
}

// A refactor session's roles must each run an agent that is on this computer (start.js resolveAgents' check for a run): throws for the first
// one that is known but not installed. A custom agent runs its own command, and an agent the core doesn't list runs as its key.
function checkInstalled(type, known) {
  for (const role of ["orchestrator", "investigator", "worker"]) {
    const { agent } = type[role];
    const entry = agent === "custom" ? null : (known ?? []).find((a) => a.key === agent);
    if (entry && !entry.installed) throw new Error(`The ${type.name} refactor's ${role} runs ${entry.name ?? agent}, which isn't installed on this computer.`);
  }
}

// Makes the branch and worktree and the session's folder (sessionFolder: the spawn script and the prompts of the helpers the agent may
// start), opens the host, starts the agent with the prompt as its first message and opens its tab; saves the entry as soon as the agent
// exists. Throws with a message for the person, having taken back what it made: the agent, the host and the tab (launchRun), the saved
// entry, the session folder, the worktree and the branch (all brand new, so nothing of the person's is in them). A host that won't open
// fails the start, with the reason, before the agent is started (and with no openHost to call, the start fails the same way).
//   args: { agent (an entry of knownAgents()), description, repo, refactor ({ type: a refactor type as refactor-model.js normalizes it, focus: string } or null: the
//           session is then a Refactor Orchestrator's, with the type's own agents and prompts, and agent, description and groomer are not used), groomer ({ model, effort }), subAgents ({ investigator, worker }: each { agent,
//           model, effort }, as normalizeSubAgent leaves them; the defaults when none), where ({ cwd, on }) }
//   deps: { now(), home, mainCheckout(cwd) -> path, prepareWorktree(repoRoot, branch, target) -> path,
//           worktreePath(repoRoot, branch, home), task(dir) -> the first message (dir: the session folder), knownAgents() -> the core's agents,
//           writeSession(dir, files { name: text }), removeSession(dir), hc(args), connect(props) -> slot (throws), closeTab(),
//           load() -> saved list, save(list), guard?(id, fn) -> Promise (runs fn alone for that id), cleanup?(repoRoot, branch, workDir) -> Promise (removes a worktree and branch),
//           openHost({ id, name, label, workDir, repoRoot }) -> host (throws; the agent's parent; saves the host's record), closeHost(host) (ends it, clears the record) }
//   Resolves with { entry, problems }.
export async function beginInvestigation(deps, { agent, description, repo, groomer, subAgents, where, refactor = null }) {
  checkStart({ agent, where, refactor });
  const now = deps.now();
  const type = refactor && refactorTypeOf(refactor.type); // refused before anything is made when it can't run
  const focus = String(refactor?.focus ?? "");
  const known = await deps.knownAgents().catch(() => []);
  if (type) checkInstalled(type, known); // before anything is made
  const repoRoot = await deps.mainCheckout(where.cwd); // the main checkout, even when started from one of its worktrees
  const repoName = repo || repoRoot.split("/").filter(Boolean).pop() || "";
  const label = type ? refactorLabel(type, focus) : investigationLabel(description, repoName);
  const id = investigationId(now), branch = type ? refactorBranch(type, now) : investigationBranch(description, now);
  const dir = sessionFolder(deps.home, id);
  if (!dir) throw new Error(`Couldn't find a folder for the session's helpers: no home folder is known for ${id}.`); // before anything is made
  const task = await deps.task(dir); // before anything is made: a failure here leaves nothing behind
  const workDir = await deps.prepareWorktree(repoRoot, branch, deps.worktreePath(repoRoot, branch, deps.home));
  const base = { id, label, repoRoot, repo: repoName, branch, workDir };
  const props = { role: INVESTIGATION_ROLE, id, orchestrator: null, title: label, branch, folder: workDir, repoRoot };
  const launchDeps = {
    hc: deps.hc, connect: deps.connect, closeTab: deps.closeTab,
    writePaneJson: async (full) => deps.save(withEntry(deps.load(), { ...base, agent: full.orchestrator })), // saved the moment the agent exists
    openHost: deps.openHost && (() => deps.openHost({ id, name: type ? refactorHostName(type, focus) : investigationHostName(description), label, workDir, repoRoot })),
    closeHost: deps.closeHost,
  };
  try {
    // In a refactor session every role is the type's own (agent, command, model, effort); otherwise the New Task settings'.
    const mine = type ? { investigator: type.investigator, worker: type.worker } : { investigator: normalizeSubAgent(subAgents?.investigator), worker: normalizeSubAgent(subAgents?.worker) };
    const argv = { investigator: subAgentArgv("investigator", mine.investigator, known, dir), worker: subAgentArgv("worker", mine.worker, known, dir) };
    const launch = () => launchRun(launchDeps, {
      id, key: label, workDir, argv: type ? refactorAgentArgv(type.orchestrator, known, dir) : newTaskAgentArgv(agent, groomer, dir), task, props, runArgs: investigationRunArgs, who: "agent", hostRequired: true,
    });
    const prompts = type && { investigator: type.investigator.prompt, worker: type.worker.prompt };
    await deps.writeSession(dir, sessionFiles({ id, dir, workDir, repoRoot, branch, argv, refactor: prompts })); // before the agent: it may use them at once
    const launched = await (deps.guard ? deps.guard(id, launch) : launch()); // guarded as a whole, so View never makes a second tab meanwhile
    return { entry: { ...base, agent: launched.orchestrator }, problems: launched.problems };
  } catch (e) {
    await Promise.resolve(deps.removeSession(dir)).catch(() => {});
    deps.save(withoutEntry(deps.load(), id));
    await deps.cleanup?.(repoRoot, branch, workDir).catch(() => {});
    throw e;
  }
}

// ---- Done ---------------------------------------------------------------------------------------------

// Takes an investigation down. After the refusal checks (read-only), the New Task Orchestrator is ended first, and checked to be no longer
// live, so it can't start anything more. Then everything the session started: every terminal labelled with the session's id (the
// investigators and prototype workers: found by label, so it works when the agent had ended already; live ones are killed, finished
// ones removed), its host, every prototype worktree (`<workDir>--<job>` on `<branch>--<job>`), every `<branch>--*` branch and the
// session folder (~/.herdr/investigations/<id>/). Then the rest of what Done always did: removes the worktree and deletes the
// branch, forgets the entry, the tab's slot and the page's saved sub-agent rows and, as the very last step (the page lives in it),
// closes its space (confirmed, whatever else the person opened in it; only the tab when it was moved to another space). Stops at
// the first thing that fails, with the reason and nothing after it done, so Done can be pressed again: anything that is already
// gone (a terminal, host, worktree, branch or folder) counts as done.
// Whatever isn't the session's own is refused before anything is ended or removed: a branch outside investigate/, the main
// checkout, a worktree of the `<workDir>--` folders that isn't on a `<branch>--` branch (the message says how to fix that by hand).
//   deps: { hc(args), terminals(), spaces(), panes(), slot() (the saved one), git(cwd, ...args), run(name, args), save(list), load(), clearSlot(),
//           home, removeDir(path) -> { code, stderr } (rm -rf), host?() (the saved host record), clearHost?(), clearAgents?() (the page's saved sub-agent rows) }
//   Resolves with { done, error, closed } (closed: false when no space or tab was found to close).
export async function endInvestigation(deps, entry) {
  const { id, agent, repoRoot, workDir, branch } = entry;
  const fail = (error) => ({ done: false, error, closed: false });
  const said = (r) => String(r?.stderr || r?.stdout || "").trim();

  const refused = await unsafeToRemove(deps.git, entry);
  if (refused) return fail(`Done refused: ${refused}. Nothing was ended or removed.`);
  const prototypes = await prototypesOf(deps.git, entry);
  if (prototypes.refused) return fail(`Done refused: ${prototypes.refused}. Nothing was ended or removed.`);
  const folder = sessionFolder(deps.home, id);
  if (!folder) return fail(`Done refused: the session id ${id || "(none)"} isn't an investigation's, so its folder can't be found. Nothing was ended or removed.`);

  // The New Task Orchestrator first, so it can't start anything more while Done works. A failed kill of a terminal that is still live stops
  // Done (a kill that exits 0 is believed: the listing may not have refreshed yet, as in endRun and endHost).
  const killed = await deps.hc(["kill", agent]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  if (killed.code !== 0 && (deps.terminals() ?? []).some((k) => k.state === "live" && k.address === agent)) return fail(`Couldn't end the agent ${agent}: ${said(killed) || "kill failed"}. Nothing else was removed; end it with hc kill, then press Done again.`);
  await deps.hc(["rm", agent]).catch(() => {});

  // Everything the session started, found by label (read after the agent ended, so one it started just before is in the list).
  const subs = () => (deps.terminals() ?? []).filter((k) => k.labels?.[INVESTIGATION_LABEL] === id && k.address !== agent && k.labels?.[ROLE_LABEL] !== INVESTIGATION_ROLE);
  const stuck = [];
  for (const k of subs()) {
    if (k.state === "live") {
      const r = await deps.hc(["kill", k.address]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
      if (r.code !== 0 && subs().some((x) => x.address === k.address && x.state === "live")) { stuck.push(`${k.address}: ${said(r) || "kill failed"}`); continue; }
    }
    await deps.hc(["rm", k.address]).catch(() => {});
  }
  if (stuck.length) return fail(`Couldn't end ${stuck.join("; ")}. Nothing else was removed; end ${stuck.length > 1 ? "them" : "it"} with hc kill.`);
  const hosted = await endHost({ id, label: INVESTIGATION_HOST_LABEL, hc: deps.hc, terminals: deps.terminals, run: deps.run, spaces: deps.spaces(), panes: deps.panes(), record: deps.host?.() ?? null });
  if (hosted.error) return fail(`${hosted.error}. Nothing else was removed; end it with hc kill.`);
  deps.clearHost?.();

  for (const w of prototypes.worktrees) {
    const gone = await removeWorktree(deps.git, repoRoot, w, "The agent and its sub-agents were ended; press Done again once that is fixed.");
    if (gone) return fail(gone);
  }
  for (const b of prototypes.branches) {
    const gone = await deleteBranch(deps.git, repoRoot, b, "The agent, its sub-agents and the prototype worktrees are gone; press Done again once that is fixed.");
    if (gone) return fail(gone);
  }
  const rmd = await Promise.resolve(deps.removeDir(folder)).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  if (rmd && rmd.code !== 0) return fail(`Couldn't remove the session folder ${folder}: ${said(rmd) || "rm failed"}. Press Done again once that is fixed.`);

  // Where its tab is, read before anything is closed.
  const spaces = deps.spaces(), panes = deps.panes();
  const parts = runTabParts({ slot: deps.slot(), spaces, panes });
  const own = findTicketSpace({ spaces, panes, folder: workDir, repoRoot });

  const removed = await removeWorktree(deps.git, repoRoot, workDir);
  if (removed) return fail(removed);
  const deleted = await deleteBranch(deps.git, repoRoot, branch);
  if (deleted) return fail(deleted);

  deps.save(withoutEntry(deps.load(), id));
  deps.clearSlot();
  deps.clearAgents?.();
  if (parts && parts.space !== own) deps.run("tab.close", { id: parts.tab }); // not its own space: the person's other tabs stay
  else if (own) deps.run("space.close", { id: own, confirmed: true });
  else return { done: true, error: null, closed: false };
  return { done: true, error: null, closed: true };
}

// What the session's prototype workers made: the worktrees of `git worktree list` whose folder starts `<workDir>--` and whose
// branch starts `<branch>--`, and every branch starting `<branch>--` (a worker's worktree may be gone while its branch isn't).
// A worktree in those folders that is on some other branch, or none, isn't the session's: it is `refused`, with why and how to fix
// it by hand, as is a main checkout there. A branch that doesn't start with investigate/ is refused up front: the `<branch>--`
// prefix is only the session's own when `branch` itself is an investigation's. Folders are matched as git lists them (real paths),
// so the entry's folder is first resolved the same way (`rev-parse --show-toplevel`; as given when it is gone).
// Resolves with { worktrees, branches, refused }.
export async function prototypesOf(git, { repoRoot, workDir, branch }) {
  const clean = (p) => String(p ?? "").replace(/\/+$/, "");
  const out = { worktrees: [], branches: [], refused: null };
  if (typeof branch !== "string" || !branch.startsWith("investigate/")) return { ...out, refused: `the branch ${branch || "(none)"} isn't an investigation's (investigate/...)` };
  const branchPrefix = `${branch}--`;
  const list = await git(repoRoot, "worktree", "list", "--porcelain");
  if (list.code !== 0) return { ...out, refused: `couldn't list the worktrees: ${String(list.stderr || list.stdout || "").trim() || "git failed"}` };
  const top = await git(workDir, "rev-parse", "--show-toplevel").catch(() => null);
  const real = top?.code === 0 && clean(top.stdout.trim()) ? clean(top.stdout.trim()) : clean(workDir);
  const prefixes = [...new Set([`${clean(workDir)}--`, `${real}--`])];
  const blocks = list.stdout.split("\n\n").map((b) => b.split("\n"));
  const main = clean(blocks[0]?.find((l) => l.startsWith("worktree "))?.slice(9));
  for (const lines of blocks) {
    const path = clean(lines.find((l) => l.startsWith("worktree "))?.slice(9));
    const prefix = prefixes.find((p) => path.startsWith(p));
    if (!prefix) continue;
    if (path === main || path === clean(repoRoot)) return { ...out, refused: `${path} is the repo's main checkout` };
    const name = (lines.find((l) => l.startsWith("branch "))?.slice(7) ?? "").replace(/^refs\/heads\//, "");
    if (!name.startsWith(branchPrefix)) {
      const job = path.slice(prefix.length);
      return { ...out, refused: `the worktree ${path} is on ${name || "no branch (detached)"}, not one of this session's ${branchPrefix}... branches. To fix it by hand, switch it to one (git -C ${shQuote(path)} switch ${shQuote(`${branchPrefix}${job}`)}) or remove it yourself (git -C ${shQuote(repoRoot)} worktree remove --force ${shQuote(path)}), then press Done again` };
    }
    out.worktrees.push(path);
  }
  const refs = await git(repoRoot, "for-each-ref", "--format=%(refname)", "refs/heads/");
  if (refs.code !== 0) return { ...out, refused: `couldn't list the branches: ${String(refs.stderr || refs.stdout || "").trim() || "git failed"}` };
  for (const line of refs.stdout.split("\n")) {
    const name = line.trim().replace(/^refs\/heads\//, "");
    if (name.startsWith(branchPrefix)) out.branches.push(name);
  }
  return out;
}

// Done removes a worktree with --force and deletes a branch with -D, so before anything is touched it makes sure the entry points at an
// investigation's own: the branch is investigate/..., and the folder is neither the main checkout (the entry's repoRoot, or the
// first entry of `git worktree list`) nor empty. Resolves with why not, or null.
export async function unsafeToRemove(git, { repoRoot, workDir, branch }) {
  const clean = (p) => String(p ?? "").replace(/\/+$/, "");
  if (typeof branch !== "string" || !branch.startsWith("investigate/")) return `the branch ${branch || "(none)"} isn't an investigation's (investigate/...)`;
  if (!clean(workDir) || !clean(repoRoot)) return "the entry has no folder to remove";
  if (clean(workDir) === clean(repoRoot)) return `${workDir} is the repo's main checkout`;
  const list = await git(repoRoot, "worktree", "list", "--porcelain").catch(() => null);
  const main = list?.code === 0 ? list.stdout.split("\n\n")[0].split("\n").find((l) => l.startsWith("worktree "))?.slice(9) : null;
  if (main && clean(main) === clean(workDir)) return `${workDir} is the repo's main checkout`;
  return null;
}

// `git worktree remove --force` (the person's uncommitted changes go with it). A worktree whose folder was deleted by hand is pruned instead.
// Resolves with null, or the error to say, ending in `tail` (what the person should know has happened and what to do).
export async function removeWorktree(git, repoRoot, workDir, tail = "The agent was ended; press Done again once that is fixed.") {
  const r = await git(repoRoot, "worktree", "remove", "--force", workDir);
  if (r.code === 0) return null;
  await git(repoRoot, "worktree", "prune");
  const list = await git(repoRoot, "worktree", "list", "--porcelain");
  if (list.code === 0 && !list.stdout.split("\n").includes(`worktree ${workDir}`)) return null;
  return `Couldn't remove the worktree ${workDir}: ${String(r.stderr || r.stdout || "").trim() || "git failed"}. ${tail}`;
}

// `git branch -D`, from the main checkout. A branch that is already gone is fine. Resolves with null, or the error to say, ending in `tail`.
export async function deleteBranch(git, repoRoot, branch, tail = "The worktree was removed; press Done again once that is fixed.") {
  const r = await git(repoRoot, "branch", "-D", branch);
  if (r.code === 0) return null;
  if ((await git(repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)).code !== 0) return null;
  return `Couldn't delete the branch ${branch}: ${String(r.stderr || r.stdout || "").trim() || "git failed"}. ${tail}`;
}
