// Pure state and prompt selection for the Task settings sections and their read-only prompt tabs.
import { newTaskPrompt, spelled, STATUSES } from "./model.js";
import { orchestratorPrompt, workerPrompt, reviewerPrompt } from "./run.js";

// All four sections start closed; only explicit booleans for known sections survive a reload.
export function normalizeSettingsSections(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  return Object.fromEntries(["newTask", "orchestrator", "worker", "reviewer"].map((role) => [role, value[role] === true]));
}

export function promptForRole(role, { repo = "", project = null, options = [] } = {}) {
  if (role === "newTask") {
    return newTaskPrompt({ repo, project, backlog: spelled(options, STATUSES.backlog), groomed: spelled(options, STATUSES.groomed) });
  }
  const build = { orchestrator: orchestratorPrompt, worker: workerPrompt, reviewer: reviewerPrompt }[role];
  return build ? clean(build(SAMPLE)).trim() : null;
}

// What a run fills in, shown as it is in the built-in prompts' own words.
const SAMPLE = {
  workflow: {
    name: "<workflow name>",
    orchestrator: { planning: "<the workflow's planning prompt goes here>", retro: "<the workflow's retro prompt goes here>", prompt: "<the workflow's orchestrator prompt goes here>" },
    worker: { prompt: "<the workflow's worker prompt goes here>" },
    reviewer: { prompt: "<the workflow's reviewer prompt goes here>" },
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
