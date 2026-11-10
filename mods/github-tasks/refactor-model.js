// What a refactor type is: how its orchestrator, its investigators and its prototype workers run (agent, model, effort and prompt).
// It mirrors workflow-model.js and reuses its helpers; there is no trigger, no permissions and no planning or
// retro prompt. Pure: no Herdr imports, so node --test runs it.

import { stringify as stringifyYaml } from "./yaml.js";
import { EFFORTS } from "./model.js";
import { blankRole, normalizeRole, parseFile, slug, CUSTOM } from "./workflow-model.js";

// Everything a refactor type shares with a workflow is the same thing here, not a copy.
export { slug, AGENTS, CUSTOM, AGENT_LABELS, SCOPES, SCOPE_LABELS, blankRole } from "./workflow-model.js";
export { EFFORTS };

export const VERSION = 1;
export const ROLES = ["orchestrator", "investigator", "worker"];
export const ROLE_LABELS = { orchestrator: "Orchestrator", investigator: "Investigator", worker: "Worker" };
// No role has extra prompts (a workflow's orchestrator has planning and retro); same shape as workflow-model.js.
export const ROLE_PROMPTS = { orchestrator: [], investigator: [], worker: [] };
// Where a refactor type is kept, as for workflows but in the refactors folders.
export const SCOPE_HINTS = {
  global: "Kept in ~/.config/herdr-app/refactors, for every project on this computer.",
  repo: "Kept in the repo's .herdr/refactors folder, to commit with the repo. Listed only while a space in that repo is selected.",
};

export const blank = () => ({ version: VERSION, id: "", name: "", orchestrator: blankRole(), investigator: blankRole(), worker: blankRole() });

const text = (v) => (typeof v === "string" ? v : "");

// Whatever was read from a file, shaped as a refactor type. Never throws; validate() says what is wrong.
export function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    version: VERSION,
    id: text(r.id),
    name: text(r.name).trim(),
    orchestrator: normalizeRole(r.orchestrator),
    investigator: normalizeRole(r.investigator),
    worker: normalizeRole(r.worker), // a file from before prototype workers has none: the defaults, and it gains the section on its next save
  };
}

// What is wrong with a refactor type: [{ field, message }], empty when it can be saved.
// takenIds: the ids of the other refactor types, so a new name cannot land on one.
export function validate(refactor, takenIds = []) {
  const x = normalize(refactor), problems = [];
  const add = (field, message) => problems.push({ field, message });
  if (!x.name) add("name", "Give the refactor a name.");
  else if (!slug(x.name)) add("name", "The name needs a letter or a number.");
  else if (!x.id && takenIds.includes(slug(x.name))) add("name", "A refactor with that name already exists.");
  if (!x.orchestrator.prompt.trim()) add("orchestrator.prompt", "Give the refactor a prompt.");
  for (const role of ROLES) {
    const r = x[role], name = ROLE_LABELS[role];
    if (!r.agent) add(`${role}.agent`, `${name} needs an agent.`);
    if (r.agent === CUSTOM && !r.command) add(`${role}.command`, `${name} needs the command that opens its agent.`);
    if (!EFFORTS.includes(r.effort)) add(`${role}.effort`, `${name}'s effort must be one of ${EFFORTS.join(", ")}.`);
  }
  return problems;
}

// The comparable form of a refactor type, to tell whether the editor holds unsaved changes.
export const snapshot = (refactor) => JSON.stringify(normalize(refactor));
export const isDirty = (base, current) => snapshot(base) !== snapshot(current);

// The file's text, as YAML: keys in a fixed order, the settings before the long prompts so the file reads
// top down, and a closing newline.
export function serialize(refactor) {
  const x = normalize(refactor);
  const role = (r) => ({ agent: r.agent, command: r.command, model: r.model, effort: r.effort, prompt: r.prompt });
  return stringifyYaml({
    version: x.version, id: x.id, name: x.name,
    orchestrator: role(x.orchestrator),
    investigator: role(x.investigator),
    worker: role(x.worker),
  });
}

// A file's text as a refactor type. Throws a plain Error on text that is not a map.
export function parse(source) {
  return normalize(parseFile(source, "refactor"));
}
