// One Investigation, beside its agent: the mod pane investigate.js opens to the right of the agent's terminal (props.role
// "investigation"). It looks like the run page's header (the session's title, its branch, its agent's status) with a single
// Done button, which ends the agent, closes the space, removes the worktree and deletes the branch (investigations.js endInvestigation).
// Not a View of its own: main.js builds one in init, redraws it on a timer and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, panes, run, setShared, shared, spaces, terminals, theme } from "herdr";
import { slotFromPage, slotKey } from "./bgrun.js";
import { INVESTIGATIONS_KEY, endInvestigation } from "./investigations.js";
import { orchestratorOf, statusColor, statusLabel } from "./runview.js";
import { S, stop } from "./ui.js";

const git = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);

export class InvestigationPage {
  constructor(props) {
    this.props = props ?? {};
    this.id = props?.id ?? "";
    this.agent = props?.orchestrator ?? null;
    this.title = props?.title ?? "Investigation";
    this.branch = props?.branch ?? "";
    this.busy = false;
    this.error = null;
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
    const lead = orchestratorOf(terminals(), this.agent);
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
          .when(Boolean(this.error), (el) => el.child(div().id("investigation-error").text_size(S().secondary).text_color(t.blocked).child(this.error)))));
  }
}
