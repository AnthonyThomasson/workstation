// Public interface of investigations/: the only file code outside this folder may import.
export { investigationAgentsFor, investigationQueries } from "./investigation-agents.js";
export { newTaskInvestigatorPrompt, newTaskWorkerPrompt, sessionFolder } from "./investigation-spawn.js";
export { agentOf, beginInvestigation, deleteBranch, endInvestigation, INVESTIGATION_HOST_LABEL, INVESTIGATION_ROLE, investigationRow, INVESTIGATIONS_KEY, investigationsFor, reapplyInvestigations, removeWorktree, tabNameFor } from "./investigations.js";
export { AGENT_KEY, boxRows, chooseAgent, NewTaskDialog, enterStep as newTaskDialogEnterStep, panelWidth as newTaskDialogPanelWidth, TITLE as newTaskDialogTITLE, newTaskOverlay, newTaskProps, PROMPT } from "./new-task-dialog.js";
export { EMPTY_TEXT, FOCUS_HEIGHT, FOCUS_LABEL, FOCUS_PLACEHOLDER, focusRows, pickKey, pickValue, RefactorDialog, enterStep as refactorDialogEnterStep, panelWidth as refactorDialogPanelWidth, TITLE as refactorDialogTITLE, refactorOverlay, SUBTITLE, TOOLTIP, typeRows } from "./refactor-dialog.js";
