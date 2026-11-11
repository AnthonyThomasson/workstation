// The New Task Orchestrator and its helpers' saved agent, model and effort settings.

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// The saved grooming agent choice: { agent (key or null for "pick the default"), model ("" = the agent's own), effort }.
export function normalizeGroomer(raw) {
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  return { agent: text(raw?.agent) || null, model: text(raw?.model), effort: EFFORTS.includes(raw?.effort) ? raw.effort : "medium" };
}

// The New Task Orchestrator's own helpers (investigation-spawn.js): the investigators and prototype workers it may start. Each has its own
// agent, model and effort, saved apart from the New Task Orchestrator's: { agent, model, effort }, claude / "" (the agent's own) / medium.
// "custom" (a workflow's own command) is not a choice here, so a saved one reads as the default.
export const normalizeSubAgent = (raw) => {
  const g = normalizeGroomer(raw);
  return { ...g, agent: g.agent && g.agent !== "custom" ? g.agent : "claude" };
};

// The command that opens the grooming agent: its own command plus the model and effort the person chose.
// Only Claude and Codex take an effort; any other agent just gets --model when one is set.
export function groomArgv(agent, base, { model, effort }) {
  const argv = [...(base?.length ? base : [agent])];
  if (agent === "claude") {
    if (model) argv.push("--model", model);
    argv.push("--effort", effort || "medium");
  } else if (agent === "codex") {
    if (model) argv.push("-m", model);
    if (effort) argv.push("-c", `model_reasoning_effort=${effort}`);
  } else if (model) argv.push("--model", model);
  return argv;
}
