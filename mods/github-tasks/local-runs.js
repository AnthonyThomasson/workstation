// Runs in local mode (a task kept as a YAML file, see local-tasks.js): the run page moves the task's file as the run goes on,
// the pull request describes the task, and a repo with no GitHub remote gets a local squash Merge. Pure: no Herdr imports,
// so node --test runs it; run-page.js does the exec calls and the drawing. Nothing here pushes, and git is never run on a task file.
import { STAGES, cleanupSteps, statusStep } from "./finish.js";

// The task's file goes to the folder of the stage the run reached: 1 In Progress, 2 In Review, 3 Done (Merge sets that one).
// tasks: makeLocalTasks(...). Resolves the moved task; rejects with a message that can be shown (no such task, a file in the way).
export function moveToStage(tasks, id, stage) {
  const status = STAGES[stage - 1];
  if (!status) return Promise.reject(new Error(`There is no stage ${stage}.`));
  return tasks.move(id, status);
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// The pull request body for a local task: no `Closes #N`, as there is no GitHub issue to close, and no `#N` at all, which GitHub would link to an unrelated issue.
// task: { id, title, description, labels } or null (then fallback: { id, title }).
export function localPrBody(task, fallback = {}) {
  const t = task ?? fallback;
  const description = String(t.description ?? "").trim();
  return [
    `Local task ${t.id}: ${oneLine(t.title)}`, // no #: GitHub would link it to an unrelated issue
    ...(description ? ["", description] : []),
    ...(t.labels?.length ? ["", `Labels: ${t.labels.join(", ")}`] : []),
  ].join("\n");
}

// The squash commit's message.
export const squashMessage = (title, id) => `${oneLine(title)} (#${id})`;

// The repo's default branch, for a repo that may have no remote: origin's HEAD when it has one, else the local main or master,
// else init.defaultBranch when that branch exists here, else null. git: (cwd, ...args) => Promise<{ code, stdout, stderr }>.
export async function defaultBranchOf(git, repoRoot) {
  const head = await git(repoRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => null);
  const remote = head?.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : "";
  if (remote) return remote;
  const has = async (name) => (await git(repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`).catch(() => null))?.code === 0;
  const configured = await git(repoRoot, "config", "--get", "init.defaultBranch").catch(() => null);
  for (const name of ["main", "master", configured?.code === 0 ? configured.stdout.trim() : ""]) {
    if (name && await has(name)) return name;
  }
  return null;
}

// Whether `git status --porcelain` shows a staged change (a letter in the first column; ?? and !! are not).
const stagedIn = (stdout) => String(stdout).split("\n").some((l) => /^[MADRCTU]/.test(l));

const list = (stdout, max = 8) => {
  const lines = String(stdout).split("\n").map((l) => l.trimEnd()).filter(Boolean);
  return lines.slice(0, max).map((l) => `  ${l}`).join("\n") + (lines.length > max ? `\n  … and ${lines.length - max} more` : "");
};

// Merge with no GitHub remote, as a list of steps for finish.js runSteps. The work goes into the main checkout as one commit;
// no pull request, no push, no fetch. In order:
//   tree-status   the ticket worktree has no uncommitted changes (nothing is committed for the person)
//   main-branch   the main checkout is on the default branch      main-status   and has no uncommitted changes
//     These three only look. If any fails, nothing has changed and nothing after it runs.
//   squash        git merge --squash <branch> in the main checkout. On a conflict the files are read, then `git reset --merge` puts
//                 the main checkout back as it was; the error lists the files and nothing is cleaned up
//   commit        '<title> (#<id>)' (message). Nothing staged means an earlier Merge already committed it, so there is no second
//                 commit; a commit that fails puts the main checkout back too
//   status        the task goes to done/ ({ move }, { warn } when the task is gone, or nothing)
//   remove-worktree / prune-worktrees    delete-branch (-D: a squash leaves the branch looking unmerged)    remove-run-files
// defaultBranch: defaultBranchOf. workDirExists / branchExists: false when an earlier Merge already removed the folder / branch
// (the steps for them are left out; with the branch gone the work is in already, so only the task and the cleanup remain).
export function localMergeSteps({ repoRoot, workDir, branch, defaultBranch, message, status, runDir, workDirExists = true, branchExists = true }) {
  if (branchExists && !defaultBranch) throw new Error(`Couldn't tell the default branch of ${repoRoot} (there is no origin, main or master). Nothing was merged.`);
  const git = (args) => ({ cmd: "git", args });
  const back = async (exec) => {
    const r = await exec("git", ["-C", repoRoot, "reset", "--merge"]);
    return r.code === 0 ? null : String(r.stderr || r.stdout || "").trim() || `exit code ${r.code}`;
  };
  const put = async (exec, why) => {
    const failed = await back(exec);
    return failed ? `${why} Couldn't put the main checkout back as it was (git reset --merge said: ${failed}). Look at ${repoRoot} before going on.`
      : `${why} The main checkout is back as it was.`;
  };
  const checks = [
    ...(workDirExists ? [{ name: "tree-status", ...git(["-C", workDir, "status", "--porcelain"]), fail: `Couldn't look at ${workDir}.`,
      check: (out) => out.trim() ? `${workDir} has uncommitted changes:\n${list(out)}\nCommit or discard them, then press Merge again.` : null }] : []),
    { name: "main-branch", ...git(["-C", repoRoot, "branch", "--show-current"]), fail: `Couldn't look at ${repoRoot}.`,
      check: (out) => out.trim() === defaultBranch ? null : `The main checkout ${repoRoot} is on ${out.trim() || "no branch (a detached HEAD)"}, not ${defaultBranch}. Switch it to ${defaultBranch}, then press Merge again. Nothing was merged.` },
    { name: "main-status", ...git(["-C", repoRoot, "status", "--porcelain"]), fail: `Couldn't look at ${repoRoot}.`,
      check: (out) => out.trim() ? `The main checkout ${repoRoot} has uncommitted changes:\n${list(out)}\nCommit or discard them, then press Merge again.${stagedIn(out) ? " Some are staged: commit them, or drop them with `git reset --merge`." : ""} Nothing was merged.` : null },
  ];
  const merge = [
    {
      name: "squash",
      async run(exec) {
        const r = await exec("git", ["-C", repoRoot, "merge", "--squash", branch]);
        if (r.code === 0) return;
        const said = String(r.stderr || r.stdout || "").trim();
        const files = await exec("git", ["-C", repoRoot, "diff", "--name-only", "--diff-filter=U"]); // before reset --merge throws the conflict away
        const named = list(files.stdout ?? "");
        throw new Error(await put(exec, named
          ? `Merging ${branch} into ${defaultBranch} conflicts in:\n${named}\nNothing was cleaned up. Have the work rebased onto ${defaultBranch} in ${workDir} and the conflicts resolved, then press Merge again.`
          : `git couldn't squash ${branch} into ${defaultBranch}: ${said}`));
      },
    },
    {
      name: "commit", // resolves what was done: nothing staged means the branch had nothing new (or an earlier Merge already committed it)
      async run(exec) {
        const staged = await exec("git", ["-C", repoRoot, "diff", "--cached", "--quiet"]); // 0: nothing staged, 1: something is
        if (staged.code === 0) return `nothing new to merge from ${branch}`;
        if (staged.code !== 1) throw new Error(await put(exec, `Couldn't look at what the squash staged in ${repoRoot}: ${String(staged.stderr || staged.stdout || "").trim()}`));
        const r = await exec("git", ["-C", repoRoot, "commit", "-q", "-m", message]);
        if (r.code !== 0) throw new Error(await put(exec, `Couldn't commit the merge in ${repoRoot}: ${String(r.stderr || r.stdout || "").trim()}`));
        return `merged ${branch} into ${defaultBranch}`;
      },
    },
  ];
  return [
    ...(branchExists ? [...checks, ...merge] : []),
    ...(status ? [statusStep(status)] : []),
    ...cleanupSteps({ repoRoot, workDir, branch, runDir, workDirExists, branchExists }),
  ];
}
