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
import * as workflowModel from "./workflow-model.js";
import * as refactorModel from "./refactor-model.js";

export const WORKFLOW = { key: "workflow", noun: "workflow", plural: "workflows", folder: "workflows", model: workflowModel, starters: ["bug", "story"] };
export const REFACTOR = { key: "refactor", noun: "refactor", plural: "refactors", folder: "refactors", model: refactorModel, starters: ["redundant-tests", "architecture", "isolation"] };
export const KINDS = { workflow: WORKFLOW, refactor: REFACTOR };
