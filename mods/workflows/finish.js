// What the run page does when the person is done: move the ticket along, merge the worktree, open a pull request.
// Pure: no Herdr imports, so node --test runs it. run.js does the exec calls and the drawing.

// Status names match ignoring case, spaces and punctuation ("In Progress", "in-progress", "InProgress").
// A copy of github-tasks/model.js's statusKey (a mod cannot import another mod).
export const statusKey = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export const STAGES = ["in progress", "in review"]; // what a ticket becomes as the run goes on, in order

// The stage the run has reached: 0 nothing yet, 1 a worker started, 2 a reviewer started.
// agents: { workers, reviewers }, with every agent seen (the ones that ended too).
export const stageOf = (agents) => (agents.reviewers?.length ? 2 : agents.workers?.length ? 1 : 0);

// Finish needs review to have started, every reviewer ended, and no worker still working.
// Idle or done workers may stay live without holding up the run.
export const canFinish = ({ stage, workers = [], reviewers = [] }) =>
  stage >= 2 && !reviewers.some((r) => r.live) && !workers.some((w) => w.status === "working");

// The project's Status option for a stage, or null when the project has none by that name.
// statuses: { inProgress, inReview } as configured in Tasks; absent (old runs) means the defaults in STAGES.
export function optionFor(options, stage, statuses) {
  const name = (stage === 1 ? statuses?.inProgress : statuses?.inReview) || STAGES[stage - 1];
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

// A merge's steps in order, as git args after `git`. Each is { args, fail }: fail is what to say when it fails.
// The caller has already found the default branch (base). onBase: the repo's own folder is on it, clean.
export function mergeSteps({ repoRoot, workDir, branch, base }) {
  return [
    { args: ["-C", workDir, "status", "--porcelain"], fail: "", dirty: `${workDir} has uncommitted changes. Commit or discard them first.` },
    { args: ["-C", repoRoot, "status", "--porcelain"], fail: "", dirty: `${repoRoot} has uncommitted changes, so ${branch} can't be merged into ${base} there.` },
    { args: ["-C", repoRoot, "switch", base], fail: `Couldn't switch ${repoRoot} to ${base}.` },
    { args: ["-C", repoRoot, "merge", "--no-edit", branch], fail: `${branch} didn't merge into ${base}.`, abort: ["-C", repoRoot, "merge", "--abort"] },
    { args: ["-C", repoRoot, "worktree", "remove", workDir], fail: `${branch} is merged, but the worktree ${workDir} couldn't be removed.` },
    { args: ["-C", repoRoot, "branch", "-d", branch], fail: `${branch} is merged, but the branch couldn't be deleted.` },
  ];
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

// Finish for a branch run, once its pull request is merged: leave the branch, then delete it locally.
// -D because a squash merge leaves the branch looking unmerged to git; the PR being merged is what proves it.
export function branchFinishSteps({ repoRoot, branch, base }) {
  return [
    { args: ["-C", repoRoot, "status", "--porcelain"], fail: "", dirty: `${repoRoot} has uncommitted changes. Commit or discard them first.` },
    { args: ["-C", repoRoot, "switch", base], fail: `Couldn't switch ${repoRoot} to ${base}.` },
    { args: ["-C", repoRoot, "branch", "-D", branch], fail: `Couldn't delete the local branch ${branch}.` },
  ];
}
