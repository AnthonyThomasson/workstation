// One workflow run, beside its orchestrator: the mod pane Start opens to the right of the orchestrator's terminal
// (props.role "run"). It lists the workers and reviewers the orchestrator has started, live from the core, and a
// click looks in on one. All it keeps is the agents it has seen, to go on listing those that ended; a restart
// forgets those. Not a View of its own: main.js builds one in init and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, home, notify, run, setShared, shared, terminals, theme } from "herdr";
import { S, icon, note, stop } from "./ui.js";
import { agentsOf, orchestratorOf, statusColor, statusLabel, withGone } from "./runview.js";
import { branchArgs, canMerge, defaultBranch, finalSeen, mergeSteps, optionFor, parsePr, prArgs, prViewArgs, parsePrUrl, prNumber, runSteps, stageOf, statusArgs, worktreeArgs } from "./finish.js";

const out = (r) => (r.stderr || r.stdout || "").trim();
const RUN = "herdr.workflow.run";
const stageKey = (id) => `workflows.run.${id}.stage`;
const prKey = (id) => `workflows.run.${id}.pr`;
const finalKey = (id) => `workflows.run.${id}.final`; // the final reviewer has been seen: Merge waits for that
const POLL_MS = 30000;

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
    this.stage = Number(shared(stageKey(this.id))) || 0; // the furthest status already set
    this.pr = shared(prKey(this.id)) || null; // { url, state, number }
    this.finalSeen = finalSeen({ saved: shared(finalKey(this.id)) });
    this.busy = null; // "pr" | "merge" while one runs
    this.error = null;
    this.polling = false;
    this.seenWorkers = new Map();
    this.seenReviewers = new Map();
  }

  render(cx) {
    const t = theme(), all = terminals();
    const live = agentsOf(all, this.id), needsYou = live.needsYou;
    const workers = withGone(live.workers, this.seenWorkers), reviewers = withGone(live.reviewers, this.seenReviewers);
    const lead = orchestratorOf(all, this.orchestrator);
    this.noteFinal(reviewers);
    if (cx) { this.advance(cx, workers, reviewers); this.startPolling(cx); }
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

  // The ticket follows the run: In Progress once a worker has started, In Review once a reviewer has. It never goes back.
  advance(cx, workers, reviewers) {
    const stage = stageOf({ workers, reviewers });
    if (stage <= this.stage || this.moving || !this.statusField || !this.projectId || !this.ticket?.key) return;
    this.moving = true;
    cx.spawn(async (cx) => {
      const option = optionFor(this.statusField.options, stage);
      try {
        if (option) {
          const r = await exec("gh", statusArgs({ projectId: this.projectId, itemId: this.ticket.key, fieldId: this.statusField.id, optionId: option.id }));
          if (r.code !== 0) throw new Error(out(r));
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
  startPolling(cx) {
    if (this.polling || !this.folder) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      for (;;) {
        if (this.pr?.state === "MERGED") break;
        if (!this.busy) {
          const r = await exec("gh", prViewArgs(this.branch), { cwd: this.folder }).catch(() => ({ code: 1, stdout: "" }));
          const found = r.code === 0 ? parsePr(r.stdout) : null;
          if (found && (found.url !== this.pr?.url || found.state !== this.pr?.state)) { this.pr = found; setShared(prKey(this.id), found); cx.notify(); }
        }
        await cx.sleep(POLL_MS);
      }
    });
  }

  renderActions(t, lead, cx, workers = [], reviewers = []) {
    // Merge and Create PR wait for the final review and for every worker and reviewer to end.
    const ready = canMerge({ finalSeen: this.finalSeen, workers, reviewers });
    const button = (id, label, onClick, on = true) => h_flex().id(id).h(26).px(10).items_center().rounded(6).text_size(S().secondary).font_medium()
      .when(on, (el) => el.cursor_pointer().bg(t.selected).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(onClick))
      .when(!on, (el) => el.text_color(t.muted)).child(label);
    const row = h_flex().gap(8).items_center().pt(4)
      .child(button("run-merge", this.busy === "merge" ? "Merging…" : "Merge", (_e, cx) => this.merge(cx), ready && !this.busy));
    if (!this.pr) row.child(button("run-pr", this.busy === "pr" ? "Creating PR…" : "Create PR", (_e, cx) => this.createPr(cx), ready && !this.busy));
    else row.child(h_flex().id("run-pr-link").h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer().bg(t.selected).hover((s) => s.bg(t.hover))
      .text_size(S().secondary).font_medium().on_mouse_down("left", stop).on_click((_e, cx) => cx.open_url(this.pr.url))
      .child(`PR #${this.pr.number}${this.pr.state === "MERGED" ? " · merged" : ""}`).child(icon("external", 12, t.muted)));
    return v_flex().gap(4).child(row).when(Boolean(this.error), (el) => el.child(div().text_size(S().secondary).text_color(t.blocked).child(this.error)));
  }

  async baseBranch() {
    const r = await exec("git", ["-C", this.repoRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    return (r.code === 0 && defaultBranch(r.stdout)) || "main";
  }

  createPr(cx) {
    if (this.busy) return;
    this.busy = "pr"; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const cwd = { cwd: this.folder };
        const push = await exec("git", ["-C", this.folder, "push", "-u", "origin", this.branch]);
        if (push.code !== 0) throw new Error(`The push failed: ${out(push)}`);
        const made = await exec("gh", prArgs({ branch: this.branch, title: this.title.replace(/^#\d+\s+/, ""), number: this.ticket?.number }), cwd);
        const url = parsePrUrl(made.stdout) ?? parsePrUrl(made.stderr); // gh says "already exists" with the URL on stderr
        if (!url) throw new Error(`gh didn't open a pull request: ${out(made)}`);
        this.pr = { url, state: "OPEN", number: prNumber(url) };
        setShared(prKey(this.id), this.pr);
      } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = null; cx.notify();
    });
  }

  // Merge: commit what is left, merge the ticket branch into the default branch, push it, then set the ticket Done,
  // close it, and clean up (finish.js has the steps). Nothing here waits for a pull request.
  merge(cx) {
    if (this.busy) return;
    this.busy = "merge"; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        // A Merge that stopped part way can be pressed again: leave out what is already gone (the folder, the branch).
        const workDirExists = (await exec("git", worktreeArgs(this.folder))).code === 0;
        const branchExists = (await exec("git", branchArgs(this.repoRoot, this.branch))).code === 0;
        const { warnings } = await runSteps(mergeSteps({
          repoRoot: this.repoRoot, workDir: this.folder, branch: this.branch, base: await this.baseBranch(),
          number: this.ticket?.number, status: this.doneStatus(), runDir: `${home()}/.herdr/workflow-runs/${this.id}`,
          workDirExists, branchExists,
        }), exec);
        for (const body of warnings) notify({ title: "The ticket's status didn't change", body, level: "warning" });
        if (!(await this.closeSession())) {
          this.error = "Merged. This tab couldn't be closed for you: close it yourself.";
          this.busy = null; cx.notify();
        }
      } catch (e) { this.error = String(e?.message ?? e); this.busy = null; cx.notify(); }
    });
  }

  // How Merge sets the ticket Done: the gh call, a warning when the project has no such option, or null when the run has no project.
  doneStatus() {
    if (!this.statusField || !this.projectId || !this.ticket?.key) return null;
    const option = optionFor(this.statusField.options, 3);
    if (!option) return { warn: `The project has no "Done" status, so the ticket's status wasn't set. Set it by hand.` };
    return { args: statusArgs({ projectId: this.projectId, itemId: this.ticket.key, fieldId: this.statusField.id, optionId: option.id }) };
  }

  // Ends the run's workers and reviewers, then its tab, which ends the orchestrator and this page with it.
  // Resolves false when the tab couldn't be found, so the page can say so instead of staying on "Merging…".
  async closeSession() {
    const all = terminals();
    for (const k of all.filter((x) => x.labels?.[RUN] === this.id && x.address !== this.orchestrator)) {
      await hc(["kill", k.address]).catch(() => {});
      await hc(["rm", k.address]).catch(() => {});
    }
    const tab = all.find((x) => x.address === this.orchestrator)?.labels?.["herdr.tab"];
    if (!tab) return false;
    run("tab.close", { id: tab });
    return true;
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
