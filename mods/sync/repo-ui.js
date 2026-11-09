// The panel's content: the branch row (with Force sync on its right), the picked folder, the linked remote and the sync
// status. Expanding the branch row shows the picker (picker-ui.js). It only draws; work goes through ctx.request (the
// button role runs it).
//   ctx: { t, kind (viewState), link, run, now, home, open, toggle(cx), where, search (InputState), query, request(op) } (see details.js)
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { S, icon, stop, note, primary } from "./ui.js";
import { renderPicker } from "./picker-ui.js";
import { NO_REPO, statusLine, tildePath } from "./model.js";

export function renderRepo(ctx) {
  const { t, kind, link, run } = ctx;
  if (kind === "loading") return note(t, "Checking…");
  if (kind === "unlinked") return note(t, NO_REPO);
  const line = (text, color) => div().truncate().text_size(S().label).text_color(color ?? t.muted).child(text);
  const status = kind === "busy" ? t.working : kind === "error" ? t.blocked : t.muted;
  return v_flex().flex_none().gap(8)
    .child(h_flex().gap(8).items_start()
      .child(h_flex().id("where-head").flex_1().min_w(0).gap(8).items_start().cursor_pointer().on_mouse_down("left", stop).on_click((_e, cx) => ctx.toggle(cx))
        .child(div().pt(3).child(icon(ctx.open ? "chevron-down" : "chevron-right", 12, t.muted)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(S().body).font_semibold().child(link.branch ? `Branch ${link.branch}` : "Detached HEAD"))
          .child(line(tildePath(link.dir, ctx.home)))
          .when(Boolean(link.remote), (el) => el.child(line(`origin: ${link.remote}`)))
          .child(line(statusLine(run, ctx.now), status))))
      .child(primary("force-sync", "Force sync", t, (_e, cx) => { ctx.request({ op: "force" }); cx.notify(); })))
    .when(ctx.open, (el) => el.child(renderPicker({ t, here: link.dir, branch: link.branch, where: ctx.where, search: ctx.search, query: ctx.query, request: ctx.request })));
}
