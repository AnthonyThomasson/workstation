// Which workflows a ticket starts, with no Herdr in it. A workflow is a YAML file kept by the Workflows
// mod (see mods/workflows/model.js): the labels that trigger it, and how its roles run. What is needed to
// match is read here, along with the strategy and the roles, which start.js runs it with.

import { parse as parseYaml } from "./yaml.js";

const text = (v) => (typeof v === "string" ? v : "");
const key = (label) => text(label).trim().toLowerCase(); // GitHub's label names match without regard to case

function labelsOf(list) {
  const seen = new Set(), out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const label = text(v).trim();
    if (label && !seen.has(key(label))) { seen.add(key(label)); out.push(label); }
  }
  return out;
}

// A role as it is run. A file without planning, retro or testing prompts has them empty.
function roleOf(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return { prompt: text(r.prompt), agent: text(r.agent) || "claude", command: text(r.command).trim(), model: text(r.model).trim(), effort: text(r.effort) || "medium", planning: text(r.planning), retro: text(r.retro), testing: text(r.testing) };
}

// A workflow file's text as { id, name, scope, strategy, trigger: { labels, match }, orchestrator, worker, reviewer }.
// Throws a plain Error on text that is not a map (YAML, or the JSON older files hold). A file from before triggers had several labels holds
// one, as `label`.
export function parseWorkflow(source, { id, scope }) {
  let data;
  const asJson = /^\s*\{/.test(source); // workflows used to be saved as JSON
  try { data = asJson ? JSON.parse(source) : parseYaml(source); } catch (e) { throw new Error(`not valid ${asJson ? "JSON" : "YAML"} (${e.message})`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not a workflow object");
  const trigger = data.trigger && typeof data.trigger === "object" ? data.trigger : {};
  const labels = labelsOf(trigger.labels);
  return {
    id, scope,
    name: text(data.name).trim() || id,
    strategy: data.strategy === "worktree" ? "worktree" : "branch",
    trigger: { labels: labels.length || typeof trigger.label !== "string" ? labels : labelsOf([trigger.label]), match: trigger.match === "all" ? "all" : "any" },
    orchestrator: roleOf(data.orchestrator), worker: roleOf(data.worker), reviewer: roleOf(data.reviewer),
  };
}

const triggers = (workflow, have) => {
  const { labels, match } = workflow.trigger;
  if (!labels.length) return false;
  const hits = labels.map((l) => have.has(key(l)));
  return match === "all" ? hits.every(Boolean) : hits.some(Boolean);
};

// The workflows a ticket with these labels starts. A workflow with no trigger labels is the fallback: it
// starts only when no other workflow does.
export function matchWorkflows(workflows, labels) {
  const have = new Set((labels ?? []).map(key));
  const hits = workflows.filter((w) => triggers(w, have));
  return hits.length ? hits : workflows.filter((w) => !w.trigger.labels.length);
}

// ---- Where workflows are kept (the same places the Workflows mod uses) -------------------------------

// The folder Skillshare keeps its skills in, from its config.yaml (sources: skills: <path>). Its git repo is
// the workstation repo, where global workflows are kept.
export function skillshareSource(configText, home) {
  const fallback = `${home}/.config/skillshare/skills`;
  let inSources = false;
  for (const line of String(configText ?? "").split(/\r?\n/)) {
    if (/^sources:\s*(#.*)?$/.test(line)) { inSources = true; continue; }
    if (inSources && /^\S/.test(line)) break;
    const m = inSources && /^\s+skills:\s*(.+?)\s*(#.*)?$/.exec(line);
    if (m) {
      const path = m[1].replace(/^(["'])(.*)\1$/, "$2");
      return path === "~" ? home : path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
    }
  }
  return fallback;
}

export const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? null;
export const repoWorkflowsDir = (repoRoot) => `${repoRoot}/.herdr/workflows`;
export const globalWorkflowsDir = (workstationRoot) => `${workstationRoot}/herdr-app/workflows`;
