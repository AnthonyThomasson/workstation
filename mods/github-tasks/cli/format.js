// What herdr-tasks prints for each answer (without --json, which prints the answer's data as it came): plain lines, no colour.
// data: what the bridge's handler for the op answered (cli-ui/handlers.js has the shapes).

const STATUS_WORDS = { working: "working", blocked: "needs you", done: "done", idle: "idle", error: "error", finished: "finished", unknown: "running" };
const word = (status) => STATUS_WORDS[status] ?? status ?? "";

const ref = (t) => (t?.number ? `#${t.number}` : "draft");
const labels = (t) => (t?.labels?.length ? `  [${t.labels.join(", ")}]` : "");
// A ticket's run, on its row: "▶ working", "▶ needs you (2 waiting)".
const runBit = (run) => {
  if (!run) return "";
  const waiting = run.waiting ? ` (${run.waiting} waiting for you)` : "";
  return `  ▶ ${run.live === false ? "ended" : word(run.status)}${waiting}`;
};
export const ticketRow = (t) => `${ref(t).padEnd(6)} ${t.title}${labels(t)}${runBit(t.run)}`;
const board = (d) => `${d.repo}${d.project ? ` · ${d.project.title}` : ""}`;

function list(d) {
  const lines = [board(d)];
  if (d.truncated) lines.push("(Only the project's first items were read, so some tickets may be missing.)");
  for (const s of d.sections ?? []) {
    lines.push("", `${s.label} · ${s.items.length}`);
    if (!s.items.length) lines.push("  (nothing)");
    for (const item of s.items) lines.push(`  ${s.id === "investigations" ? investigationRow(item) : ticketRow(item)}`);
  }
  return lines.join("\n");
}

const investigationRow = (i) => `${i.id}  ${i.label}  · ${i.ended ? "ended" : word(i.status)}${i.waiting ? ` (${i.waiting} waiting for you)` : ""}`;

function agentLines(agents) {
  const rows = [];
  for (const [title, list] of [["Workers", agents?.workers], ["Reviewers", agents?.reviewers], ["Investigators", agents?.investigators]]) {
    if (!list?.length) continue;
    rows.push(`  ${title}:`);
    for (const a of list) rows.push(`    ${a.name} · ${word(a.status)}${a.live ? ` (${a.address})` : ""}${a.detail ? ` · ${a.detail}` : ""}`);
  }
  return rows;
}

function runLines(run) {
  if (!run) return [];
  const lines = [`Run ${run.id}${run.workflow ? ` · ${run.workflow}` : ""}${run.branch ? ` · ${run.branch}` : ""}`];
  lines.push(`  Task Orchestrator: ${run.live ? `${word(run.status)} (${run.orchestrator})` : "ended"}`);
  if (run.folder) lines.push(`  Worktree: ${run.folder}`);
  lines.push(...agentLines(run.agents));
  if (run.pr) lines.push(`  Pull request: #${run.pr.number} ${run.pr.url}${run.pr.state ? ` (${run.pr.state.toLowerCase()})` : ""}`);
  if (run.merge) lines.push(`  Merge: ${mergeText(run.merge)}`);
  return lines;
}

// The Merge button as words: what pressing it (herdr-tasks merge) would do, or what it waits for.
export function mergeText(m) {
  if (m.mode === "hidden") return m.wait || "not yet";
  if (m.mode === "fixing") return `waiting for the Task Orchestrator to fix it${m.note ? `: ${m.note}` : ""}`;
  if (m.mode === "red") return `failed: ${m.error ?? ""} (merge --yes hands it to the Task Orchestrator: ${m.label})`;
  return m.enabled ? "ready (merge --yes)" : m.label;
}

function show(d) {
  const t = d.ticket;
  const lines = [`${ref(t)} ${t.title}`, `Status: ${t.status ?? "none"}${t.state === "CLOSED" ? " (closed)" : ""}`];
  if (t.labels?.length) lines.push(`Labels: ${t.labels.join(", ")}`);
  if (t.url) lines.push(t.url);
  if (d.workflows) {
    lines.push(d.workflows.length ? `Start would run: ${d.workflows.map((w) => `${w.name} (${w.id})`).join(", ")}${d.workflows.length > 1 ? " (pick one with --workflow)" : ""}`
      : "No workflow matches its labels, so Start has nothing to run.");
  }
  if (d.run) lines.push("", ...runLines(d.run));
  lines.push("", t.body?.trim() ? t.body.trimEnd() : "(no description)");
  return lines.join("\n");
}

