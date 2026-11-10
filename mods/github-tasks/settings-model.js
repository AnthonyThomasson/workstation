// Pure state and prompt selection for the Task settings sections and their read-only prompt tabs.
import { newTaskPrompt, spelled, STATUSES } from "./model.js";
import { localNewTaskPrompt } from "./local-ui.js";
import { orchestratorPrompt, workerPrompt, reviewerPrompt, investigatorPrompt } from "./run.js";
import { newTaskInvestigatorPrompt, newTaskWorkerPrompt } from "./investigation-spawn.js";

// All five sections start closed; only explicit booleans for known sections survive a reload.
export function normalizeSettingsSections(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  return Object.fromEntries(["newTask", "orchestrator", "worker", "reviewer", "investigator"].map((role) => [role, value[role] === true]));
}

// local: { mainRoot, todoDir, upNextDir } when the repo's tasks are local files; the id is a placeholder, as a run's are.
// "newTask" is the New Task agent's; "newTaskInvestigator" and "newTaskWorker" are what its investigators and prototype workers read.
export function promptForRole(role, { repo = "", project = null, options = [], local = null } = {}) {
  if (role === "newTask" && local) return localNewTaskPrompt({ ...local, nextId: "<next id>", agentsDir: SESSION_FOLDER });
  if (role === "newTask") {
    return newTaskPrompt({ repo, project, backlog: spelled(options, STATUSES.backlog), groomed: spelled(options, STATUSES.groomed), agentsDir: SESSION_FOLDER });
  }
  if (role === "newTaskInvestigator") return newTaskInvestigatorPrompt(SESSION);
  if (role === "newTaskWorker") return newTaskWorkerPrompt(SESSION);
  const build = { orchestrator: orchestratorPrompt, worker: workerPrompt, reviewer: reviewerPrompt, investigator: investigatorPrompt }[role];
  return build ? clean(build(SAMPLE)).trim() : null;
}

// What a session fills in: its folder, worktree and branch are placeholders, as a run's are.
const SESSION_FOLDER = "<session folder>";
const SESSION = { dir: SESSION_FOLDER, workDir: "<session worktree>", repoRoot: "<main checkout>", branch: "<session branch>" };

// What a run fills in, shown as it is in the built-in prompts' own words.
const SAMPLE = {
  id: "0-mw8f0o2j",
  workflow: {
    name: "<workflow name>",
    orchestrator: { planning: "<the workflow's planning prompt goes here>", retro: "<the workflow's retro prompt goes here>", prompt: "<the workflow's orchestrator prompt goes here>" },
    worker: { prompt: "<the workflow's worker prompt goes here>" },
    reviewer: { prompt: "<the workflow's reviewer prompt goes here>" },
    investigator: { prompt: "<the workflow's investigator prompt goes here>" },
  },
  ticket: { number: 0, title: "<ticket title>" },
  repo: "<owner/repo>", runDir: "<run folder>", workDir: "<ticket worktree>", repoRoot: "<main checkout>", branch: "<branch>",
};
const clean = (text) => text.replace(/#0 <ticket title>/g, "<ticket>");

// Placeholders are text, not HTML. Inline code and fenced blocks stay as they are so their Markdown still works.
export function markdownLiteral(text) {
  return String(text ?? "").split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, "\\<").replace(/&(?=#?\w+;)/g, "\\&"))).join("");
}
