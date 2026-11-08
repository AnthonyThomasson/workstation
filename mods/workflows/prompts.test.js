import test from "node:test";
import assert from "node:assert/strict";
import { orchestratorPrompt } from "./prompts.js";

const prompt = () => orchestratorPrompt({
  workflow: { name: "Story" },
  ticket: { title: "Fix the login" },
  repo: "o/r",
  runDir: "/run",
  workDir: "/work",
  branch: "workflow/1-fix-the-login",
});

test("the orchestrator ends reviewers once their findings are settled", () => {
  const text = prompt();
  assert.match(text, /Keep each reviewer running after it reports/);
  assert.match(text, /A reviewer that reported no findings needing fixes is done: end it with `hc kill <name>`/);
  assert.match(text, /Once a reviewer has confirmed its findings are addressed, end it with `hc kill <name>`/);
  assert.doesNotMatch(text, /end every worker and reviewer/i);
  assert.doesNotMatch(text, /end (?:a|the|each) worker/i);
});
