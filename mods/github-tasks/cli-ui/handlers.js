// What each herdr-tasks command does, in the Herdr app: the same calls the Tasks UI's buttons make (main.js's rows and header, the
// ticket editor, the Start dialog, the run page, the New task and Refactor dialogs, the investigation page, the sidebar's projects),
// with the request's folder as the place the sidebar would be looking at. HANDLERS[op](request, cx) resolves with the reply's data or
// throws (a CliError for a reply code); cx is the spawned task's, for the steps that wait on the app. bridge.js reads the requests and
// writes the replies; cli/format.js prints the data.
import { home, openOverlay, readTextFile, setShared, shared, terminals } from "herdr";
import { GitHubError, createProject, createTicket, findProjects, findRepo, loadItems, loadStatusField, loadTask, markWontDo, moveTicket, saveTask, setupNote, setupProject } from "../github/index.js";
import { CHANGED, DOCTOR_KEY, FOLDER_LABEL, INVESTIGATION_LABEL, PLACE, ROLE_LABEL, RUN_LABEL, STATUSES, TICKET_LABEL, chooseProject, editorOverlay, groupByStage, groupTickets, normalizeItems, pickableStatuses, planMove, projectKey, sameStatus, sectionOf, sectionPlan, waitingAgents } from "../lib/index.js";
import { RunPage, liveRunFor, readPlace, runProps, startChosen, viewRun } from "../runs-ui/index.js";
import { cantStartHere, orchestratorOf, rowDetail, ticketKey } from "../runs/index.js";
import { matchWorkflows, runPanePath } from "../workflow/index.js";
import { loadRefactors, loadWorkflows } from "../workflow-ui/index.js";
import { finishInvestigation, investigationsHere, loadTypes, startTask, viewInvestigation } from "../investigations-ui/index.js";
import { investigationRow, newTaskProps, pickKey, pickValue } from "../investigations/index.js";
import { doctorFor } from "../doctor/index.js";
import { gh } from "../widgets/index.js";
import { CliError, findNamed, findTicket, pickProject } from "../cli/index.js";

// The place a request acts from, as the sidebar's `where`: { cwd, on }.
const placeOf = (req) => ({ cwd: req.where.cwd, on: req.where.on ?? undefined });

// Tells the sidebar its list is stale (as the editor's Save does), so it reloads.
const changed = () => setShared(CHANGED, Date.now());

// What a gh failure means for someone at a shell: lib/gh-sign-in.js's kinds, with the command that fixes it.
export function explain(e, req) {
  const message = String(e?.message ?? e);
  if (!(e instanceof GitHubError)) return message;
  switch (e.kind) {
    case "no-scope": case "no-write-scope": return `${message} gh's token needs the "project" scope: run gh auth refresh -h github.com -s project`;
    case "no-auth": return "gh isn't signed in to GitHub: run gh auth login -h github.com -s project";
    case "not-a-repo": return `${req?.where?.cwd ?? "This folder"} isn't in a GitHub repo.`;
    default: return `GitHub didn't answer: ${message}`;
  }
}

// The repo, its projects and the project in use (--project, else the sidebar's pick for the repo), and with items the project's tickets.
async function boardFor(req, { items = true } = {}) {
  const where = placeOf(req);
  const repo = await findRepo(gh, where);
  const projects = await findProjects(gh, repo, where);
  const picked = pickProject(projects, req.project, chooseProject(projects, shared(projectKey(repo))));
  if (picked.error) throw new CliError(picked.error);
  const board = { where, repo, projects, project: picked.project };
  if (!items) return board;
  const { nodes, truncated } = await loadItems(gh, board.project.id, where);
  return { ...board, tickets: normalizeItems(nodes, repo), truncated };
}

const ticketOf = (board, ref) => {
  const found = findTicket(board.tickets, ref);
  if (found.error) throw new CliError(found.error);
  return found.ticket;
};
const refOf = (t) => (t.number ? `#${t.number}` : `"${t.title}"`);

