// What the run page does when the person is done: move the ticket along, open a pull request, merge it.
// Pure: no Herdr imports, so node --test runs it. run-page.js does the exec calls and the drawing.

import { sameStatus, STATUSES } from "./model.js";
import { STATUS_MUTATION } from "./loader.js";

export const STAGES = [STATUSES.inProgress, STATUSES.inReview, STATUSES.done]; // what a ticket becomes as the run goes on, in order (Done is set by Merge)

// The stage the run has reached: 0 nothing yet, 1 a worker started, 2 a reviewer started.
// agents: { workers, reviewers }, with every agent seen (the ones that ended too).
export const stageOf = (agents) => (agents.reviewers?.length ? 2 : agents.workers?.length ? 1 : 0);

// Whether a final reviewer has shown up: in the rows seen (the ones that ended too) or in what the page saved, so a restart
// keeps it. saved: the value kept in shared state, any of 1, "1" or nothing.
export const finalSeen = ({ reviewers = [], saved } = {}) => reviewers.some((r) => r.final) || Boolean(Number(saved));

// Merge and the automatic pull request wait for the final review to have started and every worker and reviewer to have ended.
export const canMerge = ({ finalSeen: seen, workers = [], reviewers = [] }) =>
  Boolean(seen) && !workers.some((w) => w.live) && !reviewers.some((r) => r.live);

// The project's Status option for a stage, or null when the project has none by that name.
// stage 3 is Done.
export function optionFor(options, stage) {
  const name = STAGES[stage - 1];
  return (options ?? []).find((o) => sameStatus(o.name, name)) ?? null;
}

// gh args that set the item's status to the option.
export const statusArgs = ({ projectId, itemId, fieldId, optionId }) =>
  ["api", "graphql", "-f", `query=${STATUS_MUTATION}`, "-f", `project=${projectId}`, "-f", `item=${itemId}`, "-f", `field=${fieldId}`, "-f", `option=${optionId}`];

// gh/git args that say whether the ticket worktree folder is still there, and whether the ticket branch still is
// (exit code 0 means yes). Merge can be pressed again after a partial failure, so it asks before each part.
export const worktreeArgs = (workDir) => ["-C", workDir, "rev-parse", "--git-dir"];
export const branchArgs = (repoRoot, branch) => ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`];

// Merge as a list of steps, in order. A step is { name, cmd, args, cwd?, fail, done?, dirty?, warn? }:
//   fail   what to say when it fails; done  what to call it once it has happened ("Already done: ...")
//   dirty  stop with this when its output is not empty (a check)    warn  not run: runSteps passes this on as a warning
// Merge goes through the ticket's pull request and never runs git in the main checkout's working tree: no switch, no local
// merge, no push of the default branch. In order:
//   tree-status   the ticket worktree has no uncommitted changes (nothing is committed for the person any more)
//   fetch, ahead  the local ticket branch has no commits origin's copy lacks, so the squash can't leave work behind
//   pr-merge      gh pr merge <n> --squash (no --admin, no --auto). If GitHub refuses, its message is shown and nothing after it runs
//   status        the ticket Done (a local task: its file moves to done/)    remove-worktree / prune-worktrees    delete-branch (-D: a squash leaves the branch looking unmerged)    remove-run-files
// number: the pull request's number. prMerged: the caller has just asked gh and the pull request is already MERGED, so the
// merge step is skipped, and so are fetch and ahead (GitHub may have deleted the remote branch). headOid: the commit the PR was
// merged from (headRefOid); then fetch-pr-head gets that commit from GitHub (refs/pull/<number>/head), and not-in-pr stops if the local branch has commits beyond it, which the PR never took in.
// status: { args } to set the ticket Done, { warn } when the project has no such option, or nothing when there is no project.
// workDirExists / branchExists: false when an earlier Merge already removed the folder / deleted the branch; the steps for
// them are left out, so pressing Merge again finishes what was left.
// Only a child of a .herdr/workflow-runs folder can be removed. In particular, never rm the parent or a path
// reached through a run id containing traversal; Merge builds this path from home() and the run id.
const safeRunDir = (runDir) => {
  const id = typeof runDir === "string" ? runDir.match(/^\/(?:.*\/)?\.herdr\/workflow-runs\/([^/]+)$/)?.[1] : null;
  return Boolean(id && id !== "." && !id.includes(".."));
};

// The step that sets the ticket Done. status: { args } (a gh call), { move } (local tasks: an async function that moves the task's file), or { warn }.
export const statusStep = (status) => status.warn ? { name: "status", warn: status.warn }
  : status.move ? { name: "status", run: status.move, fail: "Couldn't move the task to done/.", done: "moved the task to done/" }
  : { name: "status", cmd: "gh", args: status.args, fail: "Couldn't set the ticket's status.", done: "set the ticket's status" };

// What Merge ends with whichever way the work got in: remove the worktree (or forget a folder already gone), delete the
// branch (-D: a squash leaves it looking unmerged) and the run folder. workDirExists / branchExists: see mergeSteps.
export function cleanupSteps({ repoRoot, workDir, branch, runDir, workDirExists = true, branchExists = true }) {
  const git = (args) => ({ cmd: "git", args });
  return [
    ...(workDirExists ? [{ name: "remove-worktree", ...git(["-C", repoRoot, "worktree", "remove", workDir]), fail: `Couldn't remove the worktree ${workDir}.`, done: `removed the worktree ${workDir}` }]
      : [{ name: "prune-worktrees", ...git(["-C", repoRoot, "worktree", "prune"]), fail: `Couldn't clear the removed worktree ${workDir} from git's list.` }]),
    ...(branchExists ? [{ name: "delete-branch", ...git(["-C", repoRoot, "branch", "-D", branch]), fail: `Couldn't delete the branch ${branch}.`, done: `deleted ${branch}` }] : []),
    ...(safeRunDir(runDir) ? [{ name: "remove-run-files", cmd: "rm", args: ["-rf", runDir], fail: `Couldn't remove the run files ${runDir}.`, done: `removed the run files ${runDir}` }] : []),
  ];
}

