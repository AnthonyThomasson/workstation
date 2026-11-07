// The Source section of the Details tab: the skillshare source's own git repo (when it is not inside the
// config repo) with what is uncommitted, ahead and behind, and commit / push / pull / both ways.
// Ported from the skills mod's old Source dialog. It only draws; work goes through ctx.request.
//   ctx: { t, source, busy, srcMsg (an InputState), request(op) } (see details.js)
import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { S, warnBox, note, pill, primary, secondary, disabledButton, sectionLabel, monoBox } from "./ui.js";
import { plural, ago } from "./model.js";
import { sourceGuidance } from "./source.js";

export function renderSource(ctx) {
  const { t, source: s, busy } = ctx;
  if (!s) return note(t, "Reading the skillshare source…");
  if (s.none) return note(t, "skillshare has no source folder on this machine.");
  if (s.same) return note(t, "The skillshare source is inside the config repo, so Push and Pull in the popover cover it.");
  if (s.error) return warnBox(t, s.error);
  if (s.repo === false) return note(t, `${s.path} is not in a git repository, so there is nothing to commit, push or pull.`);
  const g = sourceGuidance(s), files = s.uncommitted ?? [];
  const tag = (text, warn) => pill(text, t, warn ? t.blocked : t.muted);
  const tags = [g.dirty && tag(plural(g.dirty, "uncommitted change"), true), g.ahead && tag(`${plural(g.ahead, "commit")} to push`, false),
    g.behind && tag(`${plural(g.behind, "commit")} to pull`, true)].filter(Boolean);
  const small = { h: 26, px: 10, size: S().label };
  const act = (id, label, kind, onClick, enabled) => (busy || !enabled ? disabledButton(id, label, t, small) : kind === "primary" ? primary(id, label, t, onClick, small) : secondary(id, label, t, onClick, small));
  const msg = () => ctx.srcMsg.value().trim();
  const pullLabel = g.ahead && g.behind ? "Pull and merge" : g.behind ? `Pull ${plural(g.behind, "commit")}` : "Pull";
  return v_flex().gap(8)
    .child(div().text_size(S().body).child(s.top ?? s.path))
    .child(note(t, `${s.remote || "no remote url"} · ${s.branch ?? "(detached)"}${s.upstream ? ` → ${s.upstream}` : " (no remote branch)"}${s.fetchedAt ? ` · fetched ${ago(s.fetchedAt)}` : ""}`))
    .child(h_flex().gap(6).flex_wrap().children(tags.length ? tags : [tag("Clean · up to date", false)]))
    .when(Boolean(g.pullBlocked), (el) => el.child(warnBox(t, g.pullBlocked)))
    .when(Boolean(g.pushRejected), (el) => el.child(warnBox(t, g.pushRejected)))
    .when(Boolean(g.needsMerge), (el) => el.child(warnBox(t, g.needsMerge)))
    .child(sectionLabel(t, `Changed files · ${files.length}`))
    .child(files.length ? monoBox(t, "source-files", files.slice(0, 40).map((f) => `${f.code.padEnd(2)} ${f.path}`).join("\n")).max_h(180) : note(t, "No uncommitted changes."))
    .when(files.length > 0, (el) => el.child(v_flex().gap(4).child(sectionLabel(t, "Commit message"))
      .child(h_flex().h(30).px(10).items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
        .child(Input.new(ctx.srcMsg).flex_1().min_w(0).h_full().text_size(S().secondary).text_color(t.foreground)))))
    .child(s.upstream
      ? h_flex().gap(6).flex_wrap()
        .child(act("source-both", "Both ways", "primary", () => ctx.request({ op: "srcboth", message: msg() }), g.canBoth))
        .child(act("source-pull", pullLabel, "secondary", () => ctx.request({ op: "srcpull" }), g.canPull))
        .child(act("source-push", g.dirty ? "Commit and push" : `Push ${plural(g.ahead, "commit")}`, "secondary", () => ctx.request({ op: "srcpush", message: msg() }), g.canPush))
        .child(secondary("source-refresh", "Check again", t, () => ctx.request({ op: "fetch" }), { quiet: true, color: t.muted, ...small }))
      : note(t, "No remote is set, so there is nothing to pull or push."))
    .child(note(t, "Both ways commits what changed, pulls and merges what the remote has, pushes, and links the targets. If a file conflicts nothing is pushed until you choose a side in Conflicts."));
}
