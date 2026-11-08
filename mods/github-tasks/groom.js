// Start Grooming and Set Up Project: each opens an agent in a tab of its own, in the repo's folder, told what
// to do (the prompts are in model.js).
import { knownAgents, spaces } from "herdr";
import { groomPrompt, newTaskPrompt, groomArgv, setupPrompt } from "./model.js";
import { app } from "./ui.js";

export const installedAgents = () => knownAgents().then((list) => list.filter((a) => a.installed), () => []);

// The agent in a tab of its own, in the folder the panel looks at, with the task as its first message.
// agent: an entry of knownAgents(). groomer: { model, effort } from the settings page. Throws with a message for the person.
async function openAgent({ agent, name, task, groomer, where }) {
  if (where?.on) throw new Error(`This space is on ${where.on}. Tasks' agents only start on this computer for now.`);
  if (!where?.cwd) throw new Error("This space has no folder to work in.");
  if (!agent?.run?.length) throw new Error("Pick an agent that is installed on this computer.");
  const space = spaces().find((s) => s.active)?.id;
  await app("tab.new", {
    name: name.slice(0, 40), folder: where.cwd, argv: groomArgv(agent.key, agent.run, groomer ?? {}), task,
    ...(space ? { space } : {}),
  });
}

export async function startGrooming({ agent, repo, project, settings, groomer, where }) {
  const name = `Groom ${String(repo).split("/").pop()}`;
  await openAgent({ agent, name, task: groomPrompt({ repo, project, backlog: settings.backlog, groomed: settings.groomed }), groomer, where });
}

export async function startNewTask({ agent, repo, project, settings, groomer, where }) {
  const name = `New task ${String(repo).split("/").pop()}`;
  await openAgent({ agent, name, task: newTaskPrompt({ repo, project, backlog: settings.backlog, groomed: settings.groomed }), groomer, where });
}

// Set Up Project: the agent looks through the installed modules and asks how the new project should be set up.
export async function startProjectSetup({ agent, repo, project, groomer, where }) {
  const name = `Set up ${String(repo).split("/").pop()}`;
  await openAgent({ agent, name, task: setupPrompt({ repo, project }), groomer, where });
}
