// Pure state and prompt selection for the Task settings sections and their read-only prompt tabs.
import { newTaskPrompt, refactorPrompt, spelled, STATUSES } from "./lib/index.js";
import { localNewTaskPrompt, localRefactorPrompt } from "./local-ui.js";
import { orchestratorPrompt, workerPrompt, reviewerPrompt, investigatorPrompt } from "./run.js";
import { newTaskInvestigatorPrompt, newTaskWorkerPrompt } from "./investigation-spawn.js";

// The agent sections of Task settings, grouped by who starts them. Entries don't repeat their group's word, so the Task
// Orchestrator is "Task" under Orchestrators. `role` names the entry's state, its prompt tab and promptForRole; `note` is the one
// line it opens to (New Task opens to its Agent/Model/Effort settings instead).
export const SETTINGS_GROUPS = [
  { key: "orchestrators", label: "Orchestrators", entries: [
    { role: "newTask", label: "New Task", title: "New Task Orchestrator", note: null },
    { role: "orchestrator", label: "Task", title: "Task Orchestrator", note: "Runs a workflow: plans it, starts Workers, Reviewers and Investigators, and decides what to fix." },
    { role: "refactor", label: "Refactor", title: "Refactor Orchestrator", note: "Runs a refactor type, and starts Investigators and Workers (prototypes)." },
  ] },
  { key: "agents", label: "Agents", entries: [
    { role: "worker", label: "Worker", title: "Worker", note: "Started by the Task Orchestrator, used only in workflow runs: does one job the Task Orchestrator gives it." },
    { role: "reviewer", label: "Reviewer", title: "Reviewer", note: "Started by the Task Orchestrator, used only in workflow runs: reads the finished work and reports findings, read-only." },
    { role: "investigator", label: "Investigator", title: "Investigator", note: "A shared read-only agent: explores the code to answer a question from the agent that started it. The New Task, Task and Refactor Orchestrators can all start it." },
  ] },
];
export const SETTINGS_ENTRIES = SETTINGS_GROUPS.flatMap((g) => g.entries);

// Groups and entries share one saved object, so a group's key can't be an entry's role.
export const groupKey = (group) => `group.${group}`;

// Every group and every entry starts closed; only explicit booleans for known keys survive a reload. State saved before the
// grouping (newTask, orchestrator, worker, reviewer) still reads as the same entries.
export function normalizeSettingsSections(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const keys = [...SETTINGS_GROUPS.map((g) => groupKey(g.key)), ...SETTINGS_ENTRIES.map((e) => e.role)];
  return Object.fromEntries(keys.map((key) => [key, value[key] === true]));
}

// What the New Task Orchestrator's own helpers' prompt tabs are called (their prompts are not entries of their own).
const SUB_TITLES = { newTaskInvestigator: "New Task investigator", newTaskWorker: "New Task prototype worker" };

// The title of an entry's prompt tab.
export function promptTitle(role) {
  const entry = SETTINGS_ENTRIES.find((e) => e.role === role);
  return entry ? `${entry.title} prompt` : SUB_TITLES[role] ? `${SUB_TITLES[role]} prompt` : "Prompt";
}

// local: { mainRoot, todoDir, upNextDir } when the repo's tasks are local files; the id is a placeholder, as a run's are.
// "newTask" is the New Task Orchestrator's; "refactor" is the Refactor Orchestrator's, for a sample refactor type; "newTaskInvestigator" and "newTaskWorker" are what its investigators and prototype workers read.
export function promptForRole(role, { repo = "", project = null, options = [], local = null } = {}) {
  if (role === "newTask" && local) return localNewTaskPrompt({ ...local, nextId: "<next id>", agentsDir: SESSION_FOLDER });
  if (role === "newTask") {
    return newTaskPrompt({ repo, project, backlog: spelled(options, STATUSES.backlog), groomed: spelled(options, STATUSES.groomed), agentsDir: SESSION_FOLDER });
  }
  if (role === "refactor" && local) return localRefactorPrompt({ ...local, nextId: "<next id>", type: SAMPLE_REFACTOR, agentsDir: SESSION_FOLDER });
  if (role === "refactor") {
    return refactorPrompt({ repo, project, backlog: spelled(options, STATUSES.backlog), groomed: spelled(options, STATUSES.groomed), type: SAMPLE_REFACTOR, agentsDir: SESSION_FOLDER });
  }
  if (role === "newTaskInvestigator") return newTaskInvestigatorPrompt(SESSION);
  if (role === "newTaskWorker") return newTaskWorkerPrompt(SESSION);
  const build = { orchestrator: orchestratorPrompt, worker: workerPrompt, reviewer: reviewerPrompt, investigator: investigatorPrompt }[role];
  return build ? clean(build(SAMPLE)).trim() : null;
}

// The refactor type the Refactor Orchestrator's prompt tab is drawn for.
const SAMPLE_REFACTOR = { name: "<refactor type name>", orchestrator: { prompt: "<the refactor type's orchestrator prompt goes here>" } };

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
