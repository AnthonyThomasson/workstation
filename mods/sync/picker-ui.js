// The branch / worktree picker that opens under the branch row. Everything about how it looks and what it lists is
// here, so it can be swapped for another list without touching the rest of the panel.
//   ctx: { t, here (the picked folder), branch (its branch), where: { worktrees, branches } | null, request(op) }
//   Picking a worktree asks for { op: "pick", dir }; picking a branch asks for { op: "switch", branch }.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { S, stop, note, sectionLabel } from "./ui.js";

const base = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? p;

export function renderPicker(ctx) {
  const { t, here, branch, where: w } = ctx;
  return v_flex().flex_none().gap(6)
    .child(sectionLabel(t, "Worktrees"))
    .children((w?.worktrees ?? []).map((x, i) => {
      const on = x.path === here;
      return h_flex().id(`wt-${i}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().bg(on ? t.selected : t.background)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => { ctx.request({ op: "pick", dir: x.path }); cx.notify(); })
        .text_size(S().secondary).child(div().flex_1().min_w(0).truncate().child(x.branch || base(x.path)))
        .child(div().flex_none().max_w(200).truncate().text_color(t.dim).child(base(x.path)));
    }))
    .child(sectionLabel(t, "Branches (switches the folder shown above)"))
    .children((w?.branches ?? []).map((b, i) => {
      const on = b.name === branch, elsewhere = b.path && b.path !== here;
      return h_flex().id(`br-${i}`).h(28).px(8).gap(8).items_center().rounded(6).bg(on ? t.selected : t.background)
        .text_size(S().secondary).when(!on && !elsewhere, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
          .on_click((_e, cx) => { ctx.request({ op: "switch", branch: b.name }); cx.notify(); }))
        .text_color(elsewhere ? t.dim : t.foreground)
        .child(div().flex_1().min_w(0).truncate().child(b.name))
        .child(div().flex_none().text_color(t.dim).child(on ? "current" : elsewhere ? "in another worktree" : ""));
    }))
    .when(!w, (e) => e.child(note(t, "Reading branches…")));
}
