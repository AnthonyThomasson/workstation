// What a workflow is: the GitHub labels that trigger it, and how the orchestrator, the worker and the
// reviewer each run (their prompt, agent, model and effort). Pure: no Herdr imports, so node --test runs it.

export const VERSION = 1;
export const ROLES = ["orchestrator", "worker", "reviewer"];
export const ROLE_LABELS = { orchestrator: "Orchestrator", worker: "Worker", reviewer: "Reviewer" };
// The agent kinds `herdr agent start --kind` accepts.
export const AGENTS = ["claude", "codex", "gemini", "pi", "cursor", "devin", "agy", "cline", "omp", "mastracode", "opencode",
  "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli", "qwen", "letta", "maki", "muse"];
// An agent that is not one of those: its `command` is what opens it (run in the space's folder).
export const CUSTOM = "custom";
export const AGENT_LABELS = { [CUSTOM]: "Custom command" };
// A workflow with no trigger labels is the fallback: it starts only for a ticket whose labels match no
// other workflow's trigger.
export const FALLBACK_HINT = "No labels: this workflow starts only for a ticket that matches none of the other workflows' labels.";
export const isFallback = (workflow) => normalize(workflow).trigger.labels.length === 0;
// With several trigger labels: whether an issue with any one of them starts the workflow, or only one
// that has all of them.
export const MATCHES = ["any", "all"];
export const MATCH_LABELS = { any: "Any of them", all: "All of them" };
export const MATCH_HINTS = {
  any: "Starts when an issue gets any one of these labels.",
  all: "Starts only once an issue has every one of these labels.",
};
// Where a workflow is kept. The folder it is in says which, so the file does not.
//   global  in the workstation repo's herdr-app/workflows, which Skillshare's push and pull carry to
//           other machines, and to other people using the same repo
//   repo    in <repo>/.herdr/workflows of the repo a space is in, committed with that project
export const SCOPES = ["global", "repo"];
export const SCOPE_LABELS = { global: "Global", repo: "Repo" };
export const SCOPE_HINTS = {
  global: "Kept in the workstation repo. Push it with Skillshare to sync it to your other machines and to other people.",
  repo: "Kept in the repo's .herdr/workflows folder, to commit with the repo. Listed only while a space in that repo is selected.",
};
// Besides its own prompt, the orchestrator has one for planning the work and one for the retro after it.
// Both are optional: left empty, that step gets no extra instructions.
export const ORCHESTRATOR_PROMPTS = [
  { key: "planning", label: "Planning prompt", hint: "how the orchestrator plans the work before handing it to the worker" },
  { key: "retro", label: "Retro prompt", hint: "how the orchestrator looks back on the run once it is done" },
];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// How the work is kept apart from the main checkout: a branch in the folder the space is in, or a git
// worktree of its own, so several runs can go at once without sharing files.
export const STRATEGIES = ["branch", "worktree"];
export const STRATEGY_LABELS = { branch: "Branch", worktree: "Worktree" };
export const STRATEGY_HINTS = {
  branch: "Work on a new branch in the space's folder. One run at a time.",
  worktree: "Work in a separate git worktree on its own branch. Runs can go in parallel.",
};

const text = (v) => (typeof v === "string" ? v : "");

export const blankRole = () => ({ prompt: "", agent: "claude", command: "", model: "", effort: "medium" });
export const blankOrchestrator = () => ({ ...blankRole(), planning: "", retro: "" });
export const blank = () => ({
  version: VERSION, id: "", name: "", strategy: "branch", trigger: { labels: [], match: "any" },
  orchestrator: blankOrchestrator(), worker: blankRole(), reviewer: blankRole(),
});

// "Feature development!" -> "feature-development"; what a workflow's file is called.
export const slug = (name) => text(name).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");

// Labels trimmed, empty ones dropped, and each kept once (GitHub's label names match without regard to case).
export function uniqueLabels(list) {
  const seen = new Set(), out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const label = text(v).trim(), key = label.toLowerCase();
    if (label && !seen.has(key)) { seen.add(key); out.push(label); }
  }
  return out;
}

