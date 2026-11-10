import test from "node:test";
import assert from "node:assert/strict";
import { WORKFLOW, REFACTOR, changedKey, kindOf, kindSubject, andList, restoreNote, emptyNote, noRepoNote, listMenuLabel, editorTitle, newItemName, hasTrigger, hasPermissions, promptField } from "./kinds.js";

test("kindOf finds a kind by key and falls back to workflows for anything else", () => {
  assert.equal(kindOf("refactor"), REFACTOR);
  assert.equal(kindOf("workflow"), WORKFLOW);
  assert.equal(kindOf(undefined), WORKFLOW);
  assert.equal(kindOf("nonsense"), WORKFLOW);
});

test("a tab's subject names the kind, so a workflow and a refactor with the same id never share a tab", () => {
  assert.equal(kindSubject(WORKFLOW, "global", "bug"), "workflow:global:bug");
  assert.equal(kindSubject(REFACTOR, "global", "bug"), "refactor:global:bug");
  assert.notEqual(kindSubject(WORKFLOW, "repo", "x"), kindSubject(REFACTOR, "repo", "x"));
  assert.equal(kindSubject(REFACTOR, "global", null), null, "a new one has no subject: it always opens a tab");
  assert.equal(kindSubject(REFACTOR, "global", ""), null);
});

test("andList joins names the way a sentence does", () => {
  assert.equal(andList(["Bug"]), "Bug");
  assert.equal(andList(["Bug", "Story"]), "Bug and Story");
  assert.equal(andList(["Redundant tests", "Architecture", "Isolation"]), "Redundant tests, Architecture and Isolation");
  assert.equal(andList([]), "");
});

test("Restore defaults says which starters are re-created, and where", () => {
  assert.equal(restoreNote(WORKFLOW, "global"), "Bug and Story will be re-created in Global.");
  assert.equal(restoreNote(REFACTOR, "global"), "Redundant tests, Architecture and Isolation will be re-created in Global.");
  assert.equal(restoreNote(REFACTOR, "repo"), "Redundant tests, Architecture and Isolation will be re-created in Project.");
});

test("an empty list says what the kind says; a narrowed one just says nothing is there", () => {
  assert.equal(emptyNote(WORKFLOW, "all", 0), "No workflows yet. Make one with New workflow.");
  assert.equal(emptyNote(REFACTOR, "all", 0), "No refactor types yet. Make one with New refactor.");
  assert.equal(emptyNote(REFACTOR, "global", 0), "No refactor types yet. Make one with New refactor.");
  assert.equal(emptyNote(REFACTOR, "global", 2), "No refactors here yet.", "Global is empty of its own but the list has others");
  assert.equal(emptyNote(REFACTOR, "repo", 0), "No refactors here yet.");
  assert.equal(emptyNote(WORKFLOW, "repo", 3), "No workflows here yet.");
});

test("the note beside the folder names the kind", () => {
  assert.equal(noRepoNote(WORKFLOW, { remote: true, folderName: "app" }), "Project workflows need a space on this computer");
  assert.equal(noRepoNote(REFACTOR, { remote: true, folderName: "app" }), "Project refactors need a space on this computer");
  assert.equal(noRepoNote(REFACTOR, { remote: false, folderName: "app" }), "app is not in a git repo");
});

test("the row menu, the editor header and a new tab use the kind's noun", () => {
  assert.equal(listMenuLabel(WORKFLOW), "Workflow actions");
  assert.equal(listMenuLabel(REFACTOR), "Refactor actions");
  assert.equal(editorTitle(WORKFLOW, "bug"), "Workflow · bug");
  assert.equal(editorTitle(REFACTOR, "redundant-tests"), "Refactor type · redundant-tests");
  assert.equal(editorTitle(WORKFLOW, null), "New workflow");
  assert.equal(editorTitle(REFACTOR, null), "New refactor type");
  assert.equal(newItemName(WORKFLOW), "New workflow");
  assert.equal(newItemName(REFACTOR), "New refactor type");
});

test("only workflows have a trigger, and every workflow role but the orchestrator has permissions", () => {
  assert.equal(hasTrigger(WORKFLOW), true);
  assert.equal(hasTrigger(REFACTOR), false);
  assert.deepEqual(["orchestrator", "worker", "reviewer", "investigator"].map((r) => hasPermissions(WORKFLOW, r)), [false, true, true, true]);
  assert.deepEqual(["orchestrator", "investigator"].map((r) => hasPermissions(REFACTOR, r)), [false, false]);
});

test("a 4-role workflow and a 2-role refactor each give every one of their roles a prompt field", () => {
  for (const kind of [WORKFLOW, REFACTOR]) {
    for (const role of kind.model.ROLES) assert.ok(promptField(kind, role).label, `${kind.key} ${role}`);
    assert.deepEqual(Object.keys(kind.editor.prompts).sort(), [...kind.model.ROLES].sort(), `${kind.key} prompts cover exactly its roles`);
  }
  assert.equal(promptField(WORKFLOW, "investigator").label, "Prompt");
});

test("the prompt field is labelled for what the kind's role does", () => {
  assert.equal(promptField(WORKFLOW, "worker").label, "Prompt");
  assert.equal(promptField(REFACTOR, "orchestrator").label, "Refactor prompt");
  assert.equal(promptField(REFACTOR, "investigator").label, "Prompt");
  assert.match(promptField(REFACTOR, "investigator").hint, /optional/i);
  assert.ok(!promptField(REFACTOR, "orchestrator").hint.match(/optional/i), "the refactor prompt is required");
});

test("each kind's roles come from its model, and the editor shows exactly those", () => {
  assert.deepEqual(WORKFLOW.model.ROLES, ["orchestrator", "worker", "reviewer", "investigator"]);
  assert.deepEqual(REFACTOR.model.ROLES, ["orchestrator", "investigator"]);
  assert.deepEqual(REFACTOR.model.ROLE_PROMPTS, { orchestrator: [], investigator: [] });
});

test("each kind announces its saves on its own shared key, so a workflow's save does not refresh the refactor list", () => {
  assert.equal(changedKey(WORKFLOW), WORKFLOW.changed);
  assert.equal(changedKey(REFACTOR), REFACTOR.changed);
  assert.notEqual(changedKey(WORKFLOW), changedKey(REFACTOR));
});

test("the roles with permissions come from the model, not a list kept beside it", () => {
  for (const kind of [WORKFLOW, REFACTOR]) {
    const expected = kind.model.ROLES.filter((role) => "permissions" in kind.model.blank()[role]);
    assert.deepEqual(kind.editor.permissionRoles, expected);
    for (const role of kind.model.ROLES) assert.equal(hasPermissions(kind, role), expected.includes(role));
  }
});

test("the workflow list note names the roles it has", () => {
  assert.match(WORKFLOW.labels.listNote, /Task Orchestrator, worker, reviewer and investigator/);
});