export function mergeSteps({ repoRoot, workDir, branch, number, prMerged = false, headOid, status, runDir, workDirExists = true, branchExists = true }) {
  if (!prMerged && !number) throw new Error("Merge needs the pull request, and this run has none.");
  const git = (args) => ({ cmd: "git", args });
  const inTree = workDirExists ? workDir : repoRoot; // where the remote is asked: the ticket worktree, else the repo's git dir (no checkout is touched)
  const remote = `origin/${branch}`;
  const push = `git -C ${inTree} push origin ${branch}`;
  return [
    ...(workDirExists ? [{ name: "tree-status", ...git(["-C", workDir, "status", "--porcelain"]), fail: `Couldn't look at ${workDir}.`,
      dirty: `${workDir} has uncommitted changes. Commit or discard them (and push, so the pull request has them), then press Merge again.` }] : []),
    ...(branchExists && !prMerged ? [
      // An explicit refspec, so a single-branch clone (whose default fetch refspec names only one branch) still updates origin/<branch>.
      { name: "fetch", ...git(["-C", inTree, "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]), fail: `Couldn't fetch ${branch} from origin.` },
      { name: "ahead", ...git(["-C", inTree, "rev-list", `${remote}..${branch}`]), fail: `Couldn't compare ${branch} with ${remote}.`,
        dirty: `${branch} has commits that ${remote} doesn't. Run \`${push}\` so the pull request has them, then press Merge again.` },
    ] : []),
    // A pull request merged already: whatever the local branch has beyond the commit the PR was merged from never made it in.
    // headOid may be a commit someone pushed to the PR branch on GitHub that was never fetched here; GitHub keeps it under
    // refs/pull/<n>/head even after the branch is deleted. Fetch it (into FETCH_HEAD) so the comparison can't fail on a missing object.
    ...(branchExists && prMerged && headOid ? [
      ...(number ? [{ name: "fetch-pr-head", ...git(["-C", inTree, "fetch", "origin", `+refs/pull/${number}/head`]), fail: `Couldn't fetch the merged pull request #${number} from origin, so can't tell whether ${branch} has commits it doesn't. Nothing was cleaned up; press Merge again once origin can be reached.` }] : []),
      { name: "not-in-pr", ...git(["-C", inTree, "rev-list", `${headOid}..${branch}`]), fail: `Couldn't compare ${branch} with the merged pull request (${headOid.slice(0, 8)}).`,
        dirty: `${branch} has commits that the merged pull request doesn't. Don't clean up yet: open a new pull request for them, or drop them with \`git -C ${inTree} reset --hard ${headOid.slice(0, 8)}\`, then press Merge again.` },
    ] : []),
    ...(prMerged ? [] : [{ name: "pr-merge", cmd: "gh", args: ["pr", "merge", String(number), "--squash"], cwd: inTree, fail: `GitHub didn't merge pull request #${number}.`, done: `merged pull request #${number}` }]),
    ...(status ? [statusStep(status)] : []),
    ...cleanupSteps({ repoRoot, workDir, branch, runDir, workDirExists, branchExists }),
  ];
}

// Whether the page should open the pull request by itself now: once per run (tried is saved in shared state before the
// attempt, so a reload or a failure doesn't try again), when Merge would be allowed and the run has no pull request yet.
export const shouldAutoPr = ({ ready, pr, tried, busy }) => Boolean(ready) && !pr && !tried && !busy;

// The steps that come after the work is merged. A failure in one of these is plain red text: there is nothing left to fix
// before Merge, only the clean-up to finish, which pressing Merge again does.
const CLEANUP = new Set(["status", "remove-worktree", "prune-worktrees", "delete-branch", "remove-run-files"]);

// Runs steps with exec(cmd, args, opts) -> { code, stdout, stderr }. Besides commands, a step may be { run(exec) } (what it returns, if a string, is what it did) or { check(stdout) }. Resolves { done, warnings } with what happened and
// what was said on the way; throws an Error at the first step that fails, saying which earlier steps already happened.
// The error says where it stopped, for mergeFailure: step (the step's name), found (the step ran and found a problem: leftover
// changes, commits origin lacks; not set when it couldn't run), conflict (a run step's error said so) and phase "cleanup" (the
// work was merged already).
export async function runSteps(steps, exec) {
  const done = [], warnings = [];
  const text = (r) => String(r.stderr || r.stdout || "").trim();
  const stop = (message, st, extra = {}) => { throw Object.assign(new Error(done.length ? `${message} Already done: ${done.join(", ")}.` : message), { step: st.name }, CLEANUP.has(st.name) ? { phase: "cleanup" } : {}, extra); };
  const go = async (list) => {
    for (const st of list) {
      if (st.warn) { warnings.push(st.warn); continue; }
      // run: a step that is code, not a command (it gets exec, and throws a message the person can read). Local Merge uses these.
      if (st.run) { let said; try { said = await st.run(exec); } catch (e) { stop(String(e?.message ?? e), st, e?.conflict ? { conflict: true } : {}); } const d = typeof said === "string" ? said : st.done; if (d) done.push(d); continue; }
      const r = await exec(st.cmd, st.args, st.cwd ? { cwd: st.cwd } : undefined);
      if (st.check) { if (r.code !== 0) stop(`${st.fail} ${text(r)}`.trim(), st); const bad = st.check(String(r.stdout ?? "")); if (bad) stop(bad, st, { found: true }); continue; } // check: stdout -> what to stop with, or null
      if (st.dirty) { if (r.code !== 0) stop(`${st.fail} ${text(r)}`.trim(), st); if (String(r.stdout ?? "").trim()) stop(st.dirty, st, { found: true }); continue; }
      if (r.code !== 0) stop(`${st.fail} ${text(r)}`.trim(), st);
      if (st.done) done.push(st.done);
    }
  };
  await go(steps);
  return { done, warnings };
}

// What a failed Merge turns the button into. A failure up to and including the merge itself is something the orchestrator can
// fix: the button goes red with the short label of the fix. A failure after the work is merged (the clean-up) is not.
export const LABELS = { conflicts: "Fix conflicts", checks: "Fix checks", commit: "Commit changes", push: "Push branch", merge: "Fix merge" };

// gh args that say whether the pull request can be merged, and what its checks say. Asked when `gh pr merge` fails; the reason is
// worked out from this, never from the error's text.
export const prStateArgs = (number) => ["pr", "view", String(number), "--json", "mergeable,mergeStateStatus,statusCheckRollup"];

// A check that failed: a CheckRun's conclusion, or a StatusContext's state.
const BAD_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const BAD_STATES = new Set(["FAILURE", "ERROR"]);
const upper = (v) => String(v ?? "").toUpperCase();

// The output of prStateArgs as { conflicting, failingChecks }, or null when it isn't the JSON asked for.
export function parsePrState(text) {
  let p;
  try { p = JSON.parse(text); } catch { return null; }
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const rollup = Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup : [];
  return {
    conflicting: upper(p.mergeable) === "CONFLICTING" || upper(p.mergeStateStatus) === "DIRTY", // DIRTY: the branch has conflicts with its base
    failingChecks: rollup.some((c) => BAD_CONCLUSIONS.has(upper(c?.conclusion)) || BAD_STATES.has(upper(c?.state))),
  };
}

// The failure runSteps (or the page's own checks before it) threw, as { kind, label, error }, or null when it is a plain error
// (the clean-up failed: the work is merged). prState: parsePrState, asked by the page only when `gh pr merge` failed; null when
// it couldn't be asked. error.step / found / conflict / phase: see runSteps.
export function mergeFailure({ error, prState } = {}) {
  if (!error || error.phase === "cleanup") return null;
  const message = String(error.message ?? error);
  const kind = error.step === "tree-status" && error.found ? "commit"
    : error.step === "ahead" && error.found ? "push"
    : error.step === "push-branch" ? "push" // the push that opens the pull request failed
    : error.conflict ? "conflicts"
    : error.step === "pr-merge" && prState?.conflicting ? "conflicts"
    : error.step === "pr-merge" && prState?.failingChecks ? "checks"
    : "merge";
  return { kind, label: LABELS[kind], error: message };
}

// What the orchestrator is asked to do about a failure (a sentence for each kind). noRemote: a local run, which pushes nothing.
function fixSteps({ kind, branch, workDir, noRemote }) {
  const commit = `commit what is left in ${workDir} (have a reviewer check it first if it is new work)`;
  const push = `push the ticket branch with \`git -C ${workDir} push origin ${branch}\``;
  if (noRemote && kind === "push") kind = "merge"; // a local run has no remote to push to
  const fix = {
    commit: noRemote ? commit : `${commit}, then ${push}`, // the suffix below asks for the report
    push,
    conflicts: noRemote
      ? `bring the default branch into the ticket branch: rebase it onto the default branch in ${workDir} and resolve the conflicts, through a worker and a reviewer`
      : `bring the default branch into the ticket branch: fetch origin and rebase it onto origin's default branch in ${workDir}, resolving the conflicts through a worker and a reviewer, then ${push.replace("push origin", "push --force-with-lease origin")}`,
    checks: noRemote ? `fix what fails, through a worker and a reviewer` : `fix the failing checks through a worker and a reviewer, then ${push}`,
    merge: noRemote
      ? `fix it if you can (through a worker and a reviewer for any code change), and if it needs the person, such as the main checkout, say that you can't fix it`
      : `fix it if you can (through a worker and a reviewer for any code change, and ${push} if the branch changed, with --force-with-lease after a rebase), and if it needs the person, such as signing in to gh or approving a review, say that you can't fix it`,
  };
  return `${fix[kind] ?? fix.merge}. Report back when it is done. Never commit to or push the default branch${noRemote ? " (this repo has no remote: push nothing at all)" : ""}, and do not merge: the person presses Merge again`;
}

// A line with no double quotes (it is one argument of `hc send`).
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/"/g, "'").trim();

const failureLine = ({ failure, branch, workDir }) =>
  `Merge stopped on the run page, and the person pressed ${failure.label}. The full error, in brackets: [${oneLine(failure.error)}] The ticket branch is ${branch}, in the worktree ${workDir}.`;

// What the run page sends the live orchestrator when the red button is pressed: one line, no double quotes.
// failure: mergeFailure.
export function fixMessage({ failure, branch, workDir, noRemote }) {
  return `${failureLine({ failure, branch, workDir })} Please ${fixSteps({ kind: failure.kind, branch, workDir, noRemote })}.`;
}

// The first task of a new orchestrator, started because the one that ran the ticket has ended: the same fix as fixMessage,
// with the rules to read first and without the planning, as the ticket is built and merged into the ticket branch already.
export function restartTask({ runDir, failure, branch, workDir, noRemote }) {
  return `Read ${runDir}/orchestrator.md and follow its rules, but skip the planning and the questions: the ticket is already built and merged into the ticket branch ${branch}. ${failureLine({ failure, branch, workDir })} Fix only this: ${fixSteps({ kind: failure.kind, branch, workDir, noRemote })}. Any change still goes through a worker and a reviewer; then report.`;
}

// The "orchestrator is fixing it" record, made when the fix message is sent: { label, error, seenWorking, turn }. status: the
// orchestrator's status word then; turn: its turn counter then (hc reports one per terminal), or nothing when unknown.
// seenWorking starts false when the turn is known (the turn counter tells when a turn has ended, and a turn already in progress
// may be about to end), else from the status.
export const fixingStart = ({ failure, status, turn }) => {
  const known = Number.isFinite(turn);
  return { label: failure.label, error: failure.error, seenWorking: !known && (status === "working" || status === "blocked"), turn: known ? turn : null };
};

// What the page says under the disabled Merge while the orchestrator is fixing it.
export const fixingNote = (fixing) => `The orchestrator is fixing it (${fixing.label}). Merge comes back when it is done.`;

// Whether the "orchestrator is fixing it" state is over. fixing: the record (fixingStart); status: the orchestrator's status
// word; live: whether its terminal is still there; turn: its turn counter now. Returns the record to keep, or null when the state
// ends: the orchestrator is gone, or its turn counter has moved past the one at send time and it is not working or blocked (which
// catches a turn that began and ended between two looks, and an agent that reports "unknown"), or it is done or idle after being seen working. Working (and blocked, which waits for the person)
// is still going; done or idle with neither sign means the message may not have landed yet. A send that was lost never ends by
// itself: the page offers to dismiss it. Merge never retries by itself.
export function fixingDone({ fixing, status, live, turn }) {
  if (!fixing || !live) return null;
  if (status === "working" || status === "blocked") return { ...fixing, seenWorking: true };
  const advanced = Number.isFinite(turn) && Number.isFinite(fixing.turn) && turn > fixing.turn;
  if (advanced) return null;
  if ((status === "done" || status === "idle") && fixing.seenWorking) return null;
  return fixing;
}

// What the Merge button is. failure: the red state (mergeFailure), fixing: the record, busy: "merge" | "pr" | "fix" | null,
// ready: the gate (canMerge, and a run page that knows its folder and branch). Returns { mode, label, enabled }:
// normal (Merge, enabled when ready), red (the fix's label, enabled until pressed), fixing (Merge, disabled; the note says why).
export function mergeView({ ready, busy, failure, fixing }) {
  if (fixing) return { mode: "fixing", label: "Merge", enabled: false };
  if (failure) return { mode: "red", label: busy === "fix" ? "Sending…" : failure.label, enabled: !busy };
  const label = busy === "merge" ? "Merging…" : busy === "pr" ? "Opening PR…" : "Merge";
  return { mode: "normal", label, enabled: Boolean(ready) && !busy };
}

// The red state and the fixing record as shared state kept them (JSON), or null when they aren't that.
export function restoreFailure(saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved) || !LABELS[saved.kind] || typeof saved.error !== "string") return null;
  return { kind: saved.kind, label: LABELS[saved.kind], error: saved.error };
}
export function restoreFixing(saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved) || typeof saved.label !== "string") return null;
  return { label: saved.label, error: typeof saved.error === "string" ? saved.error : "", seenWorking: Boolean(saved.seenWorking), turn: Number.isFinite(saved.turn) ? saved.turn : null };
}