function runs(d) {
  if (!d.runs.length) return "No workflow runs.";
  return d.runs.map((r) => {
    const head = `${r.id}  ${r.title ?? r.ticket ?? ""}  · ${r.live ? word(r.status) : "ended"}${r.waiting ? ` (${r.waiting} waiting for you)` : ""}`;
    return [head, `  ${r.orchestrator}${r.folder ? ` · ${r.folder}` : ""}`].join("\n");
  }).join("\n");
}

function merge(d) {
  switch (d.outcome) {
    case "merged": return `Merged${d.pr ? ` ${d.pr.url}` : ""}.${d.note ? ` ${d.note.text ?? d.note}` : " The run's space is closed."}`;
    case "fixing": return `Handed to the Task Orchestrator (${d.label}). Run merge again once it has fixed it.`;
    default: return String(d.outcome);
  }
}

function workflows(d) {
  const lines = d.items.length ? d.items.map((w) => `${w.id.padEnd(20)} ${w.name}  · ${w.scope}${w.trigger ? `  · ${w.trigger}` : ""}`) : [`No ${d.kind === "refactor" ? "refactor types" : "workflows"} here.`];
  for (const e of d.errors ?? []) lines.push(`! can't read ${e}`);
  return lines.join("\n");
}

function projects(d) {
  if (!d.projects.length) return `${d.repo}: no GitHub Project is linked. Make one with: herdr-tasks project create`;
  return [d.repo, ...d.projects.map((p) => `${p.chosen ? "*" : " "} ${p.title}  ${p.url}  (${p.id})`)].join("\n");
}

const FORMATS = {
  list,
  show,
  create: (d) => `Created ${ref(d.ticket)} ${d.ticket.title}${d.ticket.url ? ` ${d.ticket.url}` : ""} in ${d.ticket.status ?? "no status"}.`,
  edit: (d) => (d.changed.length ? `Saved ${ref(d.ticket)}: ${d.changed.join(", ")}.` : `${ref(d.ticket)} already says that: nothing to save.`),
  move: (d) => (d.moved ? `Moved ${ref(d.ticket)} to ${d.section}${d.status ? ` (status ${d.status})` : ""}.` : `${ref(d.ticket)} is already there.`),
  wontdo: (d) => `${ref(d.ticket)} is Won't Do and closed as not planned.`,
  open: (d) => `Opened ${ref(d.ticket)} in Herdr.`,
  start: (d) => (d.resumed ? `${ref(d.ticket)} is already running: its tab is in front.` : `Started ${d.workflow} on ${ref(d.ticket)}${d.run ? `: run ${d.run.id}, Task Orchestrator ${d.run.orchestrator}` : ""}.`),
  view: (d) => `${ref(d.ticket)}'s run tab is in front.`,
  runs,
  merge,
  "new-task": (d) => `Started ${d.investigation.label} (${d.investigation.id}) on branch ${d.investigation.branch}: its tab is open.`,
  refactor: (d) => (d.types ? (d.types.length ? d.types.map((t) => `${t.key.padEnd(24)} ${t.name}  · ${t.badge}`).join("\n") : "No refactor types here.")
    : `Started ${d.investigation.label} (${d.investigation.id}) on branch ${d.investigation.branch}: its tab is open.`),
  investigations: (d) => (d.investigations.length ? d.investigations.map(investigationRow).join("\n") : "No New Task or refactor sessions for this repo."),
  "investigation-view": (d) => `${d.investigation.label}'s tab is in front.`,
  "investigation-done": (d) => `Done: ${d.investigation.label} ended and its worktree and branch are gone.`,
  projects,
  "project-use": (d) => `Tasks now shows ${d.project.title} for ${d.repo}.`,
  "project-create": (d) => [`Created ${d.project.title} ${d.project.url}.`, ...(d.note ? [d.note] : [])].join("\n"),
  workflows,
  doctor: (d) => (!d.found ? "The doctor hasn't looked at this place yet." : d.issues.length ? d.issues.map((i) => `! ${i.message}`).join("\n") : "The doctor found nothing wrong.")
    + (d.place?.cwd ? `\n(for ${d.place.cwd}, the folder the Tasks sidebar shows)` : ""),
  refresh: () => "The Tasks sidebar is reloading.",
};

// The text for a reply to op: its data's lines, or the error, with the choices when a choice is needed.
export function formatReply(op, reply) {
  if (!reply?.ok) {
    const lines = [`herdr-tasks: ${reply?.error ?? "It failed."}`];
    for (const c of reply?.data?.choices ?? []) lines.push(`  ${String(c.id).padEnd(20)} ${c.name}${c.scope ? `  · ${c.scope}` : ""}`);
    return lines.join("\n");
  }
  const format = FORMATS[op];
  return format ? format(reply.data ?? {}) : JSON.stringify(reply.data ?? {}, null, 2);
}
