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
//   labels   what the list and editor show: listTitle, listNote (under the title), newLabel (the New button),
//            emptyText, editorNoun (the editor's header noun), namePlaceholder, starterNames (the starters'
//            display names, in starters order, for the Restore defaults confirmation)
//   editor   the form's shape: trigger (whether it has trigger labels), permissionRoles (the roles with a
//            permissions setting) and prompts (the Prompt field of each role: label, hint)
import * as workflowModel from "./workflow-model.js";
import * as refactorModel from "./refactor-model.js";
import { WORKFLOWS_CHANGED, REFACTORS_CHANGED } from "./model.js";

export const WORKFLOW = { key: "workflow", noun: "workflow", plural: "workflows", folder: "workflows", model: workflowModel, starters: ["bug", "story"],
  changed: WORKFLOWS_CHANGED,
  labels: { listTitle: "Workflows", listNote: "How work gets done: the labels that start each one, and how its Task Orchestrator, worker, reviewer and investigator run.", newLabel: "New workflow", emptyText: "No workflows yet. Make one with New workflow.", editorNoun: "workflow", namePlaceholder: "Feature development", starterNames: ["Bug", "Story"] },
  editor: { trigger: true, permissionRoles: ["worker", "reviewer"],
    prompts: { orchestrator: { label: "Prompt" }, worker: { label: "Prompt" }, reviewer: { label: "Prompt" } } },
};
export const REFACTOR = { key: "refactor", noun: "refactor", plural: "refactors", folder: "refactors", model: refactorModel, starters: ["redundant-tests", "architecture", "isolation"],
  changed: REFACTORS_CHANGED,
  labels: { listTitle: "Refactors", listNote: "How a refactor type runs: the Refactor Orchestrator's prompt, and the investigators it starts.", newLabel: "New refactor", emptyText: "No refactor types yet. Make one with New refactor.", editorNoun: "refactor type", namePlaceholder: "Dead code", starterNames: ["Redundant tests", "Architecture", "Isolation"] },
  editor: { trigger: false, permissionRoles: [],
    prompts: {
      orchestrator: { label: "Refactor prompt", hint: "what the refactor looks for and how to report it" },
      investigator: { label: "Prompt", hint: "optional: extra instructions for every investigator" },
    } },
};
export const KINDS = { workflow: WORKFLOW, refactor: REFACTOR };

// The shared-state key of a kind's `changed`, as a function so the mod-isolation check can follow it to a string.
export const changedKey = (kind) => (kind.key === "refactor" ? REFACTORS_CHANGED : WORKFLOWS_CHANGED);

// The kind a key names; anything else (a tab opened before there were two kinds) is a workflow.
export const kindOf = (key) => KINDS[key] ?? WORKFLOW;

// What a tab is open for. The kind is in it, so a workflow and a refactor type with the same id have tabs of their own.
// null for one that is not saved yet: that always opens a new tab.
export const kindSubject = (kind, scope, id) => (id ? `${kind.key}:${scope}:${id}` : null);

// "A", "A and B", "A, B and C".
export const andList = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

// The Restore defaults line: which starters come back, and where (createScope from store.js restorePlan).
export const restoreNote = (kind, createScope) =>
  `${andList(kind.labels.starterNames)} will be re-created in ${createScope === "repo" ? "Project" : "Global"}.`;

// What an empty list says. itemCount is every item in the list, whichever tab is open: a tab with none of its
// own only says nothing is there.
export const emptyNote = (kind, scope, itemCount) =>
  (scope === "all" || (scope === "global" && !itemCount) ? kind.labels.emptyText : `No ${kind.plural} here yet.`);

// Beside the folder name, when the selected space has no repo.
export const noRepoNote = (kind, { remote, folderName }) =>
  (remote ? `Project ${kind.plural} need a space on this computer` : `${folderName} is not in a git repo`);

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
export const listMenuLabel = (kind) => `${capital(kind.noun)} actions`;
// The editor's header, and the name of a tab with nothing saved yet.
export const newItemName = (kind) => `New ${kind.labels.editorNoun}`;
export const editorTitle = (kind, id) => (id ? `${capital(kind.labels.editorNoun)} · ${id}` : newItemName(kind));

export const hasTrigger = (kind) => kind.editor.trigger;
export const hasPermissions = (kind, role) => kind.editor.permissionRoles.includes(role);
// The Prompt field of a role: { label, hint? }.
export const promptField = (kind, role) => kind.editor.prompts[role] ?? { label: "Prompt" };
