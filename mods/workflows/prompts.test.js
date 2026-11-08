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

test("the orchestrator ends agents once they have nothing left to do", () => {
  const text = prompt();
  assert.match(text, /Keep each reviewer running after it reports/);
  assert.match(text, /Once a worker's job is reported and checked, end it with `hc kill <name>` unless you are about to reuse it for a fix/);
  assert.match(text, /A reviewer that reported no findings needing fixes is done: end it with `hc kill <name>`/);
  assert.match(text, /Once a reviewer has confirmed its findings are addressed, end it with `hc kill <name>`/);
  assert.match(text, /End every worker and reviewer of this run with `hc kill <name>` before telling the person/);
});
