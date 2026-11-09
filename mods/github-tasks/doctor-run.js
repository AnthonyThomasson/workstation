// Runs the doctor (doctor.js) on its own: it asks gh, the installed agents and the workflow files for itself, so it does not wait
// for the ticket list. It checks when it starts, when the space or its repo changes (PLACE), when workflows change, the grooming
// agent is chosen or another project is picked in the sidebar (the repo's `projectKey`), and on a slow timer, and publishes what it finds to DOCTOR_KEY, which the settings page and the sidebar's gear
// read. Everything it uses comes in as `deps` (doctor-env.js passes Herdr's), so node --test runs it against fakes:
//   deps.shared(key)  deps.setShared(key, value)  deps.gh(args, where)  deps.knownAgents()  deps.loadWorkflows(where)
//   deps.repoRootOf(where)  deps.groomerAgent()  deps.chosenProject(repo)
//   deps.mainCheckoutOf(where)  deps.taskSource(mainRoot) -> "local" | "github"  deps.hasGithubRemote(mainRoot) -> boolean
import { chooseProject, WORKFLOWS_CHANGED, PLACE } from "./model.js";
import { findRepo, findProjects, loadStatusField } from "./loader.js";
import { loadLabels, LABEL_LIMIT } from "./labels.js";
import { diagnose, parseAuthStatus, doctorSignature, doctorFor, DOCTOR_KEY } from "./doctor.js";

const WATCH = 2000; // how often the shared state is looked at; a check runs only when it changed
const EVERY = 60000; // the slow check, for what no state change tells (a sign-in, an install, a project edited on GitHub)
export const TIMEOUT = 45000; // a check that takes longer is given up on, so a hung program cannot stop the doctor

const attempt = (promise) => Promise.resolve(promise).then((value) => ({ value }), (error) => ({ error }));

// The doctor's inputs for a place ({ cwd, on } or null). Whatever cannot be found out stays unknown (undefined, or null where
// doctor.js says), so a failed question is never reported as a problem. repo is null only when gh says there is no GitHub repo.
export async function gather(place, deps) {
  const where = { cwd: place?.cwd, on: place?.on };
  const local = place?.source === "local" && Boolean(place.main);
  // Local tasks: gh is only needed when the repo's origin is on GitHub (an unknown remote is not asked about), and there is
  // no repo or project to look up.
  const remote = local ? await attempt(deps.hasGithubRemote(place.main)) : null;
  const askGh = !local || remote.value === true;
  const [auth, agents, loaded] = await Promise.all([
    askGh ? attempt(deps.gh(["auth", "status", "-h", "github.com"], where)) : { value: undefined },
    attempt(deps.knownAgents()),
    attempt(deps.loadWorkflows(where)),
  ]);
  const inputs = {
    auth: auth.value ? parseAuthStatus(auth.value) : undefined,
    agents: agents.value ? agents.value.map((a) => ({ key: a.key, installed: Boolean(a.installed) })) : null,
    groomerAgent: deps.groomerAgent(),
    workflows: loaded.value,
    repo: place?.cwd ? undefined : null, project: undefined, statuses: undefined, labels: undefined,
  };
  if (local) return { ...inputs, source: "local", githubRemote: remote.value === true, repo: null, project: null };
  // The project checks need a repo, and a gh that is there and not known to be signed out to ask about it.
  if (!place?.cwd || inputs.auth?.installed === false || inputs.auth?.signedIn === false) return inputs;
  const found = await attempt(findRepo(deps.gh, where));
  if (found.error) {
    if (found.error.kind === "not-a-repo") inputs.repo = null;
    return inputs; // any other failure leaves the repo unknown
  }
  inputs.repo = found.value;
  // The trigger labels are asked about only when a workflow has some; a failed read leaves the labels unknown.
  const triggers = (inputs.workflows?.items ?? []).some((w) => w?.trigger?.labels?.length);
  const [projects, labels] = await Promise.all([
    attempt(findProjects(deps.gh, inputs.repo, where)),
    triggers ? attempt(loadLabels(deps.gh, inputs.repo, where)) : { error: null },
  ]);
  // loadLabels reads the first LABEL_LIMIT labels: a full page may be cut short, so a label not in it is not known to be missing.
  if (!labels.error && triggers && labels.value.length < LABEL_LIMIT) inputs.labels = labels.value;
  if (projects.error) return inputs;
  const project = chooseProject(projects.value, deps.chosenProject(inputs.repo));
  inputs.project = project ? { id: project.id, title: project.title, url: project.url } : null;
  if (project) {
    const field = await attempt(loadStatusField(deps.gh, project.id, where));
    if (!field.error) inputs.statuses = field.value?.options ?? [];
  }
  return inputs;
}