const projectOf = (p) => (p ? { id: p.id, title: p.title, url: p.url } : null);
const plainTicket = (t) => ({ key: t.key, number: t.number ?? null, title: t.title, status: t.status ?? null, state: t.state ?? "OPEN", labels: t.labels ?? [], draft: Boolean(t.draft), url: t.url ?? null });
const workflowOf = (w) => ({ id: w.id, name: w.name, scope: w.scope });

// A ticket's live run, in short, for its row: what the sidebar shows (Start becomes View; the bell when an agent needs you).
function runRow(repo, ticket, all) {
  const running = liveRunFor(repo, ticket);
  if (!running) return null;
  const id = running.labels?.[RUN_LABEL] ?? null;
  return { id, orchestrator: running.address, live: true, status: orchestratorOf(all, running.address)?.status ?? "unknown", waiting: waitingAgents(all, RUN_LABEL, id).length };
}

// A New Task or refactor session, for its row.
function sessionOf(entry, all = terminals()) {
  const row = investigationRow(entry);
  return { id: entry.id, label: row.text, status: row.status, ended: row.ended, branch: entry.branch ?? null, agent: entry.agent ?? null, folder: entry.workDir ?? null, waiting: waitingAgents(all, INVESTIGATION_LABEL, entry.id).length };
}

// The sessions of the request's repo, as the sidebar's Investigations section finds them.
async function sessionsHere(req, repo) {
  const where = placeOf(req);
  const place = await readPlace({ folder: where.cwd, on: where.on }, null);
  return investigationsHere({ repoRoot: place.remote ? null : place.mainRoot ?? null, repo });
}

// The run page of a ticket's run: its live orchestrator's, else the newest ended one whose run hasn't been merged (its pane.json is
// still there: Merge removes the run folder). null when the ticket has none. The page is made here, as View would open it.
async function runPageFor(board, ticket) {
  const key = ticketKey(board.repo, ticket);
  const running = liveRunFor(board.repo, ticket) ?? terminals()
    .filter((k) => k.labels?.[ROLE_LABEL] === "orchestrator" && k.labels?.[TICKET_LABEL] === key && k.labels?.[RUN_LABEL])
    .sort((a, b) => (b.created_ms ?? 0) - (a.created_ms ?? 0))[0] ?? null;
  if (!running) return null;
  if (running.state !== "live" && !(await readTextFile(runPanePath(home(), running.labels[RUN_LABEL])).catch(() => null))) return null;
  return new RunPage(await runProps(running, { ticket, project: board.project }));
}

// The ticket's labels with these put on and taken off (the names as given; taking off ignores case, as GitHub does).
function relabel(labels, add = [], remove = []) {
  const gone = new Set(remove.map((l) => l.toLowerCase()));
  const kept = (labels ?? []).filter((l) => !gone.has(l.toLowerCase()));
  for (const l of add) if (!kept.some((k) => k.toLowerCase() === l.toLowerCase())) kept.push(l);
  return kept;
}

const SECTION_NAMES = { next: "Up Next", backlog: "Backlog" };
const NOT_SAVED = (status) => (sameStatus(status, STATUSES.wontDo) ? "Won't Do is set with herdr-tasks wontdo, which also closes the issue." : null);

