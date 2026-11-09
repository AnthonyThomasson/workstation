// One workflow run, beside its orchestrator: the mod pane Start opens to the right of the orchestrator's terminal
// (props.role "run"). It lists the workers and reviewers the orchestrator has started, live from the core, and a
// click looks in on one. The agents come from `hc ls --all` (running or finished, asked every few seconds) and from the
// core's live terminals; the rows are saved per run, so a reload still lists those that ended. Not a View of its own:
// main.js builds one in init, calls refresh on a timer and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, home, notify, panes, run, setShared, shared, spaces, terminals, theme } from "herdr";
import { endRun, mergeOutcome, slotKey } from "./bgrun.js";
import { S, icon, note, stop } from "./ui.js";
import { RUN_LABEL as RUN, out } from "./run.js";
import { agentsFor, lsQueries, orchestratorOf, parseLs, sameKept, statusColor, statusLabel } from "./runview.js";
import { branchArgs, canMerge, finalSeen, handOffMessage, handOffNote, handOffStep, mergeSteps, optionFor, parsePr, prArgs, prViewArgs, parsePrUrl, prNumber, runSteps, shouldAutoPr, stageOf, statusArgs, worktreeArgs } from "./finish.js";
import { defaultBranchOf, localMergeSteps, localPrBody, moveToStage, squashMessage } from "./local-runs.js";
import { localTasks, repoHasGithubRemote } from "./local-tasks-env.js";

const stageKey = (id) => `github-tasks.run.${id}.stage`;
const prKey = (id) => `github-tasks.run.${id}.pr`;
const finalKey = (id) => `github-tasks.run.${id}.final`; // the final reviewer has been seen: Merge waits for that
const autoPrKey = (id) => `github-tasks.run.${id}.autopr`; // the page has tried to open the pull request by itself: it does that once per run
const agentsKey = (id) => `github-tasks.run.${id}.agents`; // the workers and reviewers seen, so a reload still lists the finished ones
const POLL_MS = 30000;
const NO_PR = "This repo's origin isn't on GitHub (or it has none), so there is no pull request to open. Merge puts the work straight into the default branch.";
const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);

export class RunPage {
  constructor(props) {
    this.id = props?.id ?? "";
    this.orchestrator = props?.orchestrator ?? null;
    this.title = props?.title ?? "Workflow run";
    this.workflow = props?.workflow ?? "";
    this.branch = props?.branch ?? "";
    // What start.js hands over to move the ticket and merge the run (absent on runs from before this).
    this.repoRoot = props?.repoRoot ?? "";
    this.folder = props?.folder ?? "";
    this.ticket = props?.ticket ?? null; // { number, key }
    this.projectId = props?.projectId ?? null;
    this.statusField = props?.statusField ?? null; // { id, options }
    // A run on a local task (start.js): its file in ~/.herdr/tasks moves instead of the project's Status. githubRemote: origin is on GitHub, so the pull request flow stays.
    this.local = props?.taskSource === "local";
    this.mainRoot = props?.mainRoot ?? props?.repoRoot ?? "";
    this.githubRemote = props?.githubRemote !== false;
    this.stage = Number(shared(stageKey(this.id))) || 0; // the furthest status already set
    this.pr = shared(prKey(this.id)) || null; // { url, state, number }
    this.finalSeen = finalSeen({ saved: shared(finalKey(this.id)) });
    this.autoPrTried = Boolean(Number(shared(autoPrKey(this.id))));
    this.busy = null; // "pr" | "merge" while one runs
    this.error = null;
    this.note = null; // { text, detail }: Merge stopped and the orchestrator has been asked to fix it (not an error)
    this.polling = false;
    const saved = shared(agentsKey(this.id));
    this.saved = Array.isArray(saved) ? saved : []; // the rows kept from before (runview.js keep)
    this.listed = { worker: null, reviewer: null, final: null }; // the last answer of each `hc ls --all` query
    this.listing = false;
  }

