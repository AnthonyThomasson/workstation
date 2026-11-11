// New Task: an Investigation (investigate.js): an agent working in a worktree and a space of its own, told what to do (the
// prompts are in model.js). These are the two entry points the sidebar calls; the rest is investigate.js.
import { knownAgents } from "herdr";
import { startInvestigation } from "./investigate.js";

export const installedAgents = () => knownAgents().then((list) => list.filter((a) => a.installed), () => []);

// agent: an entry of knownAgents(). groomer: { model, effort } from the settings page. subAgents: { investigator, worker }, the settings
// page's choices for the helpers it may start. description: what the person typed (none: the agent asks what they want).
// refactor: { type, focus } when the Refactor dialog started it (refactor-dialog.js), passed on to startInvestigation; null for a New Task.
// cx: the spawned task's. Throws with a message for the person.
export const startNewTask = ({ agent, description = "", repo, project, settings, groomer, subAgents, where, refactor = null }, cx) =>
  startInvestigation({ agent, description, repo, project, settings, groomer, subAgents, where, refactor }, cx);
