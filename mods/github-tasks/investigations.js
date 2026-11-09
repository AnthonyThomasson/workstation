// An Investigation: a New Task agent that works like a workflow run. It has a branch and a git worktree of its own
// (investigate/<what it is about>-<time>), runs in the background owned by no tab (hc run --bg, like a run's orchestrator),
// and is shown in the first tab of a space of its own at the worktree, which the Spaces sidebar nests under the repo's.
// Done ends the agent, closes that space, removes the worktree and deletes the branch. Pure apart from the deps it is handed
// (no Herdr imports), so node --test runs it; investigate.js is Herdr's side, investigation-page.js the page in the tab.
import { FOLDER_LABEL, ROLE_LABEL } from "./run.js";
import { slug } from "./workflow-model.js";
import { groomArgv } from "./model.js";
import { findTicketSpace, launchRun, runTabParts } from "./bgrun.js";
import { row as terminalRow } from "./runview.js";

// The list of investigations still to track (shared state): [{ id, label, repoRoot, repo, branch, workDir, agent }].
// The tab's own slot ({ tab, left, space }) is kept beside it, per id, by bgrun.js's slotKey, as a run's is.
export const INVESTIGATIONS_KEY = "github-tasks.investigations";
export const INVESTIGATION_LABEL = "herdr.investigation"; // on the agent: the investigation's id
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

