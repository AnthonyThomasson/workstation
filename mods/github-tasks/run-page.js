// One workflow run, beside its orchestrator: the mod pane Start opens to the right of the orchestrator's terminal
// (props.role "run"). It lists the workers, reviewers and investigators the orchestrator has started, live from the core, and a
// click looks in on one. The agents come from `hc ls --all` (running or finished, asked every few seconds) and from the
// core's live terminals; the rows are saved per run, so a reload still lists those that ended. Not a View of its own:
// main.js builds one in init, calls refresh on a timer and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, home, notify, panes, run, setShared, shared, spaces, terminals, readTextFile, theme, writeTextFile } from "herdr";
import { endRun, findHost, findTicketSpace, hostKey, mergeOutcome, peekSpace, restartOrchestrator, runTabParts, slotFromPage, slotKey } from "./bgrun.js";
import { S, app, icon, note, stop } from "./ui.js";
import { RUN_LABEL as RUN, out } from "./run.js";
import { agentsFor, liveOrchestratorFor, lsQueries, orchestratorOf, parseLs, sameKept, statusColor, statusLabel } from "./runview.js";
import { branchArgs, canMerge, finalSeen, fixMessage, fixingDone, fixingNote, fixingStart, mergeFailure, mergeSteps, mergeView, mergeWait, movesTo, openPullRequest, optionFor, parsePr, parsePrState, prStateArgs, prViewArgs, restartTask, restoreFailure, restoreFixing, runSteps, shouldAutoPr, stageOf, statusArgs, worktreeArgs } from "./finish.js";
import { defaultBranchOf, localMergeSteps, localPrBody, moveToStage, squashMessage } from "./local-runs.js";
import { localTasks, repoHasGithubRemote } from "./local-tasks-env.js";

const stageKey = (id) => `github-tasks.run.${id}.stage`;
const prKey = (id) => `github-tasks.run.${id}.pr`;
const finalKey = (id) => `github-tasks.run.${id}.final`; // the final reviewer has been seen: Merge waits for that
const autoPrKey = (id) => `github-tasks.run.${id}.autopr`; // the page has tried to open the pull request by itself: it does that once per run
const agentsKey = (id) => `github-tasks.run.${id}.agents`; // the workers, reviewers and investigators seen, so a reload still lists the finished ones
const failureKey = (id) => `github-tasks.run.${id}.mergefailure`; // the red Merge button: { kind, label, error }
const fixingKey = (id) => `github-tasks.run.${id}.fixing`; // the orchestrator is fixing it: { label, error, seenWorking, turn, busy }
const leadKey = (id) => `github-tasks.run.${id}.orchestrator`; // the address of the orchestrator, when a new one was started for the run
const POLL_MS = 30000;
const GRACE_MS = 10000; // a just-started orchestrator may not be in the core's list yet: until then "not there" doesn't end the fixing state
const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);

export class RunPage {
  constructor(props) {
    this.id = props?.id ?? "";
    this.props = props ?? {};
    const lead = shared(leadKey(this.id)); // a new orchestrator started by the red Merge button wins over the one the tab was opened with
    this.orchestrator = (typeof lead === "string" && lead) || props?.orchestrator || null;
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
    this.busy = null; // "pr" | "merge" | "fix" while one runs
    this.error = null;
    this.failure = restoreFailure(shared(failureKey(this.id))); // the red Merge button: { kind, label, error }
    this.fixing = restoreFixing(shared(fixingKey(this.id))); // the orchestrator was asked to fix it: { label, error, seenWorking, turn, busy }
    this.fixingAt = this.fixing ? Date.now() : 0; // when it was asked, in this page's life; a restored one counts from the load, as the core's list may still be empty
    this.note = null; // { text, detail }: Merged, but the run's space couldn't be closed (closeSession); not an error
    this.polling = false;
    const saved = shared(agentsKey(this.id));
    this.saved = Array.isArray(saved) ? saved : []; // the rows kept from before (runview.js keep)
    this.listed = { worker: null, reviewer: null, final: null, investigator: null }; // the last answer of each `hc ls --all` query
    this.listing = false;
  }