// What the check found, in the shape DOCTOR_KEY holds. `place` is { cwd, on, root } and, for the check, the task `source` of its
// repo and its `main` checkout ("local" only for a space on this computer whose tasks.json says so). previous: the last answer, whose project
// issues are kept for this place while gh cannot say.
export async function check(place, deps, previous = null) {
  const inputs = await gather(place && { cwd: place.cwd, on: place.on, source: place.source, main: place.main }, deps);
  // Kept only for the same repo, and for the same project once this check has found one.
  const sameRepo = inputs.repo === undefined || previous?.repo === inputs.repo;
  const sameProject = !inputs.project || previous?.project?.id === inputs.project.id;
  const local = inputs.source === "local";
  const prior = !local && previous && doctorFor(previous, place) && sameRepo && sameProject ? previous : null;
  // Label issues belong to the repo, not to a project, so they are kept for the same repo whichever project is found.
  const sameRepoOnly = !local && previous && doctorFor(previous, place) && sameRepo ? previous : null;
  const carried = prior ? prior.issues : sameRepoOnly?.issues.filter((i) => i.kind === "label-missing");
  const issues = diagnose({ ...inputs, carried });
  return {
    issues,
    source: local ? "local" : "github",
    repo: inputs.repo ?? prior?.repo ?? null,
    project: inputs.project !== undefined ? inputs.project : (prior && (inputs.repo === undefined || inputs.repo === prior.repo) ? prior.project : null) ?? null,
    place: place ? { cwd: place.cwd ?? null, on: place.on ?? null, root: place.root ?? null } : null,
  };
}

export class Doctor {
  constructor(cx, deps) {
    this.deps = deps;
    this.sig = null; // what the last check started for; null to check at the next look
    this.stuck = null; // the state a check timed out in: the 2s looks start nothing more until it changes or the 60s check comes
    this.began = null; // the place ({ cwd, on }) the running look is for
    this.repos = new Map(); // a place's anchor -> the repo found there, to read the project picked for it
    this.running = false;
    this.generation = 0; // a check that was given up on is a past generation, and publishes nothing
    this.roots = new Map(); // cwd -> its repo's top folder, so a folder is asked about once
    this.mains = new Map(); // a place's key -> its repo's main checkout (where tasks.json is), asked once
    this.sources = new Map(); // a place's anchor -> the task source last read there, so a toggle in the settings is a change
    this.watch(cx, false);
    cx.timer.every(WATCH, (cx) => this.watch(cx, false));
    cx.timer.every(EVERY, (cx) => this.watch(cx, true));
  }

  watch(cx, force) {
    cx.spawn((cx) => this.look(force, (ms) => cx.sleep(ms)));
  }

  // The place as the checks see it: { cwd, on, root }, or null with no place yet. arm() is called before a lookup that is not
  // cached, which is the only one that can hang. Only an answer is kept; a failed lookup is asked again next time.
  async place(arm) {
    const at = this.deps.shared(PLACE);
    if (!at) return null;
    const key = `${at.on ?? ""}|${at.cwd ?? ""}`;
    if (!this.roots.has(key)) {
      arm();
      const found = await attempt(this.deps.repoRootOf({ cwd: at.cwd, on: at.on }));
      if (found.error) return { cwd: at.cwd, on: at.on, root: null };
      this.roots.set(key, found.value ?? null);
    }
    return { cwd: at.cwd, on: at.on, root: this.roots.get(key) };
  }

  // The folder a place is keyed on: its repo's top folder, from the lookups already made (also for a folder not asked about yet
  // but inside a repo that was), else the folder itself. Never asks anything, so it is safe to use before a lookup.
  anchor(at) {
    if (!at) return null;
    const own = this.roots.get(`${at.on ?? ""}|${at.cwd ?? ""}`);
    if (own) return own;
    for (const [key, root] of this.roots) {
      if (root && key.startsWith(`${at.on ?? ""}|`) && at.cwd && (at.cwd === root || at.cwd.startsWith(`${root.replace(/\/+$/, "")}/`))) return root;
    }
    return at.cwd ?? null;
  }

  // The inputs of the signature other than the place. The project is the one picked in the sidebar for the repo last found at
  // this place (`at`: { cwd, on }), so picking another is seen at the next look, not at the slow check.
  rest(at) {
    const repo = at ? this.repos.get(`${at.on ?? ""}|${this.anchor(at)}`) : null;
    return {
      source: (at && this.sources.get(`${at.on ?? ""}|${this.anchor(at)}`)) || "github",
      workflowsChanged: this.deps.shared(WORKFLOWS_CHANGED), groomer: { agent: this.deps.groomerAgent() },
      project: repo ? this.deps.chosenProject(repo) ?? null : null,
    };
  }

