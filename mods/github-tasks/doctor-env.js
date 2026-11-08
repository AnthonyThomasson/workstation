// Herdr's side of the doctor: the real gh, agents, workflow files and shared state it runs against. The doctor itself is doctor-run.js.
import { shared, setShared, knownAgents } from "herdr";
import { normalizeGroomer, GROOMER_KEY, projectKey } from "./model.js";
import { loadWorkflows, repoRootOf } from "./workflow-env.js";
import { Doctor } from "./doctor-run.js";
import { gh } from "./ui.js";

const LEGACY_AGENT_KEY = "github-tasks.groomAgent"; // the agent saved before the settings page held it

const deps = {
  shared, setShared, gh, knownAgents, loadWorkflows, repoRootOf,
  groomerAgent: () => normalizeGroomer(shared(GROOMER_KEY)).agent ?? shared(LEGACY_AGENT_KEY) ?? null,
  chosenProject: (repo) => shared(projectKey(repo)),
};

// Starts the doctor in the sidebar. cx: the view's init context.
export const startDoctor = (cx) => new Doctor(cx, deps);
