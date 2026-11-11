// The one home of the mod's shared-state and overlay keys: every "github-tasks.*" key is named here and imported from here
// (lib/index.js), never written out elsewhere. lib/homes.test.js keeps it so.

// Set to the time of each workflow save or delete, so the lists (and the doctor) refresh.
export const WORKFLOWS_CHANGED = "github-tasks.workflows.changed";
// The same for refactor types.
export const REFACTORS_CHANGED = "github-tasks.refactors.changed";

// Shared state main.js publishes for the settings page and the doctor.
export const CONTEXT = "github-tasks.context"; // { repo, project, where }: what the sidebar looks at
export const PLACE = "github-tasks.place"; // { cwd, on }: where the selected space is. Set even with no repo

// The shared key that holds the project chosen for a repo.
export const projectKey = (repo) => `github-tasks.project.${repo}`;

export const GROOMER_KEY = "github-tasks.groomer"; // { agent, model, effort }: what New Task opens
// The New Task Orchestrator's own helpers: the investigators' and prototype workers' { agent, model, effort }, saved apart from the
// New Task Orchestrator's.
export const INVESTIGATOR_KEY = "github-tasks.investigator";
export const WORKER_KEY = "github-tasks.protoWorker";
export const AGENT_KEY = "github-tasks.groomAgent"; // the agent saved before the settings page held it

export const AGENT_POPUP_KEY = "github-tasks.agent"; // one fixed key: a second click replaces the open window, in its place
// Set to the time of each save, so the panel's list refreshes.
export const CHANGED = "github-tasks.changed";
export const DOCTOR_KEY = "github-tasks.doctor"; // { issues, repo, project }: what the last check found, for the settings and the sidebar
// The list of investigations still to track (shared state): [{ id, label, repoRoot, repo, branch, workDir, agent }].
// The tab's own slot ({ tab, left, space }) is kept beside it, per id, by slotKey, as a run's is.
export const INVESTIGATIONS_KEY = "github-tasks.investigations";
export const SECTIONS_KEY = "github-tasks.settingsSections";

// The overlays' keys.
export const OVERLAY_KEY = "github-tasks.start"; // the Start dialog
export const NEW_TASK_OVERLAY_KEY = "github-tasks.new-task";
export const EDITOR_OVERLAY_KEY = "github-tasks.editor";
export const REFACTOR_OVERLAY_KEY = "github-tasks.refactor";
export const PICK_PREFIX = "github-tasks.refactorPick."; // + the repo's key: the type last started there, as scope:id

// One tab per workflow or refactor type: the pane its tab.new made.
export const openKey = (subject) => `github-tasks.open:${subject}`;
// Where the run's tab is saved (shared state, as herdr.tab labels are gone): { tab, left, space }.
export const slotKey = (id) => `github-tasks.runtab.${id}`;
// Where the run's host is saved (shared state): { tab, space, created } (created: Start made the space for it).
export const hostKey = (id) => `github-tasks.host.${id}`;

// A run's page.
export const stageKey = (id) => `github-tasks.run.${id}.stage`;
export const prKey = (id) => `github-tasks.run.${id}.pr`;
export const finalKey = (id) => `github-tasks.run.${id}.final`; // the final reviewer has been seen: Merge waits for that
export const autoPrKey = (id) => `github-tasks.run.${id}.autopr`; // the page has tried to open the pull request by itself: it does that once per run
export const runAgentsKey = (id) => `github-tasks.run.${id}.agents`; // the workers, reviewers and investigators seen, so a reload still lists the finished ones
export const failureKey = (id) => `github-tasks.run.${id}.mergefailure`; // the red Merge button: { kind, label, error }
export const fixingKey = (id) => `github-tasks.run.${id}.fixing`; // the orchestrator is fixing it: { label, error, seenWorking, turn, busy }
export const leadKey = (id) => `github-tasks.run.${id}.orchestrator`; // the address of the orchestrator, when a new one was started for the run
// An Investigation's page.
export const investigationAgentsKey = (id) => `github-tasks.investigation.${id}.agents`; // the investigators and workers seen, so a reload still lists the finished ones
