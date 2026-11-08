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

// Merge, Create PR and the automatic pull request wait for the final review to have started and every worker and reviewer to have ended.
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
//   status        the ticket Done    remove-worktree / prune-worktrees    delete-branch (-D: a squash leaves the branch looking unmerged)    remove-run-files
// number: the pull request's number. prMerged: the caller has just asked gh and the pull request is already MERGED, so the
// merge step is skipped, and so are fetch and ahead (GitHub may have deleted the remote branch, and the work is already in).
// status: { args } to set the ticket Done, { warn } when the project has no such option, or nothing when there is no project.
// workDirExists / branchExists: false when an earlier Merge already removed the folder / deleted the branch; the steps for
// them are left out, so pressing Merge again finishes what was left.
// Only a child of a .herdr/workflow-runs folder can be removed. In particular, never rm the parent or a path
// reached through a run id containing traversal; Merge builds this path from home() and the run id.
const safeRunDir = (runDir) => {
  const id = typeof runDir === "string" ? runDir.match(/^\/(?:.*\/)?\.herdr\/workflow-runs\/([^/]+)$/)?.[1] : null;
  return Boolean(id && id !== "." && !id.includes(".."));
};

export function mergeSteps({ repoRoot, workDir, branch, number, prMerged = false, status, runDir, workDirExists = true, branchExists = true }) {
  if (!prMerged && !number) throw new Error("Merge needs the pull request, and this run has none.");
  const git = (args) => ({ cmd: "git", args });
  const inTree = workDirExists ? workDir : repoRoot; // where the remote is asked: the ticket worktree, else the repo's git dir (no checkout is touched)
  const remote = `origin/${branch}`;
  return [
    ...(workDirExists ? [{ name: "tree-status", ...git(["-C", workDir, "status", "--porcelain"]), fail: `Couldn't look at ${workDir}.`,
      dirty: `${workDir} has uncommitted changes. Commit or discard them (and push, so the pull request has them), then press Merge again.` }] : []),
    ...(branchExists && !prMerged ? [
      { name: "fetch", ...git(["-C", inTree, "fetch", "origin", branch]), fail: `Couldn't fetch ${branch} from origin.` },
      { name: "ahead", ...git(["-C", inTree, "rev-list", `${remote}..${branch}`]), fail: `Couldn't compare ${branch} with ${remote}.`,
        dirty: `${branch} has commits that ${remote} doesn't. Push them so the pull request has them, then press Merge again.` },
    ] : []),
    ...(prMerged ? [] : [{ name: "pr-merge", cmd: "gh", args: ["pr", "merge", String(number), "--squash"], cwd: inTree, fail: `GitHub didn't merge pull request #${number}.`, done: `merged pull request #${number}` }]),
    ...(status ? [status.warn ? { name: "status", warn: status.warn } : { name: "status", cmd: "gh", args: status.args, fail: "Couldn't set the ticket's status.", done: "set the ticket's status" }] : []),
    ...(workDirExists ? [{ name: "remove-worktree", ...git(["-C", repoRoot, "worktree", "remove", workDir]), fail: `Couldn't remove the worktree ${workDir}.`, done: `removed the worktree ${workDir}` }]
      : [{ name: "prune-worktrees", ...git(["-C", repoRoot, "worktree", "prune"]), fail: `Couldn't clear the removed worktree ${workDir} from git's list.` }]),
    ...(branchExists ? [{ name: "delete-branch", ...git(["-C", repoRoot, "branch", "-D", branch]), fail: `Couldn't delete the branch ${branch}.`, done: `deleted ${branch}` }] : []),
    ...(safeRunDir(runDir) ? [{ name: "remove-run-files", cmd: "rm", args: ["-rf", runDir], fail: `Couldn't remove the run files ${runDir}.`, done: `removed the run files ${runDir}` }] : []),
  ];
}

// Whether the page should open the pull request by itself now: once per run (tried is saved in shared state before the
// attempt, so a reload or a failure doesn't try again), when Merge would be allowed and the run has no pull request yet.
export const shouldAutoPr = ({ ready, pr, tried, busy }) => Boolean(ready) && !pr && !tried && !busy;

// Runs steps with exec(cmd, args, opts) -> { code, stdout, stderr }. Resolves { done, warnings } with what happened and
// what was said on the way; throws an Error at the first step that fails, saying which earlier steps already happened.
export async function runSteps(steps, exec) {
  const done = [], warnings = [];
  const text = (r) => String(r.stderr || r.stdout || "").trim();
  const stop = (message) => { throw new Error(done.length ? `${message} Already done: ${done.join(", ")}.` : message); };
  const go = async (list) => {
    for (const st of list) {
      if (st.warn) { warnings.push(st.warn); continue; }
      const r = await exec(st.cmd, st.args, st.cwd ? { cwd: st.cwd } : undefined);
      if (st.dirty) { if (r.code !== 0) stop(`${st.fail} ${text(r)}`.trim()); if (String(r.stdout ?? "").trim()) stop(st.dirty); continue; }
      if (r.code !== 0) stop(`${st.fail} ${text(r)}`.trim());
      if (st.done) done.push(st.done);
    }
  };
  await go(steps);
  return { done, warnings };
}

// gh args for the pull request; the body links the ticket when it has a number.
export function prArgs({ branch, title, number }) {
  return ["pr", "create", "--head", branch, "--title", number ? `#${number} ${title}` : title, "--body", number ? `Closes #${number}` : ""];
}

// The pull request's URL from what gh printed, or null.
export const parsePrUrl = (text) => String(text ?? "").match(/https:\/\/\S+\/pull\/\d+/)?.[0] ?? null;
export const prNumber = (url) => url?.match(/\/pull\/(\d+)/)?.[1] ?? null;

// gh args that say where the branch's pull request stands: prints JSON { url, state, number }.
export const prViewArgs = (branch) => ["pr", "view", branch, "--json", "url,state,number"];
export function parsePr(text) {
  try { const p = JSON.parse(text); return p?.url ? { url: p.url, state: String(p.state ?? "").toUpperCase(), number: p.number ?? prNumber(p.url) } : null; } catch { return null; }
}