  // The task source of a place ({ cwd, on, root }) and its main checkout: { source, main }. Local tasks work only for a space on
  // this computer, inside a repo; anything not known is github, as before. The main checkout is asked once (arm() first, as it
  // runs git); tasks.json is read at every look, so ticking the checkbox is seen within the 2s.
  async sourceOf(place, arm) {
    const github = { source: "github", main: null };
    if (!place?.cwd || place.on || !place.root) return github;
    const key = `${place.on ?? ""}|${place.cwd}`;
    if (!this.mains.has(key)) {
      arm();
      const found = await attempt(Promise.resolve().then(() => this.deps.mainCheckoutOf({ cwd: place.cwd, on: place.on })));
      if (found.error || !found.value) return github;
      this.mains.set(key, found.value);
    }
    const main = this.mains.get(key);
    const read = await attempt(Promise.resolve().then(() => this.deps.taskSource(main)));
    return { source: read.value === "local" ? "local" : "github", main };
  }

  // The state as the 2s look sees it for a place ({ cwd, on } or null), before any lookup: the place's anchor and the rest.
  stateAt(at) { return JSON.stringify([at?.on ?? null, this.anchor(at), this.rest(at)]); }

  // A check, when forced or when something it depends on changed. One at a time, and none that takes longer than TIMEOUT. The
  // timeout starts only once there is something to wait for (a lookup or a check), so looks that find nothing to do leave nothing
  // pending. Without a place, only a forced check runs: the place is published a moment after the mod starts, and an answer for
  // no place would only be thrown away. After a timeout the 2s looks wait while the state stays what the stuck check started in
  // (same anchor, workflows, grooming agent and picked project); a forced look or any change ends the wait. sleep(ms): resolves
  // after ms.
  async look(force, sleep = () => new Promise(() => {})) {
    if (this.running) return;
    const at = this.deps.shared(PLACE) ?? null;
    if (force) this.stuck = null;
    else if (this.stuck !== null) {
      if (this.stuck === this.stateAt(at)) return; // a check timed out in this state: wait for the 60s check or a change
      this.stuck = null;
    }
    this.began = at;
    this.running = true;
    const mine = ++this.generation;
    const TIMED_OUT = Symbol("timed out");
    let armed = false, expire;
    const timeout = new Promise((resolve) => { expire = resolve; });
    const arm = () => { if (!armed) { armed = true; sleep(TIMEOUT).then(() => expire(TIMED_OUT)); } };
    try {
      const outcome = await Promise.race([this.work(force, mine, arm), timeout]);
      // Not again until the 60s check, or the place or its inputs change. The state is the one the stuck check started in, as the
      // lookups it made since have taught it (its repo's folder, its repo).
      if (outcome === TIMED_OUT) { this.generation++; this.sig = null; this.stuck = this.stateAt(this.began); }
    } catch {
      this.sig = null; // the doctor never breaks the panel: the last answer stays, and the next look tries again
    } finally {
      this.running = false;
    }
  }

  async work(force, mine, arm) {
    const place = await this.place(arm);
    if (mine !== this.generation || (!place && !force)) return;
    if (place) this.began = { cwd: place.cwd, on: place.on };
    const { source, main } = await this.sourceOf(place, arm);
    if (mine !== this.generation) return;
    if (place) this.sources.set(`${place.on ?? ""}|${this.anchor(place)}`, source);
    const rest = this.rest(place), sig = doctorSignature({ place, ...rest });
    if (!force && sig === this.sig) return;
    this.sig = sig;
    arm();
    // What the check reads of the picked project, so a pick made while it ran is not mistaken for part of its answer.
    const read = {};
    const deps = { ...this.deps, chosenProject: (repo) => {
      read.repo = repo;
      if (place) this.repos.set(`${place.on ?? ""}|${this.anchor(place)}`, repo); // known even if the check never finishes
      return (read.picked = this.deps.chosenProject(repo));
    } };
    const current = this.deps.shared(DOCTOR_KEY);
    const found = await check(place && { ...place, source, main }, deps, current);
    if (mine !== this.generation) return; // given up on while it ran
    if (place) this.repos.set(`${place.on ?? ""}|${this.anchor(place)}`, found.repo);
    // The place or what it depends on moved on while this ran: this answer is not for it, so look again.
    const now = this.deps.shared(PLACE) ?? null;
    const used = { ...rest, project: read.repo ? read.picked ?? null : rest.project };
    if ((now?.cwd ?? null) !== (place?.cwd ?? null) || (now?.on ?? null) !== (place?.on ?? null)
      || doctorSignature({ place, ...this.rest(place) }) !== doctorSignature({ place, ...used })) { this.sig = null; return; }
    if (JSON.stringify(this.deps.shared(DOCTOR_KEY)) !== JSON.stringify(found)) this.deps.setShared(DOCTOR_KEY, found);
    // The answer names the repo, so the picked project is now part of the signature: settle on what the check read.
    this.sig = doctorSignature({ place, ...used });
  }
}
