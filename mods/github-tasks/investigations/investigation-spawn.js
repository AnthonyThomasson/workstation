// What a New Task session (an Investigation, investigations.js) gives its agent so it can start helpers: investigators, which
// read the session's worktree, and prototype workers, which build a throwaway in a worktree of their own. Pure: no Herdr imports,
// so node --test runs it. Like a ticket run's spawn script (run.js), the script is the only way they start, so each gets its
// role's agent, model, permissions and labels whatever the agent types. investigations.js writes the session folder (this
// module says what is in it); investigation-agents.js lists the helpers on the session's page by the labels set here.
import { groomArgv } from "../lib/index.js";
import { CUSTOM } from "../workflow/index.js";
import { FOLDER_LABEL, NAME_LABEL, ROLE_LABEL, agentArgv, readOnlyArgv, shQuote } from "../runs/index.js";

export const INVESTIGATION_LABEL = "herdr.investigation"; // on the session's agent and on each of its helpers: the session's id

// The session's folder, ~/.herdr/investigations/<id>/, which holds its spawn script and prompts: null unless the id is an
// investigation's own (inv-<base 36>), so nothing outside ~/.herdr/investigations can ever be named. The one helper for the folder: the
// start path writes it (and takes it back if the start fails) and Done removes it. `home` is passed in to keep this pure.
export function sessionFolder(home, id) {
  if (!/^inv-[a-z0-9]+$/.test(String(id ?? "")) || !String(home ?? "").replace(/\/+$/, "")) return null;
  return `${String(home).replace(/\/+$/, "")}/.herdr/investigations/${id}`;
}

// What the New Task Orchestrator may run without asking, in Claude's terms: the spawn script and the hc commands it needs to hear from
// its helpers and end them. Bare `hc run` is left out: it would run anything.
export const NEW_TASK_PLUMBING = (dir) => [`Bash(${dir}/spawn:*)`, "Bash(hc send:*)", "Bash(hc read:*)", "Bash(hc wait:*)", "Bash(hc ls:*)", "Bash(hc kill:*)"];

// An investigator's or prototype worker's command, from its settings ({ agent, model, effort }, as normalizeSubAgent leaves them) and
// the agents the core knows (`known`, knownAgents(); an agent not listed runs as its own name). `dir` is the session folder, which both may read.
// An investigator is read-only (run.js readOnlyArgv) in auto mode; a worker has run.js's worker command in auto mode too, and may edit.
export function subAgentArgv(role, settings, known, dir) {
  const own = { ...settings, permissions: "auto" };
  const base = (known ?? []).find((a) => a.key === settings.agent)?.run;
  return role === "investigator" ? readOnlyArgv(own, base, dir) : agentArgv("worker", own, base, dir);
}

// The New Task Orchestrator's command: the one New Task always opened (model.js groomArgv) and, when it is Claude and has a session folder,
// the right to run that folder's spawn script and hc. Nothing else is restricted.
export function newTaskAgentArgv(agent, groomer, dir) {
  const argv = groomArgv(agent.key, agent.run, groomer ?? {});
  // --add-dir and --allowedTools take any number of values, so they come last, with nothing after them.
  if (agent.key === "claude" && dir) argv.push("--add-dir", dir, "--allowedTools", ...NEW_TASK_PLUMBING(dir));
  return argv;
}

// The Refactor Orchestrator's command, from its refactor type's orchestrator ({ agent, command, model, effort }, as normalizeRole leaves it)
// and the agents the core knows (`known`): what newTaskAgentArgv gives the New Task Orchestrator, with the type's own settings instead of the
// New Task ones. A custom agent runs its command as it is.
export function refactorAgentArgv(orchestrator, known, dir) {
  const { agent, command, model, effort } = orchestrator;
  if (agent === CUSTOM) return ["sh", "-c", command];
  return newTaskAgentArgv({ key: agent, run: (known ?? []).find((a) => a.key === agent)?.run }, { model, effort }, dir);
}

