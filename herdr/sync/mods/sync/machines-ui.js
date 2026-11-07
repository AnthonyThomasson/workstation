// The Machines section of the Details tab: a card per machine (this computer and each Herdr machine).
// It only draws; the cards come from the view's last read (machines.js) and work goes through ctx.request.
//   ctx: { t, machines: { cards, at, loading }, busyFor(key), request(op), confirmUpgrade(card, to) } (see details.js)
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { S, icon, note, pill, primary, secondary, disabledButton } from "./ui.js";
import { ago } from "./model.js";
import { sourceText, latestOf, updateTo, bareVersion } from "./machines.js";

function card(ctx, m, latest) {
  const { t } = ctx, key = m.on ?? "", to = updateTo(m, latest), busy = ctx.busyFor(key);
  const stat = (label, value, warn) => v_flex().flex_1().min_w(0).gap(2).child(div().text_size(S().label).text_color(t.muted).child(label))
    .child(div().truncate().text_size(S().body).text_color(warn ? t.blocked : t.foreground).child(value));
  return v_flex().id(`m-${m.label}`).p(12).gap(10).rounded(8).border_1().border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(icon("folder", 14, t.muted))
      .child(div().text_size(S().body).font_semibold().child(m.label))
      .when(m.here, (el) => el.child(div().text_size(S().label).text_color(t.muted).child("this computer")))
      .child(div().flex_1())
      .child(m.missing ? pill("skillshare not found", t) : to ? pill(`v${bareVersion(m.version)} · update`, t)
        : div().text_size(S().label).text_color(t.muted).child(m.version ? `v${bareVersion(m.version)}` : "")))
    .when(Boolean(m.checking), (el) => el.child(h_flex().gap(7).items_center().text_size(S().secondary).text_color(t.muted).child(icon("ring", 13, t.muted).spin(900)).child("Checking…")))
    .when(Boolean(m.error), (el) => el.child(note(t, m.error, t.ansi1)))
    .when(!m.missing && !m.checking && !m.error, (el) => el
      .child(h_flex().gap(8)
        .child(stat("Source", sourceText(m.git), Boolean(m.git?.behind?.length)))
        .child(stat("Targets", String(m.targets)))
        .child(stat("Needs sync", String(m.drift), m.drift > 0)))
      .when(Boolean(m.doctor?.errors || m.doctor?.warnings), (el) => el.child(note(t, `doctor: ${m.doctor.errors ?? 0} errors · ${m.doctor.warnings ?? 0} warnings`, m.doctor.errors ? t.ansi1 : t.muted)))
      .child(h_flex().gap(6).flex_wrap()
        .child(busy ? disabledButton(`ps-${m.label}`, "Working…", t) : primary(`ps-${m.label}`, "Pull and sync", t, () => ctx.request({ op: "pullsync", key, label: m.label, card: { git: m.git ? { path: m.git.path, same: m.git.same, repo: m.git.repo, top: m.git.top } : null } })))
        .when(Boolean(to), (el) => el.child(secondary(`up-${m.label}`, `Update to ${bareVersion(to)}`, t, () => ctx.confirmUpgrade(m, to))))));
}

export function renderMachines(ctx) {
  const { t, machines } = ctx, cards = machines?.cards ?? [];
  const list = [...cards].sort((a, b) => (a.here ? -1 : b.here ? 1 : a.label.localeCompare(b.label)));
  const latest = latestOf(list);
  return v_flex().gap(10)
    .children(list.length ? list.map((m) => card(ctx, m, latest)) : [note(t, "Checking machines…")])
    .when(Boolean(machines?.at), (el) => el.child(note(t, `Checked ${ago(machines.at) || "just now"} · refreshes every minute while shown`)));
}