// gh args for the pull request; the body links the ticket when it has a number. body: replaces that (a local task has no GitHub issue to close).
export function prArgs({ branch, title, number, body }) {
  return ["pr", "create", "--head", branch, "--title", number ? `#${number} ${title}` : title, "--body", body ?? (number ? `Closes #${number}` : "")];
}

// The pull request's URL from what gh printed, or null.
export const parsePrUrl = (text) => String(text ?? "").match(/https:\/\/\S+\/pull\/\d+/)?.[0] ?? null;
export const prNumber = (url) => url?.match(/\/pull\/(\d+)/)?.[1] ?? null;

// Opens the pull request, as the first part of Merge when the run has none yet (and for the automatic pull request): pushes the
// branch with -u, then `gh pr create`. exec(cmd, args, opts) -> { code, stdout, stderr }. Resolves { url, state: "OPEN", number }.
// Throws an Error saying why, with step "push-branch" or "open-pr" for mergeFailure (Push branch / Fix merge).
export async function openPullRequest(exec, { folder, branch, title, number, body }) {
  const said = (r) => String(r.stderr || r.stdout || "").trim();
  const push = await exec("git", ["-C", folder, "push", "-u", "origin", branch]);
  if (push.code !== 0) throw Object.assign(new Error(`The push failed: ${said(push)}`), { step: "push-branch" });
  const made = await exec("gh", prArgs({ branch, title, number, body }), { cwd: folder });
  const url = parsePrUrl(made.stdout) ?? parsePrUrl(made.stderr); // gh says "already exists" with the URL on stderr
  if (!url) throw Object.assign(new Error(`gh didn't open a pull request: ${said(made)}`), { step: "open-pr" });
  return { url, state: "OPEN", number: prNumber(url) };
}

// gh args that say where the branch's pull request stands: prints JSON { url, state, number, headRefOid }.
export const prViewArgs = (branch) => ["pr", "view", branch, "--json", "url,state,number,headRefOid"];
export function parsePr(text) {
  try { const p = JSON.parse(text); return p?.url ? { url: p.url, state: String(p.state ?? "").toUpperCase(), number: p.number ?? prNumber(p.url), headOid: p.headRefOid || undefined } : null; } catch { return null; }
}
