// Which workflows a ticket starts, with no Herdr in it. A workflow is a YAML file (see workflow-model.js, store.js):
// the labels that trigger it, and how its roles run. Only the trigger is read here.

const key = (label) => String(label ?? "").trim().toLowerCase(); // GitHub's label names match without regard to case

const triggers = (workflow, have) => {
  const { labels, match } = workflow.trigger;
  if (!labels.length) return false;
  const hits = labels.map((l) => have.has(key(l)));
  return match === "all" ? hits.every(Boolean) : hits.some(Boolean);
};

// A ticket with this label runs as one agent, in the ticket's worktree, with no jobs, reviewers or orchestrator (run.js soloPrompt).
export const EASY_LABEL = "easy";
export const isEasy = (ticket) => (ticket?.labels ?? []).some((l) => key(l) === EASY_LABEL);

// The workflows a ticket with these labels starts. A workflow with no trigger labels is the fallback: it
// starts only when no other workflow does.
export function matchWorkflows(workflows, labels) {
  const have = new Set((labels ?? []).map(key));
  const hits = workflows.filter((w) => triggers(w, have));
  return hits.length ? hits : workflows.filter((w) => !w.trigger.labels.length);
}
