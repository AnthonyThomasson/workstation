// The Details panel (props.role "details"): the side panel the tab-bar icon opens: Repo (branch or worktree, Sync, Push)
// and Settings. See repo-ui.js and settings-ui.js for what each section needs in ctx.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { S, icon, stop } from "./ui.js";
import { renderRepo } from "./repo-ui.js";
import { renderSettings } from "./settings-ui.js";

export const SECTIONS = [{ id: "repo", title: "Repo", render: renderRepo }];
// Settings has its own heading row (it collapses). With no repo path yet it is the only section, open; after that it is last.
const SETTINGS = { id: "settings", title: null, render: renderSettings };

export const sectionsFor = (ctx) => (ctx.cfg.repo ? [...SECTIONS, SETTINGS] : [SETTINGS]);

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
