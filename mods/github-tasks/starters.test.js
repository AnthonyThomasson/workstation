import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "./yaml.js";
import { normalize, validate } from "./workflow-model.js";

const dir = new URL("./starters/", import.meta.url);
const load = (file) => parseYaml(readFileSync(new URL(file, dir), "utf8"));
const PROMPTS = [["orchestrator", "planning"], ["orchestrator", "retro"], ["orchestrator", "prompt"], ["worker", "prompt"], ["reviewer", "prompt"]];

for (const file of ["bug.yaml", "story.yaml"]) {
  test(`${file} passes the workflow model with no problems`, () => {
    const data = load(file);
    assert.deepEqual(validate(normalize(data)), []);
    assert.equal(normalize(data).id, data.id);
  });

  test(`${file} prompts are each a single sentence`, () => {
    const data = load(file);
    for (const [role, key] of PROMPTS) {
      const prompt = data[role][key];
      if (prompt === "") continue;
      const label = `${file} ${role}.${key}`;
      assert.equal(typeof prompt, "string", label);
      assert.equal(prompt, prompt.trim(), `${label} has stray whitespace`);
      assert.match(prompt, /[.!?]$/, `${label} must end with . ! or ?`);
      // a terminator followed by whitespace or the end is a sentence boundary ("AGENTS.md" is not one)
      assert.equal(prompt.match(/[.!?](\s|$)/g).length, 1, `${label} must be one sentence: ${prompt}`);
    }
  });

  test(`${file} retro proposes follow-up tickets with the question tool and adds the picked ones to To Do`, () => {
    assert.equal(load(file).orchestrator.retro, "Look back on what slowed the run and what to write down for next time, then propose follow-up tickets with the question tool and add the ones the person picks to To Do.");
  });

  test(`${file} prompts do not mention a skill`, () => {
    const data = load(file);
    for (const [role, key] of PROMPTS) assert.doesNotMatch(data[role][key], /skill|mattpocock/i, `${file} ${role}.${key}`);
  });
}