export const HANDLERS = {
  // The sidebar's list: Investigations, Up Next, Backlog, In Progress and In Review, in its order.
  async list(req) {
    const board = await boardFor(req);
    const all = terminals();
    const { groomed, backlog, inProgress, inReview } = groupByStage(groupTickets(board.tickets).open);
    const row = (t) => ({ ...plainTicket(t), run: runRow(board.repo, t, all) });
    const lists = {
      investigations: (await sessionsHere(req, board.repo)).map((e) => sessionOf(e, all)),
      next: groomed.map(row), backlog: backlog.map(row), progress: inProgress.map(row), review: inReview.map(row),
    };
    const everyOpen = Object.fromEntries(Object.keys(lists).map((id) => [id, true]));
    const sections = sectionPlan(lists, everyOpen).filter((s) => !req.args.section || s.id === req.args.section).map(({ id, label, items }) => ({ id, label, items }));
    return { repo: board.repo, project: projectOf(board.project), truncated: board.truncated, sections };
  },

  // A ticket as the editor loads it, what Start would choose from, and its run as the run page shows it.
  async show(req) {
    const board = await boardFor(req);
    const t = ticketOf(board, req.args.ticket);
    const [task, workflows, page] = await Promise.all([
      loadTask(gh, board.repo, t, board.where),
      loadWorkflows(board.where).then(({ items }) => matchWorkflows(items, t.labels ?? []).map(workflowOf), () => null),
      runPageFor(board, t),
    ]);
    return {
      ticket: { ...plainTicket(t), title: task.title, labels: t.draft ? [] : task.labels, body: task.body, updatedAt: task.updatedAt },
      workflows, run: page ? await page.describe(() => terminals()) : null,
    };
  },

  // A new ticket on the project, in To Do (Backlog) unless --status says otherwise.
  async create(req) {
    const board = await boardFor(req, { items: false });
    const statusField = await loadStatusField(gh, board.project.id, board.where);
    const wanted = req.args.status ?? (statusField?.options?.some((o) => sameStatus(o.name, STATUSES.backlog)) ? STATUSES.backlog : null);
    if (NOT_SAVED(wanted)) throw new CliError("A new ticket can't start as Won't Do.");
    const ticket = await createTicket(gh, {
      repo: board.repo, project: board.project, title: req.args.title.trim(), body: req.args.body ?? "", labels: req.args.label ?? [],
      status: wanted, statusField, draft: Boolean(req.args.draft),
    }, board.where);
    changed();
    return { ticket: plainTicket(ticket) };
  },

  // The editor's Save: what GitHub has now, changed as asked, and only the difference sent (saveTask).
  async edit(req) {
    const board = await boardFor(req);
    const t = ticketOf(board, req.args.ticket);
    const { title, body, status, addLabel = [], removeLabel = [] } = req.args;
    if (t.draft && (addLabel.length || removeLabel.length)) throw new CliError("A draft has no labels: create the ticket first.");
    const [task, statusField] = await Promise.all([loadTask(gh, board.repo, t, board.where), loadStatusField(gh, board.project.id, board.where)]);
    let next = t.status ?? null;
    if (status !== undefined) {
      if (NOT_SAVED(status)) throw new CliError(NOT_SAVED(status));
      const options = pickableStatuses(statusField?.options);
      const option = options.find((o) => sameStatus(o.name, status));
      if (!option) throw new CliError(`The project has no "${status}" status. It has: ${options.map((o) => o.name).join(", ") || "none"}.`);
      next = option.name;
    }
    const before = { title: task.title, body: task.body, labels: t.draft ? [] : task.labels, status: t.status ?? null };
    const after = { title: title ?? task.title, body: body ?? task.body, labels: t.draft ? [] : relabel(task.labels, addLabel, removeLabel), status: next };
    const keys = await saveTask(gh, { repo: board.repo, ticket: t, project: board.project, statusField, before, after }, board.where);
    if (keys.length) changed();
    return { ticket: plainTicket({ ...t, ...after }), changed: keys };
  },

  // A drag of an Up Next or Backlog row: --to its section, then first (a drop on the header), --last (the end zone) or --before a row.
  async move(req) {
    const board = await boardFor(req);
    const t = ticketOf(board, req.args.ticket);
    if (t.state === "CLOSED") throw new CliError(`${refOf(t)} is closed: the sidebar's sections hold open tickets only.`);
    const from = sectionOf(t);
    if (!from) throw new CliError(`${refOf(t)} is ${t.status ? `in ${t.status}` : "in no status"}: only Up Next and Backlog tickets move like this. Set another status with herdr-tasks edit --status.`);
    let target;
    if (req.args.before !== undefined) {
      const other = ticketOf(board, req.args.before);
      const there = sectionOf(other);
      if (!there) throw new CliError(`${refOf(other)} isn't in Up Next or Backlog.`);
      if (req.args.to && there !== req.args.to) throw new CliError(`${refOf(other)} is in ${SECTION_NAMES[there]}, not ${SECTION_NAMES[req.args.to]}.`);
      target = { kind: "row", key: other.key };
    } else {
      target = { kind: req.args.last ? "end" : "header", section: req.args.to ?? from };
    }
    const statusField = await loadStatusField(gh, board.project.id, board.where);
    const plan = planMove(groupTickets(board.tickets).open, t.key, target, statusField?.options);
    if (!plan) return { ticket: plainTicket(t), moved: false, section: SECTION_NAMES[from], status: null };
    try {
      await moveTicket(gh, { projectId: board.project.id, itemId: t.key, afterId: plan.afterId, status: plan.status, statusField: plan.status ? statusField : null }, board.where);
    } finally { changed(); } // a failure part way may have moved the status already
    return { ticket: plainTicket({ ...t, status: plan.status ?? t.status }), moved: true, section: SECTION_NAMES[plan.section] ?? plan.section, status: plan.status ?? null };
  },

  // The editor's Won't Do (confirmed by --yes).
  async wontdo(req) {
    const board = await boardFor(req);
    const t = ticketOf(board, req.args.ticket);
    const statusField = await loadStatusField(gh, board.project.id, board.where);
    try { await markWontDo(gh, { repo: board.repo, ticket: t, project: board.project, statusField }, board.where); }
    finally { changed(); } // the status may have been set even though closing failed
    return { ticket: plainTicket({ ...t, status: STATUSES.wontDo, state: "CLOSED" }) };
  },

  // A click on the row: the editor popup.
  async open(req) {
    const board = await boardFor(req);
    const t = ticketOf(board, req.args.ticket);
    openOverlay(editorOverlay({ role: "editor", ticket: t, repo: board.repo, project: { id: board.project.id, title: board.project.title }, where: { cwd: board.where.cwd, on: board.where.on } }));
    return { ticket: plainTicket(t) };
  },

  // The play button (main.js startTicket): the one matching workflow, or the one --workflow names among the matches; several and no
  // --workflow is a choice to make (code "choose"), as the Start dialog would list them. A ticket whose run is going is shown (View).
  async start(req, cx) {
    const board = await boardFor(req);
    const t = ticketOf(board, req.args.ticket);
    const cant = cantStartHere(board.where);
    if (cant) throw new CliError(cant);
    const running = liveRunFor(board.repo, t);
    if (running) {
      await viewRun(running, cx, { ticket: t, repo: board.repo, project: board.project });
      return { ticket: plainTicket(t), resumed: true, workflow: null, run: { id: running.labels?.[RUN_LABEL] ?? null, orchestrator: running.address } };
    }
    const { items, errors } = await loadWorkflows(board.where);
    const matches = matchWorkflows(items, t.labels ?? []);
    const unread = errors.length ? ` These workflow files can't be read: ${errors.join("; ")}.` : "";
    let workflow;
    if (req.args.workflow) {
      const found = findNamed(matches, req.args.workflow, `workflow matching ${refOf(t)}'s labels`);
      if (found.error) throw new CliError(found.error);
      workflow = found.item;
    } else if (matches.length === 1) {
      workflow = matches[0];
    } else if (!matches.length) {
      throw new CliError(`${(t.labels ?? []).length ? `No workflow matches ${refOf(t)}'s labels (${t.labels.join(", ")}).` : `${refOf(t)} has no labels, and no workflow is the fallback.`} Make one in the Task settings.${unread}`);
    } else {
      throw new CliError(`${matches.length} workflows match ${refOf(t)}'s labels: pick one with --workflow.${unread}`, { code: "choose", data: { choices: matches.map(workflowOf) } });
    }
    const { resumed } = await startChosen(workflow, t, { repo: board.repo, project: board.project, where: board.where }, cx);
    changed();
    const now = liveRunFor(board.repo, t);
    return { ticket: plainTicket(t), resumed, workflow: workflow.name, run: now ? { id: now.labels?.[RUN_LABEL] ?? null, orchestrator: now.address } : null };
  },

  // The eye button.
  async view(req, cx) {
    const board = await boardFor(req);
    const t = ticketOf(board, req.args.ticket);
    const running = liveRunFor(board.repo, t);
    if (!running) throw new CliError(`${refOf(t)} has no run going. Start one with: herdr-tasks start ${t.number ?? t.key}`);
    await viewRun(running, cx, { ticket: t, repo: board.repo, project: board.project });
    return { ticket: plainTicket(t), run: { id: running.labels?.[RUN_LABEL] ?? null, orchestrator: running.address } };
  },

  // Every run Herdr knows of, in any repo: the live ones, and ended ones not merged yet (their pane.json is there). Newest first.
  async runs() {
    const all = terminals();
    const leads = all.filter((k) => k.labels?.[ROLE_LABEL] === "orchestrator" && k.labels?.[RUN_LABEL])
      .sort((a, b) => (b.created_ms ?? 0) - (a.created_ms ?? 0));
    const seen = new Set(), runs = [];
    for (const k of leads) {
      const id = k.labels[RUN_LABEL];
      if (seen.has(id)) continue;
      seen.add(id);
      const saved = await readTextFile(runPanePath(home(), id)).catch(() => null);
      const live = k.state === "live";
      if (!live && !saved) continue;
      let title = null;
      try { title = JSON.parse(saved)?.title ?? null; } catch { /* no pane.json */ }
      runs.push({ id, title, ticket: k.labels[TICKET_LABEL] ?? null, orchestrator: k.address, live, status: live ? orchestratorOf(all, k.address)?.status ?? "unknown" : "finished", folder: k.labels[FOLDER_LABEL] ?? null, waiting: waitingAgents(all, RUN_LABEL, id).length });
    }
    return { runs };
  },

  // The run page's Merge button (or its red button), pressed and waited for (run-page.js press).
  async merge(req) {
    const board = await boardFor(req);
    const t = ticketOf(board, req.args.ticket);
    const page = await runPageFor(board, t);
    if (!page) throw new CliError(`${refOf(t)} has no run to merge.`);
    const result = await page.press(() => terminals());
    changed();
    if (result.outcome === "waiting") throw new CliError(`Merge isn't ready: ${result.wait}`, { data: result });
    if (result.outcome === "failed") {
      throw new CliError(result.failure ? `Merge stopped: ${result.error} Run herdr-tasks merge --yes again to hand it to the Task Orchestrator (${result.failure.label}).` : `Merge failed: ${result.error}`, { data: result });
    }
    return { ticket: plainTicket(t), ...result };
  },

  // The + button's dialog, Continue pressed with the description.
  async "new-task"(req, cx) {
    const board = await boardFor(req, { items: false });
    const { entry } = await startTask(newTaskProps({ repo: board.repo, project: board.project, where: board.where }), req.args.description, cx);
    return { investigation: sessionOf(entry) };
  },

  // The broom's dialog: its types, or Start with --type (and --focus). The type is remembered for the repo, as the dialog does.
  async refactor(req, cx) {
    const rows = await loadTypes(placeOf(req));
    if (!req.args.type) return { types: rows.map(({ key, name, badge }) => ({ key, name, badge })) };
    const found = findNamed(rows.map((r) => ({ ...r, id: r.type.id })), req.args.type, "refactor type");
    if (found.error) throw new CliError(found.error);
    const board = await boardFor(req, { items: false });
    const props = newTaskProps({ repo: board.repo, project: board.project, where: board.where });
    setShared(pickKey(props.repo ?? ""), pickValue(found.item.type));
    const { entry } = await startTask(props, "", cx, { type: found.item.type, focus: String(req.args.focus ?? "").trim() });
    return { investigation: sessionOf(entry) };
  },

  async investigations(req) {
    const repo = await findRepo(gh, placeOf(req)).catch(() => null);
    return { investigations: (await sessionsHere(req, repo)).map((e) => sessionOf(e)) };
  },

  // A click on a session's row.
  async "investigation-view"(req, cx) {
    const entry = await sessionFor(req);
    await viewInvestigation(entry, cx);
    return { investigation: sessionOf(entry) };
  },

  // The session page's Done (confirmed by --yes).
  async "investigation-done"(req) {
    const entry = await sessionFor(req);
    const result = await finishInvestigation({ id: entry.id, agent: entry.agent, repoRoot: entry.repoRoot, workDir: entry.workDir, branch: entry.branch });
    if (!result.done) throw new CliError(result.error || "Done didn't finish.");
    return { investigation: sessionOf(entry) };
  },

  async projects(req) {
    const where = placeOf(req);
    const repo = await findRepo(gh, where);
    const projects = await findProjects(gh, repo, where);
    const chosen = chooseProject(projects, shared(projectKey(repo)));
    return { repo, projects: projects.map((p) => ({ ...projectOf(p), chosen: p.id === chosen?.id })) };
  },

  // A project chip in the sidebar.
  async "project-use"(req) {
    const where = placeOf(req);
    const repo = await findRepo(gh, where);
    const found = findNamed(await findProjects(gh, repo, where), req.args.project, `project linked to ${repo}`, (p) => p.title);
    if (found.error) throw new CliError(found.error);
    setShared(projectKey(repo), found.item.id);
    changed();
    return { repo, project: projectOf(found.item) };
  },

  // Create Project (main.js makeProject), which the sidebar offers only while the repo has none.
  async "project-create"(req) {
    const where = placeOf(req);
    const repo = await findRepo(gh, where);
    const projects = await findProjects(gh, repo, where);
    if (projects.length) throw new CliError(`${repo} already has ${projects.length === 1 ? "a project" : "projects"}: ${projects.map((p) => p.title).join(", ")}. Pick one with herdr-tasks project use.`);
    const project = await createProject(gh, repo, where);
    setShared(projectKey(repo), project.id);
    changed();
    const { problems, doctorFixes } = await setupProject(gh, { repo, project, loadWorkflows, where });
    return { repo, project: projectOf(project), note: setupNote(problems, doctorFixes) };
  },

  // Task settings' Workflows (or Refactors) list.
  async workflows(req) {
    const kind = req.args.refactors ? "refactor" : "workflow";
    const { items, errors } = await (req.args.refactors ? loadRefactors : loadWorkflows)(placeOf(req));
    return { kind, items: items.map((w) => ({ ...workflowOf(w), trigger: kind === "workflow" && w.trigger ? rowDetail(w) : null })), errors };
  },

  // The doctor runs for the sidebar's place on its own; this is what it found last.
  async doctor() {
    const place = shared(PLACE) ?? null;
    const found = doctorFor(shared(DOCTOR_KEY), place);
    return { place, found: Boolean(found), issues: (found?.issues ?? []).map((i) => ({ kind: i.kind, message: i.message })) };
  },

  // The sidebar's Refresh.
  async refresh() {
    changed();
    return {};
  },
};

// The session the request names, among the repo's.
async function sessionFor(req) {
  const repo = await findRepo(gh, placeOf(req)).catch(() => null);
  const entry = (await sessionsHere(req, repo)).find((e) => e.id === req.args.id);
  if (!entry) throw new CliError(`This repo has no New Task or refactor session ${req.args.id}. herdr-tasks investigations lists them.`);
  return entry;
}