  // Asks the core for this run's workers, reviewers, final reviewer and investigators, finished ones too (the answer has no labels: the
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

  // The run tab's saved slot follows the run's placeholder terminal (bgrun.js slotFromPage), so ids that changed (a Herdr restart) heal as the page renders. Written only when it differs.
  healSlot() {
    try {
      const saved = shared(slotKey(this.id));
      const next = slotFromPage({ orchestrators: [this.orchestrator, this.props.orchestrator], terminals: terminals(), spaces: spaces(), panes: panes(), slot: saved ?? null });
      if (next && next !== saved) setShared(slotKey(this.id), next);
    } catch { /* healing is best effort */ }
  }

  render(cx) {
    const t = theme(), all = terminals();
    const { workers, reviewers, investigators, needsYou } = this.agents(all);
    const lead = orchestratorOf(all, this.orchestrator);
    this.noteFinal(reviewers);
    this.healSlot();
    this.checkFixing(lead);
    if (cx) { this.advance(cx, workers, reviewers); this.autoPr(cx, workers, reviewers, investigators); this.startPolling(cx); }
    return v_flex().id("workflow-run").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .child(this.renderHeader(t, lead, cx, workers, reviewers, investigators))
      .when(needsYou > 0, (el) => el.child(h_flex().flex_none().px(16).py(8).border_b(1).border_color(t.border).text_size(S().secondary).text_color(t.blocked)
        .child(`${needsYou === 1 ? "An agent is" : `${needsYou} agents are`} waiting for you. Click to answer.`)))
      .child(div().id("workflow-run-agents").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(8).py(10).gap(14)
          .child(this.renderSection(t, "Workers", workers, "The Task Orchestrator hasn't started a worker yet."))
          .child(this.renderSection(t, "Reviewers", reviewers, "Reviewers start once the work is done."))
          .child(this.renderSection(t, "Investigators", investigators, "The Task Orchestrator hasn't started an investigator."))));
  }

  renderHeader(t, lead, cx, workers = [], reviewers = [], investigators = []) {
    const ended = !lead?.live;
    const color = ended ? t.dim : statusColor(lead.status, t);
    const words = ended ? "Ended. Its agents ended with it, and the work stays on the branch." : `Task Orchestrator: ${statusLabel(lead.status)}`;
    return v_flex().flex_none().px(16).py(12).gap(4).border_b(1).border_color(t.border)
      .child(div().truncate().text_size(S().title).font_semibold().child(this.title))
      .child(div().truncate().text_size(S().secondary).text_color(t.muted).child([this.workflow, this.branch].filter(Boolean).join(" · ")))
      .child(h_flex().gap(7).items_center().text_size(S().secondary).text_color(ended ? t.muted : t.foreground)
        .child(div().w(8).h(8).flex_none().rounded_full().bg(color))
        .child(div().min_w(0).truncate().child(words)))
      .child(this.renderActions(t, lead, cx, workers, reviewers, investigators)); // also once the orchestrator has ended: the work stays on the branch, and Merge is still gated
  }

  // The final reviewer is seen once and remembered, so a restart of the page still lets Merge through.
  noteFinal(reviewers) {
    if (this.finalSeen || !finalSeen({ reviewers })) return;
    this.finalSeen = true;
    setShared(finalKey(this.id), 1);
  }

  // When Merge would be allowed and the run has no pull request, open it by itself, once: the attempt is saved before it
  // is made, so neither a reload nor a failure tries again. A failure shows its error; pressing Merge opens the pull request again.
  autoPr(cx, workers, reviewers, investigators = []) {
    if (!this.folder || !this.branch || this.noPr()) return;
    const ready = canMerge({ finalSeen: this.finalSeen, workers, reviewers, investigators });
    if (!shouldAutoPr({ ready, pr: this.pr, tried: this.autoPrTried, busy: this.busy })) return;
    this.autoPrTried = true;
    setShared(autoPrKey(this.id), 1);
    this.busy = "pr"; this.error = null;
    cx.spawn(async (cx) => {
      await null; cx.notify(); // called from render, which is drawing right now: the first redraw waits until the async part starts
      try { await this.openPr(); } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = null; cx.notify();
    });
  }

  // The ticket follows the run: In Progress as soon as the run has launched (this page is open: Start opens it right after the orchestrator
  // starts), In Review once a reviewer has. It never goes back: a ticket already at or past the stage (a re-run of one In Review or Done)
  // keeps its status. A local task's status is the folder its file is in now; a GitHub ticket's is what Start was given.
  advance(cx, workers, reviewers) {
    const stage = stageOf({ workers, reviewers, launched: true });
    if (stage <= this.stage || this.moving) return;
    if (this.local ? !this.mainRoot || !this.ticket?.number : !this.statusField || !this.projectId || !this.ticket?.key) return;
    this.moving = true;
    cx.spawn(async (cx) => {
      try {
        if (this.local) {
          const tasks = localTasks(this.mainRoot);
          const task = await tasks.get(this.ticket.number).catch(() => null);
          if (movesTo(task?.status, stage)) await moveToStage(tasks, this.ticket.number, stage); // the task's file goes to the stage's folder
        } else if (movesTo(this.ticket.status, stage)) {
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

  // The run's pull request: look for it now and then, so the PR link shows once there is one and when it is merged.
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

  renderActions(t, lead, cx, workers = [], reviewers = [], investigators = []) {
    // Merge waits for the final review and for every worker, reviewer and investigator to end. With no pull request yet it opens one first.
    const known = Boolean(this.folder && this.branch);
    const ready = canMerge({ finalSeen: this.finalSeen, workers, reviewers, investigators }) && known;
    const wait = mergeWait({ finalSeen: this.finalSeen, workers, reviewers, investigators, known });
    const view = mergeView({ ready, busy: this.busy, failure: this.failure, fixing: this.fixing, wait });
    const hidden = view.mode === "hidden"; // gated: no button, a muted line says what it waits for
    const red = view.mode === "red";
    const tip = view.mode === "fixing" ? this.fixing.error : red ? this.failure.error
      : this.noPr() ? "Merges the ticket branch into the default branch of the main checkout, as one commit. Nothing is pushed."
      : !this.pr ? "Opens the pull request, then merges it." : undefined;
    const merge = h_flex().id("run-merge").h(26).px(10).items_center().rounded(6).text_size(S().secondary).font_medium()
      .when(red, (el) => el.bg(t.blocked).text_color(t.background)) // red: the fix's label; pressing it hands the error to the orchestrator
      .when(!red && view.enabled, (el) => el.bg(t.selected))
      .when(!red && !view.enabled, (el) => el.text_color(t.muted))
      .when(view.enabled, (el) => el.cursor_pointer().hover((s) => s.bg(red ? t.blocked : t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => this.merge(cx)))
      .when(Boolean(tip), (el) => el.tooltip(tip)).child(view.label);
    const row = h_flex().gap(8).items_center().pt(4).when(!hidden, (el) => el.child(merge))
      .when(hidden, (el) => el.child(div().id("run-merge-wait").min_w(0).text_size(S().secondary).text_color(t.muted).child(view.wait)));
    if (this.pr) row.child(h_flex().id("run-pr-link").h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer().bg(t.selected).hover((s) => s.bg(t.hover))
      .text_size(S().secondary).font_medium().on_mouse_down("left", stop).on_click((_e, cx) => cx.open_url(this.pr.url))
      .child(`PR #${this.pr.number}${this.pr.state === "MERGED" ? " · merged" : ""}`).child(icon("external", 12, t.muted)));
    const said = this.fixing ? { text: fixingNote(this.fixing), detail: this.fixing.error } : this.note;
    return v_flex().gap(4).child(row)
      .when(Boolean(said), (el) => el.child(h_flex().gap(8).items_center()
        .child(div().id("run-merge-note").min_w(0).text_size(S().secondary).text_color(t.muted).tooltip(said.detail).child(said.text))
        .when(Boolean(this.fixing), (el) => el.child(div().id("run-merge-dismiss").flex_none().text_size(S().secondary).text_color(t.foreground).cursor_pointer()
          .hover((s) => s.text_color(t.muted)).tooltip("Stop waiting for the Task Orchestrator: Merge works again.").on_mouse_down("left", stop)
          .on_click((_e, cx) => this.dismissFixing(cx)).child("Dismiss")))))
      .when(red, (el) => el.child(v_flex().gap(2)
        .child(div().id("run-merge-error").text_size(S().secondary).text_color(t.blocked).child(this.failure.error))
        .child(div().id("run-failure-dismiss").flex_none().text_size(S().secondary).text_color(t.foreground).cursor_pointer()
          .hover((s) => s.text_color(t.muted)).tooltip("Fixed it yourself? Back to a plain Merge.").on_mouse_down("left", stop)
          .on_click((_e, cx) => this.dismissFailure(cx)).child("Dismiss"))))
      .when(Boolean(this.error), (el) => el.child(div().text_size(S().secondary).text_color(t.blocked).child(this.error)));
  }

  // Opens the pull request (finish.js openPullRequest: push -u, then gh pr create) and remembers it. Throws with the reason.
  async openPr() {
    const title = this.title.replace(/^#\d+\s+/, "");
    // A local task has no GitHub issue to close: the body describes the task instead.
    const body = this.local ? localPrBody(await localTasks(this.mainRoot).get(this.ticket?.number).catch(() => null), { id: this.ticket?.number, title }) : undefined;
    this.pr = await openPullRequest(exec, { folder: this.folder, branch: this.branch, title, number: this.ticket?.number, body });
    setShared(prKey(this.id), this.pr);
  }

  // The orchestrator is fixing it: asked in sendFix, over when the orchestrator has been working and is done or idle again, or is gone
  // (fixingDone). Checked on every render. It never retries Merge: the person presses it.
  checkFixing(lead) {
    if (!this.fixing) return;
    if (!lead && Date.now() - this.fixingAt < GRACE_MS) return;
    const next = fixingDone({ fixing: this.fixing, status: lead?.status, live: Boolean(lead?.live), turn: lead?.turn });
    if (next && next.seenWorking === this.fixing.seenWorking) return;
    this.setFixing(next);
  }

  setFixing(fixing) {
    this.fixing = fixing;
    setShared(fixingKey(this.id), fixing);
  }

  setFailure(failure) {
    this.failure = failure;
    setShared(failureKey(this.id), failure);
  }

  dismissFixing(cx) { this.setFixing(null); cx.notify(); }

  // For when the person fixed the failure by hand: back to a plain Merge, which finds out again whether it works.
  dismissFailure(cx) { if (this.busy) return; this.setFailure(null); this.error = null; cx.notify(); }

  // The red button was pressed: hand the error to the orchestrator in one message (fixMessage), or when it has ended start a new one
  // with the fix as its first task (restartTask), shown in the run's tab. Then the button is Merge again, disabled, and the note says
  // the orchestrator is fixing it. A send that fails keeps the red state and says why.
  sendFix(cx) {
    const failure = this.failure;
    if (!failure || this.busy) return;
    this.busy = "fix"; this.error = null; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const input = { failure, branch: this.branch, workDir: this.folder, noRemote: this.noPr() };
        let lead = orchestratorOf(terminals(), this.orchestrator);
        if (!lead?.live) { // this run may have a live orchestrator the page did not know of: use it, don't start a second one
          const other = liveOrchestratorFor(terminals(), this.id);
          if (other) { lead = other; await this.useOrchestrator(other.address); }
        }
        let record;
        if (lead?.live) {
          const sent = await hc(["send", lead.address, fixMessage(input)]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
          if (sent.code !== 0) throw new Error(`Couldn't hand it to the Task Orchestrator: ${out(sent) || "hc send failed"}`);
          record = fixingStart({ failure, status: lead.status, turn: lead.turn });
        } else {
          await this.restartLead(restartTask({ runDir: `${home()}/.herdr/workflow-runs/${this.id}`, ...input }));
          record = fixingStart({ failure, turn: 0 }); // a new terminal counts its turns from 0; it may still report idle for a moment after its task was sent
        }
        this.fixingAt = Date.now();
        this.setFailure(null);
        this.setFixing(record);
      } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = null; cx.notify();
    });
  }

  // Follows an orchestrator of the run found by its labels: its address is kept in shared state and in pane.json, as for a new one.
  async useOrchestrator(address) {
    this.orchestrator = address;
    setShared(leadKey(this.id), address);
    try { await this.writePaneJson({ ...this.props, orchestrator: address }); }
    catch (e) { notify({ title: "The run's pane.json wasn't updated", body: String(e?.message ?? e), level: "warning" }); }
  }

  // pane.json is replaced with writeTextFile's compare-and-swap: it wants the text it replaces, so that is read first.
  async writePaneJson(props) {
    const path = `${home()}/.herdr/workflow-runs/${this.id}/pane.json`;
    const current = (await readTextFile(path).catch(() => null)) ?? null;
    await writeTextFile(path, JSON.stringify(props), current);
  }

  // Starts a new orchestrator for the run (bgrun.js restartOrchestrator) and shows it in the run's tab, if that is still open.
  async restartLead(task) {
    const { problems } = await restartOrchestrator({
      hc,
      writePaneJson: (p) => this.writePaneJson(p),
      saveOrchestrator: (address) => { this.orchestrator = address; setShared(leadKey(this.id), address); },
      findHost: () => findHost(terminals(), this.id), // the new orchestrator goes under the run's host, if it is still there
      show: async (address) => {
        const parts = runTabParts({ slot: shared(slotKey(this.id)), spaces: spaces(), panes: panes() });
        if (parts?.left) await app("terminal.show", { terminal: address, pane: parts.left }); // no tab left: View connects it
      },
    }, { id: this.id, key: this.props.ticketLabel, workDir: this.folder, argv: this.props.orchestratorArgv, task, props: this.props });
    if (problems.length) notify({ title: "The new Task Orchestrator started, with a problem", body: problems.join(" "), level: "warning" });
  }

  // Works out what a failed Merge turns into: a red button with a fix label (mergeFailure), or plain red text when the work is
  // merged and only the clean-up failed. After a failed `gh pr merge` the pull request's state is asked, to tell conflicts and
  // failing checks apart from the rest; the error's text is never read. at: where gh can run.
  async failMerge(e, at) {
    let prState = null;
    if (e?.step === "pr-merge" && this.pr?.number) {
      const r = await exec("gh", prStateArgs(this.pr.number), { cwd: at }).catch(() => null);
      prState = r?.code === 0 ? parsePrState(r.stdout) : null;
    }
    const failure = mergeFailure({ error: e, prState });
    if (failure) { this.setFailure(failure); this.error = null; }
    else this.error = String(e?.message ?? e);
  }

  // The Merge button. When it is red (a failure waits), pressing it hands the error to the orchestrator (sendFix); nothing is merged.
  // Otherwise, through the pull request (finish.js has the steps): open the pull request first if the run has none, stop if the
  // worktree has uncommitted changes or the branch is ahead of origin, squash-merge the PR with gh, set the ticket Done, then remove
  // the worktree, the local branch and the run files. It never runs git in the main checkout's working tree. A failure up to the merge
  // turns the button red (failMerge). Pressing it again finishes what a failure left.
  merge(cx) {
    if (this.busy || this.fixing) return;
    if (this.failure) return this.sendFix(cx);
    if (this.noPr()) return this.mergeLocal(cx);
    this.busy = "merge"; this.error = null; this.note = null; cx.notify();
    const ticketSpace = this.rememberTicketSpace(); // found now, while the worktree is there: the steps below remove it
    cx.spawn(async (cx) => {
      let at = this.folder; // where gh can run: the worktree, else the repo
      try {
        if (!this.pr) await this.openPr();
        // A Merge that stopped part way can be pressed again: leave out what is already gone (the folder, the branch).
        const workDirExists = (await exec("git", worktreeArgs(this.folder))).code === 0;
        if (!workDirExists) at = this.repoRoot;
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
        if (!(await this.closeSession(ticketSpace))) { this.busy = null; cx.notify(); } // the page is still there: say what is left to do
      } catch (e) {
        await this.failMerge(e, at);
        this.busy = null; cx.notify();
      }
    });
  }

  // Merge for a local task with no GitHub remote (local-runs.js has the steps): the main checkout must be on the default branch and
  // clean and the ticket worktree clean; the work is squashed into it and committed as "<title> (#<id>)", never pushed. A conflict is
  // undone and listed. Then the task goes to done/ and the worktree, branch, run files and terminals go as in the pull request Merge.
  // A failure before the merge turns the button red, as in the pull request Merge.
  mergeLocal(cx) {
    if (this.busy) return;
    this.busy = "merge"; this.error = null; this.note = null; cx.notify();
    const ticketSpace = this.rememberTicketSpace(); // found now, while the worktree is there: the steps below remove it
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
        if (!(await this.closeSession(ticketSpace))) { this.busy = null; cx.notify(); } // the page is still there: closeSession said what is left to do
      } catch (e) { await this.failMerge(e, this.repoRoot); this.busy = null; cx.notify(); }
    });
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


  // The ticket's space, found by its worktree. Merge looks before it removes the worktree, and keeps the id for a press that
  // follows a failure, as once the folder is gone Herdr may report another cwd for it.
  rememberTicketSpace() { this.foundSpace = this.ticketSpace() ?? this.foundSpace ?? null; return this.foundSpace; }

  ticketSpace() { return findTicketSpace({ spaces: spaces(), panes: panes(), folder: this.folder, repoRoot: this.repoRoot }); }

  // Looks in on a worker, reviewer or investigator. From the ticket's space first, so that keeping its terminal as a tab puts it there and
  // not in whichever space (the repo's) the person last looked at.
  peek(address) {
    const space = peekSpace({ slot: shared(slotKey(this.id)), spaces: spaces(), panes: panes(), folder: this.folder, repoRoot: this.repoRoot });
    if (space) run("space.select", { id: space });
    run("terminal.peek", { terminal: address });
  }

  // Ends the run: its orchestrator, workers, reviewers and investigators are killed on purpose (a background run ends no other way), then
  // the ticket's space is closed, with this page in it: the very last thing Merge does. Says what to do when something couldn't
  // be ended or the space couldn't be found: it never leaves the page on "Merging…". Resolves true when the space was closed.
  async closeSession(ticketSpace = this.ticketSpace()) {
    const ended = await endRun({
      id: this.id, orchestrator: this.orchestrator, hc, terminals, run, slot: shared(slotKey(this.id)), spaces: spaces(), panes: panes(),
      ticketSpace, clearSlot: () => setShared(slotKey(this.id), null),
      host: shared(hostKey(this.id)), clearHost: () => setShared(hostKey(this.id), null),
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
      .when(r.live, (el) => el.on_click(() => this.peek(r.address)))
      .child(div().mt(6).w(8).h(8).flex_none().rounded_full().bg(statusColor(r.status, t)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().font_medium().text_color(r.live ? t.foreground : t.muted).child(r.name))
          .child(div().flex_none().text_size(S().label).text_color(r.needsYou ? t.blocked : t.muted).child(statusLabel(r.status))))
        .when(Boolean(r.detail), (el) => el.child(div().truncate().text_size(S().secondary).text_color(t.muted).child(r.detail))));
  }
}
