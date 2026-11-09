// The branch / worktree picker that opens under the branch row. Everything about how it looks and what it lists is
// here, so it can be swapped for another list without touching the rest of the panel. What is listed, in which order and
// what a search keeps is decided by targets.js (pure, tested).
//   ctx: { t, here (the picked folder), branch (its branch), where: { worktrees, branches } | null (all of them, most
//   recently checked out first), search (the search field's InputState), query (its text), request(op) }
//   Picking a worktree asks for { op: "pick", dir }; picking a branch asks for { op: "switch", branch }.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { S, icon, stop, note, sectionLabel } from "./ui.js";
import { pickerView } from "./targets.js";

const base = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? p;

export function renderPicker(ctx) {
  const { t, here, branch, where: w } = ctx;
  const view = pickerView(w, ctx.query);
  const none = view.searching ? "No match" : "None";
  // Under a list: nothing found, or (searching) how many matches are not shown.
  const tail = (list, hidden) => (e) => e
    .when(Boolean(w) && list.length === 0, (x) => x.child(note(t, none)))
    .when(view.searching && hidden > 0, (x) => x.child(note(t, `${hidden} more — type to narrow them down`)));
  return v_flex().flex_none().gap(6)
    .child(h_flex().h(30).px(10).gap(8).items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
      .child(icon("search", 14, t.muted))
      .child(Input.new(ctx.search).flex_1().min_w(0).h_full().text_size(S().secondary).text_color(t.foreground)))
    .child(sectionLabel(t, view.searching ? "Worktrees" : "Recent worktrees"))
    .children(view.worktrees.map((x, i) => {
      const on = x.path === here;
      return h_flex().id(`wt-${i}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().bg(on ? t.selected : t.background)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => { ctx.request({ op: "pick", dir: x.path }); cx.notify(); })
        .text_size(S().secondary).child(div().flex_1().min_w(0).truncate().child(x.branch || base(x.path)))
        .child(div().flex_none().max_w(200).truncate().text_color(t.dim).child(base(x.path)));
    }))
    .when(true, tail(view.worktrees, view.moreWorktrees))
    .child(sectionLabel(t, view.searching ? "Branches (switches the folder shown above)" : "Recent branches (switches the folder shown above)"))
    .children(view.branches.map((b, i) => {
      const on = b.name === branch, elsewhere = b.path && b.path !== here;
      return h_flex().id(`br-${i}`).h(28).px(8).gap(8).items_center().rounded(6).bg(on ? t.selected : t.background)
        .text_size(S().secondary).when(!on && !elsewhere, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
          .on_click((_e, cx) => { ctx.request({ op: "switch", branch: b.name }); cx.notify(); }))
        .text_color(elsewhere ? t.dim : t.foreground)
        .child(div().flex_1().min_w(0).truncate().child(b.name))
        .child(div().flex_none().text_color(t.dim).child(on ? "current" : elsewhere ? "in another worktree" : ""));
    }))
    .when(true, tail(view.branches, view.moreBranches))
    .when(!view.searching && (view.moreWorktrees > 0 || view.moreBranches > 0), (e) => e.child(note(t, "Search to find the others.")))
    .when(!w, (e) => e.child(note(t, "Reading branches…")));
}
