// The Settings section of the Details panel: repo path (with a folder picker on this computer) and Save. With no repo yet it is shown first and open (details.js); after that it sits last, collapsed.
//   ctx: { t, key, settings: { repo, open, forced, browse(cx), save(cx), toggle(cx) } } (see details.js)
import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { S, icon, stop, note, sectionLabel, primary, secondary } from "./ui.js";

export function renderSettings(ctx) {
  const { t, key, settings: s } = ctx;
  const field = (label, input, help, extra) => v_flex().flex_none().gap(4).child(sectionLabel(t, label))
    .child(h_flex().gap(8).items_center()
      .child(h_flex().flex_1().min_w(0).h(32).px(10).items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
        .child(Input.new(input).flex_1().min_w(0).h_full().text_size(S().body).text_color(t.foreground)))
      .children(extra ? [extra] : []))
    .when(Boolean(help), (el) => el.child(note(t, help)));
  const browse = key === "" ? secondary("browse", "Browse…", t, (_e, cx) => s.browse(cx)) : null;
  const head = h_flex().id("settings-head").min_h(30).gap(8).items_center().cursor_pointer().on_mouse_down("left", stop).on_click((_e, cx) => s.toggle(cx))
    .child(icon(s.open ? "chevron-down" : "chevron-right", 12, t.muted))
    .child(div().flex_1().text_size(S().body).font_semibold().child("Settings"));
  return v_flex().gap(10)
    .when(!s.forced, (el) => el.child(head))
    .when(s.open || s.forced, (el) => el
      .when(s.forced, (e) => e.child(note(t, "Choose the git repository that holds your Herdr config, and sync stays one click away.")))
      .child(field("Config repo", s.repo, key ? `The repo's path on ${key}.` : "The git repository that holds your Herdr config.", browse))
      .child(h_flex().child(primary("save", "Save", t, (_e, cx) => s.save(cx)))));
}