// Which session a helper's prompt is for: "Refactor" in a refactor session, else "New Task".
const sessionKind = (refactor) => (refactor ? "Refactor" : "New Task");

// The refactor type's own prompt for a role, after the built-in text; nothing added when it has none.
const withRolePrompt = (text, rolePrompt) => (String(rolePrompt ?? "").trim() ? `${text}\n\n## This refactor's instructions\n\n${String(rolePrompt).trim()}` : text);

// A prompt's body is exactly three sentences, as run.js's are (run.test.js counts them), then a short list of mechanics.
export function newTaskInvestigatorPrompt({ workDir, repoRoot, branch, refactor = false, rolePrompt = "" }) {
  const who = sessionKind(refactor);
  return withRolePrompt([
    `# You are an investigator for a ${who} session`, "",
    `Investigate read-only: edit nothing, commit nothing and check out no other commit. Explore the session worktree to answer the ${who} Orchestrator's brief, saying what you found with its file, line and proof. Send your findings to it with \`hc send\` and as your last message, then stay available for follow-up questions.`, "",
    `- You work in the session worktree ${workDir} on ${branch}, the same one as the ${who} Orchestrator; read and search it freely, see an old file with \`git show <commit>:<path>\`, and run the repo's tests if that helps.`,
    "- Never push, merge or open a pull request.",
    `- Stay out of the main checkout ${repoRoot}, and don't start other agents.`,
  ].join("\n"), rolePrompt);
}

export function newTaskWorkerPrompt({ workDir, repoRoot, branch, refactor = false, rolePrompt = "" }) {
  const who = sessionKind(refactor);
  return withRolePrompt([
    `# You are a prototype worker for a ${who} session`, "",
    `Build a throwaway prototype of what the ${who} Orchestrator's brief asks, in your own worktree, so it can find out whether the idea works. Commit as you go, never push, merge or open a pull request, and when you are done send the ${who} Orchestrator what you built, your commits and what you learned with \`hc send\`. Your code is discarded when the person presses Done and never becomes the ticket's work, so build only as much as answers the brief.`, "",
    `- You start in your own worktree, whose path ends in \`--\` and your job's name (it begins with ${workDir}) and which is on a branch that ends the same way (it begins with ${branch}), cut from the session branch ${branch}; leave the session worktree ${workDir} and the main checkout ${repoRoot} alone.`,
    "- Don't start other agents.",
  ].join("\n"), rolePrompt);
}

// The files of a session's folder, by name: what the spawn script needs (the sub-agents' commands in argv: { investigator, worker })
// and the two prompts the helpers are told to read. `refactor` ({ investigator, worker }: the refactor type's own prompt for each role, or
// "") is set in a refactor session, whose helpers answer to the Refactor Orchestrator and read their type's prompt after the built-in text.
export function sessionFiles({ id, dir, workDir, repoRoot, branch, argv, refactor = null }) {
  const place = { workDir, repoRoot, branch, refactor: Boolean(refactor) };
  return {
    spawn: investigationSpawnScript({ id, dir, workDir, branch, argv, refactor: Boolean(refactor) }),
    "investigator.md": newTaskInvestigatorPrompt({ ...place, rolePrompt: refactor?.investigator }),
    "worker.md": newTaskWorkerPrompt({ ...place, rolePrompt: refactor?.worker }),
  };
}

