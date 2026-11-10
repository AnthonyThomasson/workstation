// The two kinds of thing the store keeps: workflows and refactor types. A kind is everything that differs
// between them (folder, wording, model, shipped starters), so one store, env and list serve both.
// Pure: no Herdr imports.
//
//   key      "workflow" | "refactor"
//   noun     singular, as in messages: "A refactor with that name already exists."
//   plural   as in messages: "Global refactors aren't available here."
//   folder   the folder name in Global (~/.config/herdr-app/<folder>) and in a repo (<repo>/.herdr/<folder>)
//   model    parse / serialize / validate / normalize / slug / SCOPES / SCOPE_LABELS of the kind
//   starters the shipped starters' file names (without .yaml) in this mod's starters/ folder
//   changed  the shared-state key set on every save or delete, so lists (and the doctor) refresh
//   labels   what the list and editor show: listTitle, newLabel (the New button), emptyText, editorNoun (the
//            editor's header noun), starterNames (the starters' display names, in starters order, for the
//            Restore defaults confirmation)
import * as workflowModel from "./workflow-model.js";
import * as refactorModel from "./refactor-model.js";
import { WORKFLOWS_CHANGED, REFACTORS_CHANGED } from "./model.js";

export const WORKFLOW = { key: "workflow", noun: "workflow", plural: "workflows", folder: "workflows", model: workflowModel, starters: ["bug", "story"],
  changed: WORKFLOWS_CHANGED,
  labels: { listTitle: "Workflows", newLabel: "New workflow", emptyText: "No workflows yet. Make one with New workflow.", editorNoun: "workflow", starterNames: ["Bug", "Story"] },
};
export const REFACTOR = { key: "refactor", noun: "refactor", plural: "refactors", folder: "refactors", model: refactorModel, starters: ["redundant-tests", "architecture", "isolation"],
  changed: REFACTORS_CHANGED,
  labels: { listTitle: "Refactors", newLabel: "New refactor", emptyText: "No refactor types yet. Make one with New refactor.", editorNoun: "refactor type", starterNames: ["Redundant tests", "Architecture", "Isolation"] },
};
export const KINDS = { workflow: WORKFLOW, refactor: REFACTOR };