  // Asks the core for this run's workers, reviewers and final reviewer, finished ones too (the answer has no labels: the
  // query is the filter). A query that fails keeps its last answer. Called every few seconds by main.js.
  async refresh(cx) {
    if (this.listing || !this.id) return;
    this.listing = true;
    try {
      const queries = lsQueries(this.id);
      const got = await Promise.all(Object.entries(queries).map(async ([key, args]) => {
        const r = await hc(args).catch(() => null);
        return [key, r?.code === 0 ? parseLs(r.stdout) : null];
      }));
      for (const [key, list] of got) if (list) this.listed[key] = list;
      cx?.notify();
    } finally { this.listing = false; }
  }

  // The agents now: the live terminals, the core's list and what was saved. What there is to keep is saved when it changed.
  agents(all) {
    const found = agentsFor({ id: this.id, terminals: all, listed: this.listed, saved: this.saved });
    if (!sameKept(found.kept, this.saved)) { this.saved = found.kept; setShared(agentsKey(this.id), found.kept); }
    return found;
  }

  render(cx) {
    const t = theme(), all = terminals();
    const { workers, reviewers, needsYou } = this.agents(all);
    const lead = orchestratorOf(all, this.orchestrator);
    this.noteFinal(reviewers);
    if (cx) { this.advance(cx, workers, reviewers); this.autoPr(cx, workers, reviewers); this.startPolling(cx); }
    return v_flex().id("workflow-run").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .child(this.renderHeader(t, lead, cx, workers, reviewers))
      .when(needsYou > 0, (el) => el.child(h_flex().flex_none().px(16).py(8).border_b(1).border_color(t.border).text_size(S().secondary).text_color(t.blocked)
        .child(`${needsYou === 1 ? "An agent is" : `${needsYou} agents are`} waiting for you. Click to answer.`)))
      .child(div().id("workflow-run-agents").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(8).py(10).gap(14)
          .child(this.renderSection(t, "Workers", workers, "The orchestrator hasn't started a worker yet."))
          .child(this.renderSection(t, "Reviewers", reviewers, "Reviewers start once the work is done."))));
  }

  renderHeader(t, lead, cx, workers = [], reviewers = []) {
    const ended = !lead?.live;
    const color = ended ? t.dim : statusColor(lead.status, t);
    const words = ended ? "Ended. Its agents ended with it, and the work stays on the branch." : `Orchestrator: ${statusLabel(lead.status)}`;
    return v_flex().flex_none().px(16).py(12).gap(4).border_b(1).border_color(t.border)
      .child(div().truncate().text_size(S().title).font_semibold().child(this.title))
      .child(div().truncate().text_size(S().secondary).text_color(t.muted).child([this.workflow, this.branch].filter(Boolean).join(" · ")))
      .child(h_flex().gap(7).items_center().text_size(S().secondary).text_color(ended ? t.muted : t.foreground)
        .child(div().w(8).h(8).flex_none().rounded_full().bg(color))
        .child(div().min_w(0).truncate().child(words)))
      .child(this.renderActions(t, lead, cx, workers, reviewers)); // also once the orchestrator has ended: the work stays on the branch, and Merge is still gated
  }

  // The final reviewer is seen once and remembered, so a restart of the page still lets Merge through.
  noteFinal(reviewers) {
    if (this.finalSeen || !finalSeen({ reviewers })) return;
    this.finalSeen = true;
    setShared(finalKey(this.id), 1);
  }

  // When Merge would be allowed and the run has no pull request, open it by itself, once: the attempt is saved before it
  // is made, so neither a reload nor a failure tries again. A failure shows its error, and Create PR stays as the retry.
  autoPr(cx, workers, reviewers) {
    if (!this.folder || !this.branch || this.noPr()) return;
    const ready = canMerge({ finalSeen: this.finalSeen, workers, reviewers });
    if (!shouldAutoPr({ ready, pr: this.pr, tried: this.autoPrTried, busy: this.busy })) return;
    this.autoPrTried = true;
    setShared(autoPrKey(this.id), 1);
    this.createPr(cx, true);
  }

  // The ticket follows the run: In Progress once a worker has started, In Review once a reviewer has. It never goes back.
  advance(cx, workers, reviewers) {
    const stage = stageOf({ workers, reviewers });
    if (stage <= this.stage || this.moving) return;
    if (this.local ? !this.mainRoot || !this.ticket?.number : !this.statusField || !this.projectId || !this.ticket?.key) return;
    this.moving = true;
    cx.spawn(async (cx) => {
      try {
        if (this.local) await moveToStage(localTasks(this.mainRoot), this.ticket.number, stage); // the task's file goes to the stage's folder
        else {
          const option = optionFor(this.statusField.options, stage);
          if (option) {
            const r = await exec("gh", statusArgs({ projectId: this.projectId, itemId: this.ticket.key, fieldId: this.statusField.id, optionId: option.id }));
            if (r.code !== 0) throw new Error(out(r));
          }
        }
      } catch (e) {
        notify({ title: "The ticket's status didn't change", body: String(e?.message ?? e), level: "warning" });
      }
      this.stage = stage; // once per stage: a failure is said once, not retried on every redraw
      setShared(stageKey(this.id), stage);
      this.moving = false;
      cx.notify();
    });
  }

  // The run's pull request: look for it now and then, so Create PR becomes a link and shows when it is merged.
  // A local task in a repo whose origin isn't on GitHub: no pull request, and Merge is a local squash.
  noPr() { return this.local && !this.githubRemote; }

  startPolling(cx) {
    if (this.polling || !this.folder) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      for (;;) {
        if (this.pr?.state === "MERGED") break;
        if (this.local && !this.busy) { // origin may be added or changed while the run goes on
          const now = await repoHasGithubRemote(this.mainRoot).catch(() => this.githubRemote);
          if (now !== this.githubRemote) { this.githubRemote = now; cx.notify(); }
        }
        if (!this.busy && !this.noPr()) {
          const r = await exec("gh", prViewArgs(this.branch), { cwd: this.folder }).catch(() => ({ code: 1, stdout: "" }));
          const found = r.code === 0 ? parsePr(r.stdout) : null;
          if (found && (found.url !== this.pr?.url || found.state !== this.pr?.state)) { this.pr = found; setShared(prKey(this.id), found); cx.notify(); }
        }
        await cx.sleep(POLL_MS);
      }
    });
  }

  renderActions(t, lead, cx, workers = [], reviewers = []) {
    // Merge and Create PR wait for the final review and for every worker and reviewer to end; Merge also waits for the pull request.
    const ready = canMerge({ finalSeen: this.finalSeen, workers, reviewers });
    const button = (id, label, onClick, on = true, tip) => h_flex().id(id).h(26).px(10).items_center().rounded(6).text_size(S().secondary).font_medium()
      .when(on, (el) => el.cursor_pointer().bg(t.selected).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(onClick))
      .when(!on, (el) => el.text_color(t.muted)).when(Boolean(tip), (el) => el.tooltip(tip)).child(label);
    const row = h_flex().gap(8).items_center().pt(4)
      .child(button("run-merge", this.busy === "merge" ? "Merging…" : "Merge", (_e, cx) => this.merge(cx), ready && (Boolean(this.pr) || this.noPr()) && !this.busy,
        this.noPr() ? "Merges the ticket branch into the default branch of the main checkout, as one commit. Nothing is pushed." : undefined));
    if (this.noPr()) row.child(button("run-pr", "Create PR", () => {}, false, NO_PR)); // disabled, and says why
    else if (!this.pr) row.child(button("run-pr", this.busy === "pr" ? "Creating PR…" : "Create PR", (_e, cx) => this.createPr(cx), ready && !this.busy));
    else row.child(h_flex().id("run-pr-link").h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer().bg(t.selected).hover((s) => s.bg(t.hover))
      .text_size(S().secondary).font_medium().on_mouse_down("left", stop).on_click((_e, cx) => cx.open_url(this.pr.url))
      .child(`PR #${this.pr.number}${this.pr.state === "MERGED" ? " · merged" : ""}`).child(icon("external", 12, t.muted)));
    return v_flex().gap(4).child(row)
      .when(Boolean(this.note), (el) => el.child(div().id("run-merge-note").text_size(S().secondary).text_color(t.muted).tooltip(this.note.detail).child(this.note.text)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(S().secondary).text_color(t.blocked).child(this.error)));
  }

  // quiet: called from render, which is drawing right now, so the first redraw waits until the async part starts.
  createPr(cx, quiet = false) {
    if (this.busy) return;
    this.busy = "pr"; this.error = null;
    if (!quiet) cx.notify();
    cx.spawn(async (cx) => {
      if (quiet) { await null; cx.notify(); }
      try {
        const cwd = { cwd: this.folder };
        const push = await exec("git", ["-C", this.folder, "push", "-u", "origin", this.branch]);
        if (push.code !== 0) throw new Error(`The push failed: ${out(push)}`);
        const title = this.title.replace(/^#\d+\s+/, "");
        // A local task has no GitHub issue to close: the body describes the task instead.
        const body = this.local ? localPrBody(await localTasks(this.mainRoot).get(this.ticket?.number).catch(() => null), { id: this.ticket?.number, title }) : undefined;
        const made = await exec("gh", prArgs({ branch: this.branch, title, number: this.ticket?.number, body }), cwd);
        const url = parsePrUrl(made.stdout) ?? parsePrUrl(made.stderr); // gh says "already exists" with the URL on stderr
        if (!url) throw new Error(`gh didn't open a pull request: ${out(made)}`);
        this.pr = { url, state: "OPEN", number: prNumber(url) };
        setShared(prKey(this.id), this.pr);
      } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = null; cx.notify();
    });
  }

  // Merge, through the pull request (finish.js has the steps): stop if the worktree has uncommitted changes or the branch is
  // ahead of origin, squash-merge the PR with gh, set the ticket Done, then remove the worktree, the local branch and the
  // run files. It never runs git in the main checkout's working tree. Pressing it again finishes what a failure left.
  merge(cx) {
    if (this.noPr()) return this.mergeLocal(cx);
    if (this.busy || !this.pr) return;
    this.busy = "merge"; this.error = null; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        // A Merge that stopped part way can be pressed again: leave out what is already gone (the folder, the branch).
        const workDirExists = (await exec("git", worktreeArgs(this.folder))).code === 0;
        const branchExists = (await exec("git", branchArgs(this.repoRoot, this.branch))).code === 0;
        // Ask GitHub where the pull request stands now, so a saved state that has gone stale (merged by hand, say) doesn't matter.
        const view = await exec("gh", prViewArgs(this.branch), { cwd: workDirExists ? this.folder : this.repoRoot });
        const found = view.code === 0 ? parsePr(view.stdout) : null;
        if (!found) throw new Error(`Couldn't look up the pull request: ${out(view)}`);
        if (found.url !== this.pr.url) throw new Error(`The branch's pull request is ${found.url}, not ${this.pr.url} that this run opened. Nothing was merged.`);
        if (found.state !== this.pr.state) { this.pr = found; setShared(prKey(this.id), found); }
        const { warnings } = await runSteps(mergeSteps({
          repoRoot: this.repoRoot, workDir: this.folder, branch: this.branch, number: found.number, prMerged: found.state === "MERGED", headOid: found.headOid,
          status: await this.doneStatus(), runDir: `${home()}/.herdr/workflow-runs/${this.id}`, workDirExists, branchExists,
        }), exec);
        for (const body of warnings) notify({ title: "The ticket's status didn't change", body, level: "warning" });
        if (!(await this.closeSession())) { this.busy = null; cx.notify(); } // the page is still there: say what is left to do
      } catch (e) {
        if (!(await this.handOff(e))) this.error = String(e?.message ?? e);
        this.busy = null; cx.notify();
      }
    });
  }

  // Merge for a local task with no GitHub remote (local-runs.js has the steps): the main checkout must be on the default branch and
  // clean and the ticket worktree clean; the work is squashed into it and committed as "<title> (#<id>)", never pushed. A conflict is
  // undone and listed. Then the task goes to done/ and the worktree, branch, run files and terminals go as in the pull request Merge.
  mergeLocal(cx) {
    if (this.busy) return;
    this.busy = "merge"; this.error = null; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const workDirExists = (await exec("git", worktreeArgs(this.folder))).code === 0;
        const branchExists = (await exec("git", branchArgs(this.repoRoot, this.branch))).code === 0;
        const task = await localTasks(this.mainRoot).get(this.ticket?.number).catch(() => null);
        const title = task?.title ?? this.title.replace(/^#\d+\s+/, "");
        const { warnings } = await runSteps(localMergeSteps({
          repoRoot: this.repoRoot, workDir: this.folder, branch: this.branch, defaultBranch: branchExists ? await defaultBranchOf(git, this.repoRoot) : null,
          message: squashMessage(title, this.ticket?.number), status: await this.doneStatus(), runDir: `${home()}/.herdr/workflow-runs/${this.id}`, workDirExists, branchExists,
        }), exec);
        for (const body of warnings) notify({ title: "The task didn't move", body, level: "warning" });
        if (!(await this.closeSession())) { this.busy = null; cx.notify(); } // the page is still there: closeSession said what is left to do
      } catch (e) { this.error = String(e?.message ?? e); this.busy = null; cx.notify(); }
    });
  }

  // A Merge that stopped at the ahead or tree-status check goes to the run's orchestrator, once per press (this runs from
  // merge's catch, never from a render). True when it was sent: the page then shows a note, not the error. False (not one of
  // those stops, the orchestrator ended, or the send failed) leaves the error to show as before.
  async handOff(e) {
    const step = handOffStep(e);
    if (!step || !orchestratorOf(terminals(), this.orchestrator)?.live) return false;
    const error = String(e?.message ?? e);
    const sent = await hc(["send", this.orchestrator, handOffMessage({ step, error, branch: this.branch, workDir: this.folder })]).catch(() => null);
    if (sent?.code !== 0) return false;
    this.note = handOffNote({ step, error });
    return true;
  }

  // How Merge sets the ticket Done: the gh call, a warning when the project has no such option, or null when the run has no project.
  // A local task: moving its file to done/, or a warning when the file is gone.
  async doneStatus() {
    if (this.local) {
      const tasks = localTasks(this.mainRoot), id = this.ticket?.number;
      if (!id || !(await tasks.get(id).catch(() => null))) return { warn: `Task #${id ?? "?"} isn't in the local tasks any more, so it wasn't moved to done/.` };
      return { move: () => moveToStage(tasks, id, 3) };
    }
    if (!this.statusField || !this.projectId || !this.ticket?.key) return null;
    const option = optionFor(this.statusField.options, 3);
    if (!option) return { warn: `The project has no "Done" status, so the ticket's status wasn't set. Set it by hand.` };
    return { args: statusArgs({ projectId: this.projectId, itemId: this.ticket.key, fieldId: this.statusField.id, optionId: option.id }) };
  }


  // Ends the run: its orchestrator, workers and reviewers are killed on purpose (a background run ends no other way), then
  // its tab is closed if it is open. Says what to do when something couldn't be ended or the tab couldn't be found: it
  // never leaves the page on "Merging…". Resolves true when the tab (and so this page) was closed.
  async closeSession() {
    const ended = await endRun({
      id: this.id, orchestrator: this.orchestrator, hc, terminals, run, slot: shared(slotKey(this.id)), spaces: spaces(), panes: panes(),
      clearSlot: () => setShared(slotKey(this.id), null),
    });
    const outcome = mergeOutcome(ended);
    if (outcome.error) this.error = outcome.error;
    if (outcome.note) this.note = outcome.note;
    return outcome.done;
  }

  renderSection(t, title, rows, empty) {
    return v_flex().flex_none().gap(2)
      .child(div().px(8).pb(4).text_size(S().label).font_semibold().text_color(t.muted).child(rows.length ? `${title} · ${rows.length}` : title))
      .when(!rows.length, (el) => el.child(div().px(8).child(note(t, empty))))
      .children(rows.map((r) => this.renderRow(t, r)));
  }

  renderRow(t, r) {
    return h_flex().id(`run-agent-${r.address}`).flex_none().px(8).py(7).gap(10).items_start().rounded(8)
      .when(r.needsYou, (el) => el.bg(t.selected))
      .when(r.live, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop))
      .when(r.live, (el) => el.on_click(() => run("terminal.peek", { terminal: r.address })))
      .child(div().mt(6).w(8).h(8).flex_none().rounded_full().bg(statusColor(r.status, t)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().font_medium().text_color(r.live ? t.foreground : t.muted).child(r.name))
          .child(div().flex_none().text_size(S().label).text_color(r.needsYou ? t.blocked : t.muted).child(statusLabel(r.status))))
        .when(Boolean(r.detail), (el) => el.child(div().truncate().text_size(S().secondary).text_color(t.muted).child(r.detail))));
  }
}
