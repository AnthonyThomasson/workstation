// The Details tab (props.role "details"): one section per concern. Each section is a function that
// gets the view's context and returns an element, so a section can grow without touching the others.
//   ctx: { t, key, on, cfg, state, conflict, busy, targets, open, toggle(rowKey, cx), request(op), openSettings() }
// Each section lives in its own file: targets-ui.js, source-ui.js, machines-ui.js, conflicts-ui.js. The view (main.js) adds
// what each needs to ctx: source, srcMsg, machines, busyFor(key), confirmUpgrade(card, to), stopped, choices, pick, pickAll.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { S, secondary } from "./ui.js";
import { renderTargets } from "./targets-ui.js";
import { renderSource } from "./source-ui.js";
import { renderMachines } from "./machines-ui.js";
import { renderConflicts } from "./conflicts-ui.js";

export const SECTIONS = [
  { id: "targets", title: "Targets", render: renderTargets },
  { id: "source", title: "Source", render: renderSource },
  { id: "machines", title: "Machines", render: renderMachines },
  { id: "conflicts", title: "Conflicts", render: renderConflicts },
];

export function renderDetails(ctx) {
  const { t } = ctx;
  return v_flex().id("sync-details").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
    .child(h_flex().flex_none().px(20).py(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().text_size(S().dialog).font_semibold().child("Sync"))
      .child(secondary("details-settings", "Settings", t, () => ctx.openSettings())))
    .child(v_flex().id("details-body").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).gap(18)
      .children(SECTIONS.map((s) => v_flex().id(`section-${s.id}`).flex_none().gap(8)
        .child(div().text_size(S().label).font_semibold().text_color(t.muted).child(s.title.toUpperCase()))
        .child(s.render(ctx)))));
}