// The only way a session's helpers start (a sibling of run.js's spawnScript, whose ticket run it leaves alone). It waits for the
// agent to be ready before giving it its brief: a send to one still booting can be lost.
// workDir: the session's worktree, on `branch` (investigate/...); a worker's goes beside it as `<workDir>--<job>` on `<branch>--<job>`.
// A terminal is named `<id>-<name>`, at most 32 long, and labelled with the session's id, its role, its name and its folder.
export function investigationSpawnScript({ id, dir, workDir, branch, argv, refactor = false }) {
  const who = sessionKind(refactor);
  const roleArgs = (role) => `  ${role}) set -- ${argv[role].map(shQuote).join(" ")} ;;`;
  const room = Math.max(1, 32 - id.length - 1);
  return `#!/bin/sh
# Starts an investigator or a prototype worker for ${who} session ${id}. Usage:
#   spawn investigator <name> <brief>   explores the session's worktree read-only, and reports back
#   spawn worker <job> <brief>          builds a throwaway prototype in its own worktree and branch (made, or used again), and reports back
set -u
session_id=${shQuote(id)}
session_dir=${shQuote(dir)}
work_dir=${shQuote(workDir)}
session_branch=${shQuote(branch)}
usage() {
  echo "usage: spawn worker <job> <brief>" >&2
  echo "       spawn investigator <name> <brief>" >&2
  exit 2
}
# a name as it goes in a branch and a folder: lower-case letters, digits, _ and -, runs of anything else becoming one -
clean() { printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9_-' '-' | sed 's/^-*//; s/-*$//'; }
[ $# -eq 3 ] || usage
role=$1 a2=$2 brief=$3 # the agent's command below takes the place of the arguments
case "$role" in
${roleArgs("investigator")}
${roleArgs("worker")}
  *) echo "spawn: the role must be investigator or worker, not $role" >&2; exit 2 ;;
esac
if [ "$role" = worker ]; then
  job=$(clean "$a2" | cut -c1-40 | sed 's/-*$//')
  name=$(printf '%s' "$job" | cut -c1-${room} | sed 's/-*$//') # the terminal's name, which is shorter
else
  name=$(clean "$a2" | cut -c1-${room} | sed 's/-*$//')
  job=$name
fi
if [ -z "$name" ]; then echo "spawn: the name needs a letter or a number" >&2; exit 2; fi
if [ -z "$job" ]; then echo "spawn: the job needs a letter or a number" >&2; exit 2; fi
if [ ! -e "$work_dir/.git" ]; then echo "spawn: the session's worktree $work_dir is gone" >&2; exit 1; fi
if [ "$role" = worker ]; then
  job_dir="$work_dir--$job"
  job_branch="$session_branch--$job"
  if [ -e "$job_dir/.git" ]; then
    now=$(git -C "$job_dir" branch --show-current)
    if [ "$now" != "$job_branch" ]; then echo "spawn: $job_dir is on '$now', not $job_branch" >&2; exit 1; fi
  elif [ -e "$job_dir" ]; then
    echo "spawn: $job_dir exists and is not a worktree" >&2; exit 1
  elif git -C "$work_dir" show-ref --verify --quiet "refs/heads/$job_branch"; then
    git -C "$work_dir" worktree add "$job_dir" "$job_branch" >&2 || { echo "spawn: could not make a worktree at $job_dir" >&2; exit 1; }
  else
    git -C "$work_dir" worktree add -b "$job_branch" "$job_dir" "$session_branch" >&2 || { echo "spawn: could not make a worktree at $job_dir" >&2; exit 1; }
  fi
  cwd=$job_dir
else
  cwd=$work_dir
fi
term="$session_id-$name"
hc run --bg --name "$term" --cwd "$cwd" --label "${INVESTIGATION_LABEL}=$session_id" --label "${ROLE_LABEL}=$role" --label "${NAME_LABEL}=$name" --label "${FOLDER_LABEL}=$cwd" -- "$@" >/dev/null || { echo "spawn: could not start $term" >&2; exit 1; }
hc wait "$term" --timeout 60 >/dev/null 2>&1 || true
message="Read $session_dir/$role.md and follow it. The ${who} Orchestrator that started you is the terminal \${HC_TERMINAL_ID:-that started you}; reach it with hc send.

Your brief:

$brief"
if ! hc send "$term" "$message" >/dev/null; then
  echo "spawn: started $term, but it did not take its brief. It may be at a dialog: check it with hc read $term, then hc send it the brief." >&2; exit 1
fi
echo "$term"
`;
}
