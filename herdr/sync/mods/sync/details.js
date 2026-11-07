// The Details panel (props.role "details"): the side panel the tab-bar icon opens, one section per concern. Each
// section is a function that gets the view's context and returns an element, so a section can grow without
// touching the others.
//   ctx: { t, key, on, cfg, state, conflict, busy, kind, targets, open, toggle(rowKey, cx), request(op), msg, auto, repoOpen, toggleRepo(name, cx),
//          settings, openSettings(cx) }
// Each section lives in its own file: repo-ui.js, targets-ui.js, source-ui.js, machines-ui.js, conflicts-ui.js, settings-ui.js. The view (main.js) adds
// what each needs to ctx: source, srcMsg, confirmBoth(message), machines, busyFor(key), confirmUpgrade(card, to), stopped, choices, agentName, pick, pickAll.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { S, icon, stop } from "./ui.js";
import { renderRepo } from "./repo-ui.js";
import { renderTargets } from "./targets-ui.js";
import { renderSource } from "./source-ui.js";
import { renderMachines } from "./machines-ui.js";
import { renderConflicts } from "./conflicts-ui.js";
import { renderSettings } from "./settings-ui.js";

// `show(ctx)`: a section with nothing to say is left out, heading and all. The Source section is only for a source that
// is its own repo: inside the config repo the main Pull and Push cover it, and with no source there is nothing to show.
export const SECTIONS = [
  { id: "repo", title: "Repo", render: renderRepo },
  { id: "targets", title: "Targets", render: renderTargets },
  { id: "source", title: "Source", render: renderSource, show: (ctx) => !(ctx.source?.same || ctx.source?.none) },
  { id: "machines", title: "Machines", render: renderMachines },
  { id: "conflicts", title: "Conflicts", render: renderConflicts },
];
// Settings has its own heading row (it collapses). With no repo path yet it is the only section, open; after that it is last.
const SETTINGS = { id: "settings", title: null, render: renderSettings };

export const sectionsFor = (ctx) => (ctx.cfg.repo ? [...SECTIONS.filter((s) => !s.show || s.show(ctx)), SETTINGS] : [SETTINGS]);

export function renderDetails(ctx) {
  const { t } = ctx;
  return v_flex().id("sync-details").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
    .text_color(t.foreground).text_size(S().body)
    .child(h_flex().h(42).flex_none().pl(14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(S().title).font_semibold().child(`Sync · ${ctx.machine}`))
      .when(Boolean(ctx.close), (el) => el.child(h_flex().id("sync-close").size(24).justify_center().items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => ctx.close()).child(icon("close", 14, t.muted)))))
    .child(v_flex().id("details-body").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(12).gap(18)
      .children(sectionsFor(ctx).map((s) => v_flex().id(`section-${s.id}`).flex_none().gap(8)
        .when(Boolean(s.title), (el) => el.child(div().text_size(S().label).font_semibold().text_color(t.muted).child(s.title.toUpperCase())))
        .child(s.render(ctx)))));
}
