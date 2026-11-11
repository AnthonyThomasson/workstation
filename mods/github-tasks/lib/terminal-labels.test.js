import test from "node:test";
import assert from "node:assert/strict";
import {
  RUN_LABEL, TICKET_LABEL, FOLDER_LABEL, FINAL_LABEL, NAME_LABEL, HOST_LABEL, ROLE_LABEL,
  INVESTIGATION_LABEL, INVESTIGATION_HOST_LABEL,
} from "./terminal-labels.js";

test("every terminal label has one home", () => {
  assert.deepEqual({
    RUN_LABEL, TICKET_LABEL, FOLDER_LABEL, FINAL_LABEL, NAME_LABEL, HOST_LABEL, ROLE_LABEL,
    INVESTIGATION_LABEL, INVESTIGATION_HOST_LABEL,
  }, {
    RUN_LABEL: "herdr.workflow.run",
    TICKET_LABEL: "herdr.workflow.ticket",
    FOLDER_LABEL: "herdr.workflow.folder",
    FINAL_LABEL: "herdr.workflow.final",
    NAME_LABEL: "herdr.workflow.name",
    HOST_LABEL: "herdr.workflow.host",
    ROLE_LABEL: "herdr.role",
    INVESTIGATION_LABEL: "herdr.investigation",
    INVESTIGATION_HOST_LABEL: "herdr.investigation.host",
  });
});