function normalizeTrigger(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const labels = uniqueLabels(r.labels);
  // A file from before a trigger had several labels holds one, as `label`.
  const list = labels.length || typeof r.label !== "string" ? labels : uniqueLabels([r.label]);
  return { labels: list, match: text(r.match) || "any" };
}

function normalizeRole(raw, extras = []) {
  const r = raw && typeof raw === "object" ? raw : {};
  const base = blankRole();
  const agent = text(r.agent) || base.agent; // an agent kind this list doesn't know is kept, so a newer file survives
  return {
    prompt: text(r.prompt),
    agent,
    command: agent === CUSTOM ? text(r.command).trim() : "", // only a custom agent has one
    model: text(r.model).trim(),
    effort: text(r.effort) || base.effort,
    ...Object.fromEntries(extras.map((key) => [key, text(r[key])])),
  };
}
const normalizeOrchestrator = (raw) => normalizeRole(raw, ORCHESTRATOR_PROMPTS.map((p) => p.key));

// Whatever was read from a file, shaped as a workflow. Never throws; validate() says what is wrong.
export function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    version: VERSION,
    id: text(r.id),
    name: text(r.name).trim(),
    strategy: text(r.strategy) || "branch", // an older file has none, and worked on a branch
    trigger: normalizeTrigger(r.trigger),
    orchestrator: normalizeOrchestrator(r.orchestrator),
    worker: normalizeRole(r.worker),
    reviewer: normalizeRole(r.reviewer),
  };
}

// What is wrong with a workflow: [{ field, message }], empty when it can be saved.
// takenIds: the ids of the other workflows, so a new name cannot land on one.
export function validate(workflow, takenIds = []) {
  const w = normalize(workflow), problems = [];
  const add = (field, message) => problems.push({ field, message });
  if (!w.name) add("name", "Give the workflow a name.");
  else if (!slug(w.name)) add("name", "The name needs a letter or a number.");
  else if (!w.id && takenIds.includes(slug(w.name))) add("name", "A workflow with that name already exists.");
  if (!STRATEGIES.includes(w.strategy)) add("strategy", `The work strategy must be one of ${STRATEGIES.join(", ")}.`);
  if (!MATCHES.includes(w.trigger.match)) add("match", `The trigger must match ${MATCHES.join(" or ")} of its labels.`);
  for (const role of ROLES) {
    const r = w[role], name = ROLE_LABELS[role];
    if (!r.prompt.trim()) add(`${role}.prompt`, `${name} needs a prompt.`);
    if (!r.agent) add(`${role}.agent`, `${name} needs an agent.`);
    if (r.agent === CUSTOM && !r.command) add(`${role}.command`, `${name} needs the command that opens its agent.`);
    if (!EFFORTS.includes(r.effort)) add(`${role}.effort`, `${name}'s effort must be one of ${EFFORTS.join(", ")}.`);
  }
  return problems;
}

// The comparable form of a workflow, to tell whether the editor holds unsaved changes.
export const snapshot = (workflow) => JSON.stringify(normalize(workflow));
export const isDirty = (base, current) => snapshot(base) !== snapshot(current);

// The file's text: keys in a fixed order, two-space indent, a closing newline.
export function serialize(workflow) {
  const w = normalize(workflow);
  const role = (r) => ({ prompt: r.prompt, agent: r.agent, command: r.command, model: r.model, effort: r.effort });
  return `${JSON.stringify({
    version: w.version, id: w.id, name: w.name, strategy: w.strategy, trigger: { labels: w.trigger.labels, match: w.trigger.match },
    orchestrator: { ...role(w.orchestrator), planning: w.orchestrator.planning, retro: w.orchestrator.retro }, worker: role(w.worker), reviewer: role(w.reviewer),
  }, null, 2)}\n`;
}

// A file's text as a workflow. Throws a plain Error on text that is not a JSON object.
export function parse(source) {
  let data;
  try { data = JSON.parse(source); } catch (e) { throw new Error(`not valid JSON (${e.message})`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not a workflow object");
  return normalize(data);
}
