// The Targets section of the Details tab: what skillshare's targets still need, as the old Needs-sync
// groups showed it. Rows come from the button's last read (main.js keeps them in shared), so this only
// draws and asks the button to work, through ctx.request.
//   ctx: { t, key, targets, open, toggle(key), request(op) } (see details.js)
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { S, icon, stop, dot, warnBox, note, primary, secondary, disabledButton } from "./ui.js";
import { rowSub, detailLines, hasDiff, scopesToSync, noticeText, needsSync } from "./targets.js";
import { ago } from "./model.js";

const dotFor = (t, item) => {
  const color = item.diagnostic ? t.blocked : { sync: t.blocked, missing: t.ansi1, ok: t.ansi2, off: t.muted }[item.state] ?? t.muted;
  return dot(color, 8, item.state === "missing" || item.state === "off" || item.state === "unknown");
};

function row(ctx, item, showScope) {
  const { t } = ctx, open = ctx.open === item.key;
  const head = h_flex().id(`target-${item.key}`).min_h(44).px(10).py(6).gap(10).items_center().rounded(8).cursor_pointer()
    .when(!open, (el) => el.hover((s) => s.bg(t.hover)))
    .on_mouse_down("left", stop).on_click((_e, cx) => ctx.toggle(item.key, cx))
    .child(dotFor(t, item))
    .child(v_flex().flex_1().min_w(0)
      .child(div().truncate().text_size(S().body).font_medium().child(item.label))
      .when(Boolean(item.root), (el) => el.child(div().text_size(S().secondary).text_color(t.muted).child(item.root)))
      .child(div().truncate().text_size(S().secondary).text_color(item.diagnostic ? t.blocked : t.muted).child(rowSub(item, showScope))))
    .child(icon(open ? "chevron-down" : "chevron-right", 14, t.muted));
  if (!open) return div().mb(3).child(head);
  const buttons = hasDiff(item)
    ? [secondary(`diff-${item.key}`, "Diff", t, () => ctx.request({ op: "diff", item: { kind: item.kind, scope: item.scope, name: item.name, label: item.label } }))] : [];
  return v_flex().mb(3).rounded(8).bg(t.raised).child(head)
    .child(v_flex().pl(28).pr(10).pb(12).gap(10)
      .children(detailLines(item).map((l) => div().text_size(S().secondary).text_color(t.muted).child(l)))
      .when(buttons.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).children(buttons))));
}

export function renderTargets(ctx) {
  const { t, targets: ts, busy } = ctx;
  const refresh = secondary("targets-refresh", "Check again", t, () => ctx.request({ op: "fetch" }), { quiet: true, color: t.muted, h: 26, px: 8, size: S().label });
  if (!ts) return v_flex().gap(6).child(note(t, "Reading skillshare…"));
  if (ts.installed === false) return note(t, "skillshare is not installed on this machine, so there are no targets to link.");
  if (ts.error && !(ts.items?.length || ts.ok)) return v_flex().gap(6).child(warnBox(t, `skillshare could not be read: ${ts.error}`)).child(h_flex().child(refresh));
  const items = ts.items ?? [], pending = needsSync(items);
  const notices = items.filter((i) => i.notice), unknown = items.filter((i) => !i.notice && i.state === "unknown");
  const changed = items.filter((i) => !i.notice && (i.state === "sync" || i.state === "missing")).sort((a, b) => a.label.localeCompare(b.label));
  const scopes = scopesToSync(items, ts.project), showScope = Boolean(ts.project);
  const label = scopes.length > 1 ? "Sync targets" : `Sync ${scopes[0]}`;
  const folder = ts.project ? ts.project.split("/").filter(Boolean).pop() : null;
  const sections = [
    h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(S().secondary).text_color(t.muted)
        .child(`${ts.project ? `Project ${folder} and global` : "Global"}${ts.at ? ` · checked ${ago(ts.at) || "just now"}` : ""}`))
      .child(refresh),
    ...notices.map((i) => warnBox(t, noticeText(i))),
    ...unknown.map((i) => row(ctx, i, showScope)),
  ];
  if (pending) {
    sections.push(h_flex().min_h(28).gap(8).items_center().pt(4)
      .child(div().flex_1().text_size(S().label).font_semibold().text_color(t.blocked)
        .child(changed.length ? `Needs sync · ${changed.length}` : "Native hook files need sync"))
      .child(busy ? disabledButton("targets-sync-busy", "Working…", t, { h: 26, px: 10, size: S().label })
        : primary("targets-sync", label, t, () => ctx.request({ op: "sync", scopes }), { h: 26, px: 10, size: S().label })));
    sections.push(...changed.map((i) => row(ctx, i, showScope)));
  } else if (!notices.length && !unknown.length) {
    sections.push(note(t, "Every target is in sync."));
  }
  sections.push(div().text_size(S().label).text_color(t.muted).child(`In sync · ${ts.ok ?? 0}${ts.off ? ` · ${ts.off} disabled` : ""}`));
  return v_flex().gap(6).children(sections);
}
