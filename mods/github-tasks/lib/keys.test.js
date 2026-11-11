import test from "node:test";
import assert from "node:assert/strict";
import * as keys from "./keys.js";
import { INVESTIGATOR_KEY, WORKER_KEY, GROOMER_KEY } from "./keys.js";

test("the investigators' and workers' settings have their own keys, distinct from the New Task Orchestrator's", () => {
  assert.equal(INVESTIGATOR_KEY, "github-tasks.investigator");
  assert.equal(WORKER_KEY, "github-tasks.protoWorker");
  assert.equal(new Set([INVESTIGATOR_KEY, WORKER_KEY, GROOMER_KEY]).size, 3);
});

test("every fixed key is a github-tasks key, and no two are the same", () => {
  const fixed = Object.values(keys).filter((v) => typeof v === "string");
  for (const key of fixed) assert.match(key, /^github-tasks\./);
  assert.equal(new Set(fixed).size, fixed.length);
});

test("herdr-tasks' action reaches the mod by its name, and the sidebar knows the command it delivers", () => {
  assert.equal(keys.CLI_ACTION, "github-tasks.cli");
  assert.equal(keys.modCommand(keys.CLI_ACTION), "cli");
  assert.equal(keys.modCommand("editor.save"), "save");
});