// `hc run` for the agent: in the background, owned by nothing (no parent, none of the herdr.space / herdr.tab labels that would
// adopt it into a pane), labelled so it can be found again. `key` is unused: launchRun passes the same fields as for a run.
export function investigationRunArgs({ id, workDir, argv }) {
  const labels = [`${INVESTIGATION_LABEL}=${id}`, `${ROLE_LABEL}=${INVESTIGATION_ROLE}`, `${FOLDER_LABEL}=${workDir}`];
  return ["run", "--bg", "--json", "--no-parent", "--cwd", workDir, ...labels.flatMap((l) => ["--label", l]), "--", ...argv];
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
export function checkStart({ agent, where }) {
  if (where?.on) throw new Error(`This space is on ${where.on}. Tasks' agents only start on this computer for now.`);
  if (!where?.cwd) throw new Error("This space has no folder to work in.");
  if (!agent?.run?.length) throw new Error("Pick an agent that is installed on this computer.");
}

// Makes the branch and worktree, starts the agent with the prompt as its first message and opens its tab; saves the entry as
// soon as the agent exists. Throws with a message for the person, having taken back what it made: the agent and the tab
// (launchRun), the saved entry, the worktree and the branch (all brand new, so nothing of the person's is in them).
//   args: { agent (an entry of knownAgents()), description, repo, groomer ({ model, effort }), where ({ cwd, on }) }
//   deps: { now(), home, mainCheckout(cwd) -> path, prepareWorktree(repoRoot, branch, target) -> path,
//           worktreePath(repoRoot, branch, home), task() -> the first message, hc(args), connect(props) -> slot (throws), closeTab(),
//           load() -> saved list, save(list), guard?(id, fn) -> Promise (runs fn alone for that id), cleanup?(repoRoot, branch, workDir) -> Promise (removes a worktree and branch) }
//   Resolves with { entry, problems }.
export async function beginInvestigation(deps, { agent, description, repo, groomer, where }) {
  checkStart({ agent, where });
  const now = deps.now();
  const repoRoot = await deps.mainCheckout(where.cwd); // the main checkout, even when started from one of its worktrees
  const repoName = repo || repoRoot.split("/").filter(Boolean).pop() || "";
  const label = investigationLabel(description, repoName);
  const task = await deps.task(); // before anything is made: a failure here leaves nothing behind
  const id = investigationId(now), branch = investigationBranch(description, now);
  const workDir = await deps.prepareWorktree(repoRoot, branch, deps.worktreePath(repoRoot, branch, deps.home));
  const base = { id, label, repoRoot, repo: repoName, branch, workDir };
  const props = { role: INVESTIGATION_ROLE, id, orchestrator: null, title: label, branch, folder: workDir, repoRoot };
  const launchDeps = {
    hc: deps.hc, connect: deps.connect, closeTab: deps.closeTab,
    writePaneJson: async (full) => deps.save(withEntry(deps.load(), { ...base, agent: full.orchestrator })), // saved the moment the agent exists
  };
  const launch = () => launchRun(launchDeps, {
    id, key: label, workDir, argv: groomArgv(agent.key, agent.run, groomer ?? {}), task, props, runArgs: investigationRunArgs, who: "agent",
  });
  try {
    const launched = await (deps.guard ? deps.guard(id, launch) : launch()); // guarded as a whole, so View never makes a second tab meanwhile
    return { entry: { ...base, agent: launched.orchestrator }, problems: launched.problems };
  } catch (e) {
    deps.save(withoutEntry(deps.load(), id));
    await deps.cleanup?.(repoRoot, branch, workDir).catch(() => {});
    throw e;
  }
}

// ---- Done ---------------------------------------------------------------------------------------------

// Takes an investigation down: ends the agent, removes the worktree and deletes the branch, forgets the entry and, as the very
// last step (the page lives in it), closes its space (confirmed, whatever else the person opened in it; only the tab when it was
// moved to another space). Stops at the first thing that fails, with the reason and nothing after it done, so Done can be
// pressed again: ending an agent that is gone, removing a worktree that is gone and deleting a branch that is gone all count as done.
//   deps: { hc(args), terminals(), spaces(), panes(), slot() (the saved one), git(cwd, ...args), run(name, args), save(list), load(), clearSlot() }
//   Resolves with { done, error, closed } (closed: false when no space or tab was found to close).
export async function endInvestigation(deps, entry) {
  const { id, agent, repoRoot, workDir, branch } = entry;
  const fail = (error) => ({ done: false, error, closed: false });
  const said = (r) => String(r?.stderr || r?.stdout || "").trim();

  const refused = await unsafeToRemove(deps.git, entry);
  if (refused) return fail(`Done refused: ${refused}. Nothing was ended or removed.`);
  const live = () => (deps.terminals() ?? []).some((k) => k.state === "live" && k.address === agent);

  const killed = await deps.hc(["kill", agent]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  if (killed.code !== 0 && live()) return fail(`Couldn't end the agent ${agent}: ${said(killed) || "kill failed"}. Nothing else was removed; end it with hc kill.`);
  await deps.hc(["rm", agent]).catch(() => {});

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
  if (parts && parts.space !== own) deps.run("tab.close", { id: parts.tab }); // not its own space: the person's other tabs stay
  else if (own) deps.run("space.close", { id: own, confirmed: true });
  else return { done: true, error: null, closed: false };
  return { done: true, error: null, closed: true };
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
// Resolves with null, or the error to say.
export async function removeWorktree(git, repoRoot, workDir) {
  const r = await git(repoRoot, "worktree", "remove", "--force", workDir);
  if (r.code === 0) return null;
  await git(repoRoot, "worktree", "prune");
  const list = await git(repoRoot, "worktree", "list", "--porcelain");
  if (list.code === 0 && !list.stdout.split("\n").includes(`worktree ${workDir}`)) return null;
  return `Couldn't remove the worktree ${workDir}: ${String(r.stderr || r.stdout || "").trim() || "git failed"}. The agent was ended; press Done again once that is fixed.`;
}

// `git branch -D`, from the main checkout. A branch that is already gone is fine. Resolves with null, or the error to say.
export async function deleteBranch(git, repoRoot, branch) {
  const r = await git(repoRoot, "branch", "-D", branch);
  if (r.code === 0) return null;
  if ((await git(repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)).code !== 0) return null;
  return `Removed the worktree, but couldn't delete the branch ${branch}: ${String(r.stderr || r.stdout || "").trim() || "git failed"}. Press Done again once that is fixed.`;
}
