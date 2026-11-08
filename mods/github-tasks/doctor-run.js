// Runs the doctor (doctor.js) inside the Tasks mod, on its own: it asks gh, the installed agents and the workflow
// files for itself, so it does not wait for the ticket list. It checks when the mod starts, when the space or its folder
// changes (PLACE) or the repo or project does (CONTEXT), when workflows change, and on a slow timer, and publishes what it
// finds to DOCTOR_KEY, which the settings page and the sidebar's gear read.
import { shared, setShared, knownAgents } from "herdr";
import { normalizeGroomer, GROOMER_KEY, chooseProject, projectKey, CONTEXT, PLACE } from "./model.js";
import { findRepo, findProjects, loadStatusField } from "./loader.js";
import { loadWorkflows, WORKFLOWS_CHANGED } from "./workflow-env.js";
import { diagnose, parseAuthStatus, doctorSignature, DOCTOR_KEY } from "./doctor.js";
import { gh } from "./ui.js";

const LEGACY_AGENT_KEY = "github-tasks.groomAgent"; // the agent saved before the settings page held it
const WATCH = 2000; // how often the shared state is looked at; a check runs only when it changed
const EVERY = 60000; // the slow check, for what no state change tells (a sign-in, an install, a project edited on GitHub)

const groomerAgent = () => normalizeGroomer(shared(GROOMER_KEY)).agent ?? shared(LEGACY_AGENT_KEY) ?? null;
const attempt = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

// The doctor's inputs for the place the sidebar looks at. Whatever cannot be found out stays unknown (undefined or
// null as doctor.js says), so a failed question is never reported as a problem.
export async function gather(place) {
  const where = { cwd: place?.cwd, on: place?.on };
  const [auth, agents, loaded] = await Promise.all([
    gh(["auth", "status", "-h", "github.com"], where).then(parseAuthStatus),
    attempt(knownAgents()),
    attempt(loadWorkflows(where)),
  ]);
  const inputs = {
    auth,
    installedAgents: agents.value ? agents.value.filter((a) => a.installed).map((a) => a.key) : null,
    groomerAgent: groomerAgent(),
    workflows: loaded.value,
    repo: null, project: undefined, statuses: undefined,
  };
  // The project checks need a repo, and gh signed in with the project scope to ask about its project.
  if (!place?.cwd || !auth.installed || !auth.signedIn) return inputs;
  const found = await attempt(findRepo(gh, where));
  if (found.error) return inputs; // not a GitHub repo (or gh could not say): nothing about projects to check
  inputs.repo = found.value;
  const projects = await attempt(findProjects(gh, inputs.repo, where));
  if (projects.error) return inputs;
  const project = chooseProject(projects.value, shared(projectKey(inputs.repo)));
  inputs.project = project ? { id: project.id, title: project.title, url: project.url } : null;
  if (project) {
    const field = await attempt(loadStatusField(gh, project.id, where));
    if (!field.error) inputs.statuses = field.value?.options ?? [];
  }
  return inputs;
}

// What the check found, in the shape DOCTOR_KEY holds.
export async function check(place) {
  const inputs = await gather(place);
  return { issues: diagnose(inputs), repo: inputs.repo, project: inputs.project ?? null };
}

export class Doctor {
  constructor(cx) {
    this.sig = null; // what the last check started for
    this.running = false;
    this.watch(cx, true);
    cx.timer.every(WATCH, (cx) => this.watch(cx, false));
    cx.timer.every(EVERY, (cx) => this.watch(cx, true));
  }

  signature() {
    return doctorSignature({ place: shared(PLACE), context: shared(CONTEXT), workflowsChanged: shared(WORKFLOWS_CHANGED), groomer: { agent: groomerAgent() } });
  }

  // A check, when forced or when something it depends on changed. One at a time: a change during a check is seen
  // by the next look, because the signature is only kept once a check has started for it.
  watch(cx, force) {
    const sig = this.signature();
    if (this.running || (!force && sig === this.sig)) return;
    this.running = true;
    this.sig = sig;
    cx.spawn(async () => {
      try {
        const found = await check(shared(PLACE) ?? null);
        if (this.signature() !== sig) return; // the place moved on while this was running: the next look checks again
        const was = shared(DOCTOR_KEY);
        if (JSON.stringify(was) !== JSON.stringify(found)) setShared(DOCTOR_KEY, found);
      } catch {
        // The doctor never breaks the panel: the last answer stays.
      } finally {
        this.running = false;
      }
    });
  }
}
