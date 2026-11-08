// What the run page does when the person is done: move the ticket along, merge the ticket branch, open a pull request.
// Pure: no Herdr imports, so node --test runs it. run.js does the exec calls and the drawing.

// Status names match ignoring case, spaces and punctuation ("In Progress", "in-progress", "InProgress").
// A copy of github-tasks/model.js's statusKey (a mod cannot import another mod).
export const statusKey = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export const STAGES = ["In Progress", "In Review", "Done"]; // what a ticket becomes as the run goes on, in order (Done is set by Merge)

// The stage the run has reached: 0 nothing yet, 1 a worker started, 2 a reviewer started.
// agents: { workers, reviewers }, with every agent seen (the ones that ended too).
export const stageOf = (agents) => (agents.reviewers?.length ? 2 : agents.workers?.length ? 1 : 0);

// Whether a final reviewer has shown up: in the rows seen (the ones that ended too) or in what the page saved, so a restart
// keeps it. saved: the value kept in shared state, any of 1, "1" or nothing.
export const finalSeen = ({ reviewers = [], saved } = {}) => reviewers.some((r) => r.final) || Boolean(Number(saved));

// Merge and Create PR wait for the final review to have started and every worker and reviewer to have ended.
export const canMerge = ({ finalSeen: seen, workers = [], reviewers = [] }) =>
  Boolean(seen) && !workers.some((w) => w.live) && !reviewers.some((r) => r.live);

// The project's Status option for a stage, or null when the project has none by that name.
// stage 3 is Done.
export function optionFor(options, stage) {
  const name = STAGES[stage - 1];
  return (options ?? []).find((o) => statusKey(o.name) === statusKey(name)) ?? null;
}

export const STATUS_MUTATION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
}`;

// gh args that set the item's status to the option.
export const statusArgs = ({ projectId, itemId, fieldId, optionId }) =>
  ["api", "graphql", "-f", `query=${STATUS_MUTATION}`, "-f", `project=${projectId}`, "-f", `item=${itemId}`, "-f", `field=${fieldId}`, "-f", `option=${optionId}`];

// "origin/main" -> "main"; null when git had nothing to say.
export const defaultBranch = (symbolicRef) => String(symbolicRef ?? "").trim().replace(/^origin\//, "") || null;

// gh/git args that say whether the ticket worktree folder is still there, and whether the ticket branch still is
// (exit code 0 means yes). Merge can be pressed again after a partial failure, so it asks before each part.
export const worktreeArgs = (workDir) => ["-C", workDir, "rev-parse", "--git-dir"];
export const branchArgs = (repoRoot, branch) => ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`];

// A push that origin turned away because it has moved on.
const PUSH_REJECTED = /rejected|non-fast-forward|fetch first|failed to push some refs/i;

// Merge as a list of steps, in order. A step is { name, cmd, args, cwd?, fail, hint?, done?, abort?, dirty?, ifOutput?, warn? }:
//   fail   what to say when it fails; hint { when, say }: also say this when its output matches when; done  what to call it once it has happened ("Already done: ...")
//   abort  { cmd, args } to run when it fails    dirty  stop with this when its output is not empty (a check)
//   ifOutput  steps to run only when its output is not empty    warn  not run: runSteps passes this on as a warning
// The caller has already found the default branch (base). status: { args } to set the ticket Done, { warn } when the
// project has no such option, or nothing when there is no project to set it in. number: the issue to close, if any.
// workDirExists / branchExists: false when an earlier Merge already removed the folder / merged and deleted the branch;
// the steps for them are left out, so pressing Merge again finishes what was left.
// Only a child of a .herdr/workflow-runs folder can be removed. In particular, never rm the parent or a path
// reached through a run id containing traversal; Merge builds this path from home() and the run id.
const safeRunDir = (runDir) => {
  const id = typeof runDir === "string" ? runDir.match(/^\/(?:.*\/)?\.herdr\/workflow-runs\/([^/]+)$/)?.[1] : null;
  return Boolean(id && id !== "." && !id.includes(".."));
};

export function mergeSteps({ repoRoot, workDir, branch, base, number, status, runDir, workDirExists = true, branchExists = true }) {
  const git = (args) => ({ cmd: "git", args });
  return [
    ...(workDirExists ? [{ name: "tree-status", ...git(["-C", workDir, "status", "--porcelain"]), fail: `Couldn't look at ${workDir}.`,
      ifOutput: [
        { name: "commit-add", ...git(["-C", workDir, "add", "-A"]), fail: `Couldn't stage the changes left in ${workDir}.` },
        { name: "commit", ...git(["-C", workDir, "commit", "-m", `Commit what was left in the worktree${number ? ` (#${number})` : ""}`]), fail: `Couldn't commit the changes left in ${workDir}.`, done: `committed what was left in ${workDir}` },
      ] }] : []),
    { name: "repo-clean", ...git(["-C", repoRoot, "status", "--porcelain"]), fail: `Couldn't look at ${repoRoot}.`, dirty: `${repoRoot} has uncommitted changes, so ${branch} can't be merged into ${base} there.` },
    { name: "switch", ...git(["-C", repoRoot, "switch", base]), fail: `Couldn't switch ${repoRoot} to ${base}.`, done: `switched ${repoRoot} to ${base}` },
    ...(branchExists ? [{ name: "merge", ...git(["-C", repoRoot, "merge", "--no-edit", branch]), fail: `${branch} didn't merge into ${base} (the merge was aborted).`, abort: git(["-C", repoRoot, "merge", "--abort"]), done: `merged ${branch} into ${base}` }] : []),
    { name: "push", ...git(["-C", repoRoot, "push", "origin", base]), fail: `${base} didn't push to origin.`, done: `pushed ${base} to origin`,
      hint: { when: PUSH_REJECTED, say: `The merge is done locally. Update ${base} from origin in ${repoRoot}, then press Merge again.` } },
    ...(status ? [status.warn ? { name: "status", warn: status.warn } : { name: "status", cmd: "gh", args: status.args, fail: "Couldn't set the ticket's status.", done: "set the ticket's status" }] : []),
    ...(number ? [{ name: "close-issue", cmd: "gh", args: ["issue", "close", String(number)], cwd: repoRoot, fail: `Couldn't close issue #${number}.`, done: `closed issue #${number}` }] : []),
    ...(workDirExists ? [{ name: "remove-worktree", ...git(["-C", repoRoot, "worktree", "remove", workDir]), fail: `Couldn't remove the worktree ${workDir}.`, done: `removed the worktree ${workDir}` }]
      : [{ name: "prune-worktrees", ...git(["-C", repoRoot, "worktree", "prune"]), fail: `Couldn't clear the removed worktree ${workDir} from git's list.` }]),
    ...(branchExists ? [{ name: "delete-branch", ...git(["-C", repoRoot, "branch", "-d", branch]), fail: `Couldn't delete the branch ${branch}.`, done: `deleted ${branch}` }] : []),
    ...(safeRunDir(runDir) ? [{ name: "remove-run-files", cmd: "rm", args: ["-rf", runDir], fail: `Couldn't remove the run files ${runDir}.`, done: `removed the run files ${runDir}` }] : []),
  ];
}

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
      if (r.code !== 0) {
        if (st.abort) await exec(st.abort.cmd, st.abort.args);
        stop(`${st.fail} ${text(r)} ${st.hint?.when.test(text(r)) ? st.hint.say : ""}`.replace(/ +/g, " ").trim());
      }
      if (st.done) done.push(st.done);
      if (st.ifOutput && String(r.stdout ?? "").trim()) await go(st.ifOutput);
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
