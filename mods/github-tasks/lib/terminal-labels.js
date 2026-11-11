// The one home of the herdr.* labels on terminals: runs/run.js writes the run labels and runs/runview.js reads them;
// investigations/ does the same for an Investigation. Import them from here (lib/index.js) rather than repeating a label
// string; lib/homes.test.js keeps it so.

// Labels on a run's terminals.
export const RUN_LABEL = "herdr.workflow.run"; // on every terminal of a run: its id
export const TICKET_LABEL = "herdr.workflow.ticket"; // on the orchestrator: which ticket, so Start finds a run in progress
export const FOLDER_LABEL = "herdr.workflow.folder"; // on every terminal: the folder it works in
export const FINAL_LABEL = "herdr.workflow.final"; // "1" on the final reviewer, which reviews the whole ticket branch
export const NAME_LABEL = "herdr.workflow.name"; // on a worker, reviewer or investigator: the name the orchestrator gave it
export const HOST_LABEL = "herdr.workflow.host"; // on a run's host terminal (runs/bgrun.js): the run id. Never RUN_LABEL: the host is not an agent of the run
export const ROLE_LABEL = "herdr.role"; // orchestrator | worker | reviewer | investigator | host

// Labels on an Investigation's terminals.
export const INVESTIGATION_LABEL = "herdr.investigation"; // on the session's agent and on each of its helpers: the session's id
export const INVESTIGATION_HOST_LABEL = "herdr.investigation.host"; // on the session's host terminal: the investigation's id. Never INVESTIGATION_LABEL: the host is not the agent, and investigationsFor reads the agent's status by that one
