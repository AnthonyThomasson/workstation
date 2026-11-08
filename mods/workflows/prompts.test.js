import test from "node:test";
import assert from "node:assert/strict";
import * as copy from "./prompts.js";
import * as original from "../github-tasks/run.js";

const { orchestratorPrompt } = copy;

const workflow = {
  name: "Story",
  orchestrator: { planning: "PLAN", retro: "LOOK BACK", prompt: "BE BRIEF" },
  worker: { testing: "RUN IT", prompt: "USE TABS" },
  reviewer: { prompt: "BE HARSH" },
};
const input = (extra = {}) => ({
  workflow, ticket: { number: 1, title: "Fix the login" }, repo: "o/r", runDir: "/run",
  workDir: "/src/app-1-fix-the-login", repoRoot: "/src/app", branch: "workflow/1-fix-the-login", ...extra,
});
const prompt = () => orchestratorPrompt(input());

test("the orchestrator ends agents once they have nothing left to do", () => {
  const text = prompt();
  assert.match(text, /Keep the reviewer running after it reports/);
  assert.match(text, /end the worker and its reviewer with `hc kill <name>`/);
  assert.match(text, /Once its findings are addressed, end it with `hc kill <name>`/);
  assert.match(text, /End every worker and reviewer of this run with `hc kill <name>` first/);
});

test("this copy of the role prompts says exactly what github-tasks/run.js says", () => {
  assert.equal(copy.TOKEN_LIMIT, original.TOKEN_LIMIT);
  assert.equal(copy.SKILL, original.SKILL);
  const variants = [
    input(),
    input({ workflow: { name: "Old" } }),
    input({ ticket: { title: "A draft" }, repo: "a/b", runDir: "/other", workDir: "/x-y", repoRoot: "/x", branch: "workflow/y" }),
  ];
  for (const v of variants) {
    for (const name of ["orchestratorPrompt", "workerPrompt", "reviewerPrompt"]) assert.equal(copy[name](v), original[name](v), name);
  }
});
