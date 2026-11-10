// One Investigation, beside its agent: the mod pane investigate.js opens to the right of the agent's terminal (props.role
// "investigation"). It looks like the run page's header (the session's title, its branch, its agent's status) with a single
// Done button, which ends the agent, closes the space, removes the worktree and deletes the branch (investigations.js endInvestigation).
// Not a View of its own: main.js builds one in init, redraws it on a timer and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, panes, run, setShared, shared, spaces, terminals, theme } from "herdr";
import { peekSpace, slotFromPage, slotKey } from "./bgrun.js";
import { investigationAgentsFor, investigationQueries } from "./investigation-agents.js";
import { INVESTIGATIONS_KEY, endInvestigation } from "./investigations.js";
import { orchestratorOf, parseLs, sameKept, statusColor, statusLabel } from "./runview.js";
import { S, stop } from "./ui.js";

const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);
const agentsKey = (id) => `github-tasks.investigation.${id}.agents`; // the investigators and workers seen, so a reload still lists the finished ones

export class InvestigationPage {
  constructor(props) {
    this.props = props ?? {};
    this.id = props?.id ?? "";
    this.agent = props?.orchestrator ?? null;
    this.title = props?.title ?? "Investigation";
    this.branch = props?.branch ?? "";
    this.busy = false;
    this.error = null;
    const saved = shared(agentsKey(this.id));
    this.saved = Array.isArray(saved) ? saved : []; // the rows kept from before (runview.js keep)
    this.listed = { investigator: null, worker: null }; // the last answer of each `hc ls --all` query
    this.listing = false;
  }

  // Asks the core for this session's investigators and workers, finished ones too (the answer has no labels: the query is the
  // filter). A query that fails keeps its last answer. Called every few seconds by main.js.
  async refresh(cx) {
    if (this.listing || !this.id) return;
    this.listing = true;
    try {
      const got = await Promise.all(Object.entries(investigationQueries(this.id)).map(async ([key, args]) => {
        const r = await hc(args).catch(() => null);
        return [key, r?.code === 0 ? parseLs(r.stdout) : null];
      }));
      for (const [key, list] of got) if (list) this.listed[key] = list;
      cx?.notify();
    } finally { this.listing = false; }
  }

  // The sub-agents now: the live terminals, the core's list and what was saved. What there is to keep is saved when it changed.
  agents(all) {
    const found = investigationAgentsFor({ id: this.id, workDir: this.props.folder, terminals: all, listed: this.listed, saved: this.saved });
    if (!sameKept(found.kept, this.saved)) { this.saved = found.kept; setShared(agentsKey(this.id), found.kept); }
    return found;
  }

  // Looks in on a live investigator or worker, from the session's space first (the run page's way).
  peek(address) {
    const space = peekSpace({ slot: shared(slotKey(this.id)), spaces: spaces(), panes: panes(), folder: this.props.folder, repoRoot: this.props.repoRoot });
    if (space) run("space.select", { id: space });
    run("terminal.peek", { terminal: address });
  }

  renderSection(t, title, rows) {
    return v_flex().flex_none().gap(2)
      .child(div().px(8).pb(4).text_size(S().label).font_semibold().text_color(t.muted).child(`${title} · ${rows.length}`))
      .children(rows.map((r) => this.renderRow(t, r)));
  }

  renderRow(t, r) {
    return h_flex().id(`investigation-agent-${r.address}`).flex_none().px(8).py(7).gap(10).items_start().rounded(8)
      .when(r.needsYou, (el) => el.bg(t.selected))
      .when(r.live, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => this.peek(r.address)))
      .child(div().mt(6).w(8).h(8).flex_none().rounded_full().bg(statusColor(r.status, t)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().font_medium().text_color(r.live ? t.foreground : t.muted).child(r.name))
          .child(div().flex_none().text_size(S().label).text_color(r.needsYou ? t.blocked : t.muted).child(statusLabel(r.status))))
        .when(Boolean(r.detail), (el) => el.child(div().truncate().text_size(S().secondary).text_color(t.muted).child(r.detail))));
  }

  // The tab's saved slot follows the agent's placeholder terminal (bgrun.js slotFromPage), so ids that changed (a Herdr restart) heal as the page renders.
  healSlot() {
    try {
      const saved = shared(slotKey(this.id));
      const next = slotFromPage({ orchestrators: [this.agent], terminals: terminals(), spaces: spaces(), panes: panes(), slot: saved ?? null });
      if (next && next !== saved) setShared(slotKey(this.id), next);
    } catch { /* healing is best effort */ }
  }

  // Done: takes the investigation down. On a failure the page stays, says why, and Done works again.
  done(cx) {
    if (this.busy || !this.agent) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await endInvestigation({
          hc, terminals, spaces, panes, git, run,
          slot: () => shared(slotKey(this.id)), clearSlot: () => setShared(slotKey(this.id), null),
          load: () => shared(INVESTIGATIONS_KEY), save: (list) => setShared(INVESTIGATIONS_KEY, list),
        }, { id: this.id, agent: this.agent, repoRoot: this.props.repoRoot, workDir: this.props.folder, branch: this.branch });
        if (!result.done) this.error = result.error;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    this.healSlot();
    const all = terminals();
    const { investigators, workers } = this.agents(all);
    const lead = orchestratorOf(all, this.agent);
    const ended = !lead?.live;
    const color = ended ? t.dim : statusColor(lead.status, t);
    const words = ended ? "Ended. Done removes its worktree and branch." : `Agent: ${statusLabel(lead.status)}`;
    const button = h_flex().id("investigation-done").h(26).px(10).items_center().rounded(6).text_size(S().secondary).font_medium()
      .when(!this.busy, (el) => el.bg(t.selected).cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => this.done(cx)))
      .when(this.busy, (el) => el.text_color(t.muted))
      .tooltip(`Ends the agent, closes this space, removes its worktree and deletes the branch ${this.branch}.`)
      .child(this.busy ? "Finishing…" : "Done");
    return v_flex().id("investigation").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .child(v_flex().flex_none().px(16).py(12).gap(4).border_b(1).border_color(t.border)
        .child(div().truncate().text_size(S().title).font_semibold().child(this.title))
        .child(div().truncate().text_size(S().secondary).text_color(t.muted).child(this.branch))
        .child(h_flex().gap(7).items_center().text_size(S().secondary).text_color(ended ? t.muted : t.foreground)
          .child(div().w(8).h(8).flex_none().rounded_full().bg(color))
          .child(div().min_w(0).truncate().child(words)))
        .child(v_flex().gap(4).child(h_flex().gap(8).items_center().pt(4).child(button))
          .when(Boolean(this.error), (el) => el.child(div().id("investigation-error").text_size(S().secondary).text_color(t.blocked).child(this.error)))))
      .child(div().id("investigation-agents").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(8).py(10).gap(14)
          .when(investigators.length > 0, (el) => el.child(this.renderSection(t, "Investigators", investigators)))
          .when(workers.length > 0, (el) => el.child(this.renderSection(t, "Workers", workers)))));
  }
}
