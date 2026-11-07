import test from "node:test";
import assert from "node:assert/strict";
import { skillshareSource, firstLine, repoWorkflowsDir, syncedWorkflowsDir } from "./places.js";

const HOME = "/Users/me";

test("the skills source is read from Skillshare's config", () => {
  const yaml = `# comment\nsources:\n  skills: /Users/me/.config/skillshare/skills\n  agents: /Users/me/.config/skillshare/agents\nmode: merge\ntargets:\n  claude:\n    skills:\n      path: /elsewhere\n`;
  assert.equal(skillshareSource(yaml, HOME), "/Users/me/.config/skillshare/skills");
});

test("a source in another place, quoted or under ~, is read as it is", () => {
  assert.equal(skillshareSource('sources:\n  skills: "/data/my skills"\n', HOME), "/data/my skills");
  assert.equal(skillshareSource("sources:\n  skills: '~/dotfiles/skills'  # mine\n", HOME), "/Users/me/dotfiles/skills");
  assert.equal(skillshareSource("sources:\n  skills: ~\n", HOME), HOME);
});

test("a target's skills entry is not the source", () => {
  const yaml = `targets:\n  claude:\n    skills:\n      path: /elsewhere\nsources:\n  agents: /a\n`;
  assert.equal(skillshareSource(yaml, HOME), `${HOME}/.config/skillshare/skills`);
  // nor one after the sources block
  assert.equal(skillshareSource("sources:\n  agents: /a\nother:\n  skills: /nope\n", HOME), `${HOME}/.config/skillshare/skills`);
});

test("no config, an empty one or an odd one gives Skillshare's default source", () => {
  for (const text of [null, undefined, "", "mode: merge\n", "sources:\n"]) assert.equal(skillshareSource(text, HOME), `${HOME}/.config/skillshare/skills`);
});

test("firstLine takes the first non-empty line, trimmed", () => {
  assert.equal(firstLine("\n  /a/b  \n/c\n"), "/a/b");
  assert.equal(firstLine(""), null);
  assert.equal(firstLine(undefined), null);
  assert.equal(firstLine("  \n \n"), null);
});

test("workflows are kept in .herdr of a repo and herdr-app of the workstation repo", () => {
  assert.equal(repoWorkflowsDir("/code/app"), "/code/app/.herdr/workflows");
  assert.equal(syncedWorkflowsDir("/code/workstation"), "/code/workstation/herdr-app/workflows");
});
