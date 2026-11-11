// Herdr's side of the doctor: the real gh, agents, workflow files and shared state it runs against. The doctor itself is doctor-run.js.
import { shared, setShared, knownAgents, exec } from "herdr";
import { normalizeGroomer, GROOMER_KEY, projectKey } from "./lib/index.js";
import { loadWorkflows, repoRootOf } from "./workflow-ui/index.js";
import { Doctor } from "./doctor-run.js";
import { gh } from "./widgets/index.js";
import { mainCheckout } from "./worktree.js";
import { tasksConfig, repoHasGithubRemote } from "./local-tasks-env.js";

const LEGACY_AGENT_KEY = "github-tasks.groomAgent"; // the agent saved before the settings page held it

const deps = {
  shared, setShared, gh, knownAgents, loadWorkflows, repoRootOf,
  groomerAgent: () => normalizeGroomer(shared(GROOMER_KEY)).agent ?? shared(LEGACY_AGENT_KEY) ?? null,
  chosenProject: (repo) => shared(projectKey(repo)),
  // Where the repo's tasks come from: the main checkout holds .herdr/tasks/tasks.json, whichever worktree the space is in.
  mainCheckoutOf: ({ cwd }) => mainCheckout((dir, ...args) => exec("git", ["-C", dir, ...args]), cwd),
  taskSource: (mainRoot) => tasksConfig.read(mainRoot),
  hasGithubRemote: repoHasGithubRemote,
};

// Starts the doctor in the sidebar. cx: the view's init context.
export const startDoctor = (cx) => new Doctor(cx, deps);
