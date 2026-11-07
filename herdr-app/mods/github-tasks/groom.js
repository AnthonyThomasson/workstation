// Start Grooming: opens an agent in a tab of its own, told which project backlog to groom (the prompt is in model.js).
import { exec, knownAgents, spaces } from "herdr";
import { groomPrompt, groomArgv } from "./model.js";

export const installedAgents = () => knownAgents().then((list) => list.filter((a) => a.installed), () => []);

async function app(name, args) {
  const r = await exec("herdr-app", ["do", name, ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, typeof v === "string" ? v : JSON.stringify(v)])]);
  let made = {};
  try { made = JSON.parse(r.stdout || "{}"); } catch { /* nothing readable */ }
  if (r.code !== 0 || made.error) throw new Error(made.error || r.stderr.trim() || `${name} failed`);
  return made;
}

// agent: an entry of knownAgents(). groomer: { model, effort } from the settings page. Throws with a message for the person.
export async function startGrooming({ agent, repo, project, settings, groomer, where }) {
  if (where?.on) throw new Error(`This space is on ${where.on}. Grooming only starts on this computer for now.`);
  if (!where?.cwd) throw new Error("This space has no folder to work in.");
  if (!agent?.run?.length) throw new Error("Pick an agent that is installed on this computer.");
  const space = spaces().find((s) => s.active)?.id;
  const name = `Groom ${String(repo).split("/").pop()}`.slice(0, 40);
  await app("tab.new", {
    name, folder: where.cwd, argv: groomArgv(agent.key, agent.run, groomer ?? {}),
    task: groomPrompt({ repo, project, backlog: settings.backlog, groomed: settings.groomed }),
    ...(space ? { space } : {}),
  });
}
