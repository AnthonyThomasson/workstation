// One workflow run, beside its orchestrator: the mod pane Start opens to the right of the orchestrator's terminal
// (props.role "run"). It lists the workers and reviewers the orchestrator has started, live from the core, and a
// click looks in on one. All it keeps is the agents it has seen, to go on listing those that ended; a restart
// forgets those. Not a View of its own: main.js builds one in init and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, terminals, theme } from "herdr";
import { S, note, stop } from "./ui.js";
import { agentsOf, orchestratorOf, statusColor, statusLabel, withGone } from "./runview.js";

export class RunPage {
  constructor(props) {
    this.id = props?.id ?? "";
    this.orchestrator = props?.orchestrator ?? null;
    this.title = props?.title ?? "Workflow run";
    this.workflow = props?.workflow ?? "";
    this.branch = props?.branch ?? "";
    this.seenWorkers = new Map();
    this.seenReviewers = new Map();
  }

  render() {
    const t = theme(), all = terminals();
    const live = agentsOf(all, this.id), needsYou = live.needsYou;
    const workers = withGone(live.workers, this.seenWorkers), reviewers = withGone(live.reviewers, this.seenReviewers);
    const lead = orchestratorOf(all, this.orchestrator);
    return v_flex().id("workflow-run").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .child(this.renderHeader(t, lead))
      .when(needsYou > 0, (el) => el.child(h_flex().flex_none().px(16).py(8).border_b(1).border_color(t.border).text_size(S().secondary).text_color(t.blocked)
        .child(`${needsYou === 1 ? "An agent is" : `${needsYou} agents are`} waiting for you. Click to answer.`)))
      .child(div().id("workflow-run-agents").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(8).py(10).gap(14)
          .child(this.renderSection(t, "Workers", workers, "The orchestrator hasn't started a worker yet."))
          .child(this.renderSection(t, "Reviewers", reviewers, "Reviewers start once the work is done."))));
  }

  renderHeader(t, lead) {
    const ended = !lead?.live;
    const color = ended ? t.dim : statusColor(lead.status, t);
    const words = ended ? "Ended. Its agents ended with it, and the work stays on the branch." : `Orchestrator: ${statusLabel(lead.status)}`;
    return v_flex().flex_none().px(16).py(12).gap(4).border_b(1).border_color(t.border)
      .child(div().truncate().text_size(S().title).font_semibold().child(this.title))
      .child(div().truncate().text_size(S().secondary).text_color(t.muted).child([this.workflow, this.branch].filter(Boolean).join(" · ")))
      .child(h_flex().gap(7).items_center().text_size(S().secondary).text_color(ended ? t.muted : t.foreground)
        .child(div().w(8).h(8).flex_none().rounded_full().bg(color))
        .child(div().min_w(0).truncate().child(words)));
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
