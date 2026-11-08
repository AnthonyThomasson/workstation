// The Repo section of the Details panel: which branch or worktree is shown, a Sync button (the repo to Herdr, one way)
// and a Push button (Herdr to the repo, then git push; only from main). It only draws; work goes through ctx.request
// (the button role runs it).
//   ctx: { t, cfg, state, busy, kind, msg, auto, repoOpen: { files, where }, toggleRepo(name, cx), request(op), openSettings(cx),
//          where: { worktrees, branches } | null } (see details.js). `kind` is viewState (model.js); `auto` the generated commit message.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { S, icon, stop, note, sectionLabel, primary, secondary, disabledButton } from "./ui.js";
import { changedFiles, pushBlocked, canPush, NOT_MAIN, SYNC_FIRST, plural, ago } from "./model.js";

function rowFrame(t, left, button, extra) {
  return v_flex().flex_none().gap(8).py(10).border_b(1).border_color(t.border)
    .child(h_flex().gap(10).items_center().child(left).child(button))
    .children((Array.isArray(extra) ? extra : [extra]).filter(Boolean));
}

const title = (t, text, sub) => v_flex().flex_1().min_w(0)
  .child(div().truncate().text_size(S().body).font_semibold().child(text))
  .when(Boolean(sub), (el) => el.child(div().truncate().text_size(S().label).text_color(t.muted).child(sub)));

const base = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? p;

export function renderRepo(ctx) {
  const { t, state: st, kind, cfg } = ctx;
  if (kind === "error" && st?.noScript) {
    // scripts/sync/sync.sh is not in the repo: an agent writes it from scripts/sync/RECIPE.md.
    return v_flex().gap(8)
      .child(note(t, "scripts/sync/sync.sh is not in this repo.", t.blocked))
      .child(note(t, st.recipe ? "Generate it from scripts/sync/RECIPE.md: an agent opens in a new tab and writes it." : "There is no scripts/sync/RECIPE.md in the repo either, so it cannot be generated."))
      .child(h_flex().gap(8)
        .when(Boolean(st.recipe), (el) => el.child(primary("generate", "Generate sync.sh", t, (_e, cx) => { ctx.request({ op: "generate" }); cx.notify(); })))
        .child(secondary("change-repo", "Open Settings", t, (_e, cx) => ctx.openSettings(cx))));
  }
  if (kind === "norepo" || kind === "error" || kind === "loading") {
    return v_flex().gap(8)
      .child(note(t, kind === "norepo" ? `${cfg.dir || cfg.repo} is not a git repository.` : kind === "loading" ? "Checking the repo…" : st.error, kind === "loading" ? t.muted : t.blocked))
      .when(kind !== "loading", (el) => el.child(h_flex().gap(8)
        .child(secondary("change-repo", "Open Settings", t, (_e, cx) => ctx.openSettings(cx)))
        .when(Boolean(cfg.dir), (e) => e.child(secondary("reset-dir", "Back to the repo", t, (_e, cx) => { ctx.request({ op: "pickdir", dir: "" }); cx.notify(); })))));
  }
  const files = st?.repo ? changedFiles(st) : [], unpushed = st?.unpushed ?? [], newer = st?.repo ? st.repoNewer ?? [] : [];
  const ready = kind === "ok", working = Boolean(ctx.busy), n = files.length;
  const mainOnly = canPush(st), blocked = pushBlocked(st);
  const req = (op) => (_e, cx) => { ctx.request({ op, message: ctx.msg.value().trim() || ctx.auto }); cx.notify(); };
  const out = [];

  // Which branch or worktree is being synced.
  const open = ctx.repoOpen.where, w = ctx.where;
  const here = cfg.dir || cfg.repo;
  out.push(v_flex().flex_none().gap(6).pb(10).border_b(1).border_color(t.border)
    .child(h_flex().id("where-head").gap(8).items_center().cursor_pointer().on_mouse_down("left", stop).on_click((_e, cx) => ctx.toggleRepo("where", cx))
      .child(icon(open ? "chevron-down" : "chevron-right", 12, t.muted))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(S().body).font_semibold().child(st?.branch ? `Branch ${st.branch}` : "Detached HEAD"))
        .child(div().truncate().text_size(S().label).text_color(t.muted).child(`${here}${st?.fetchedAt ? ` · fetched ${ago(st.fetchedAt)}` : ""}`))))
    .when(open, (el) => el
      .child(sectionLabel(t, "Worktrees"))
      .children((w?.worktrees ?? []).map((x, i) => {
        const on = x.path === here;
        return h_flex().id(`wt-${i}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().bg(on ? t.selected : t.background)
          .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => { ctx.request({ op: "pickdir", dir: x.path === cfg.repo ? "" : x.path }); cx.notify(); })
          .text_size(S().secondary).child(div().flex_1().min_w(0).truncate().child(x.branch || base(x.path)))
          .child(div().flex_none().max_w(200).truncate().text_color(t.dim).child(base(x.path)));
      }))
      .child(sectionLabel(t, "Branches (switches the folder shown above)"))
      .children((w?.branches ?? []).map((b, i) => {
        const on = b.name === st?.branch, elsewhere = b.path && b.path !== here;
        return h_flex().id(`br-${i}`).h(28).px(8).gap(8).items_center().rounded(6).bg(on ? t.selected : t.background)
          .text_size(S().secondary).when(!on && !elsewhere, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
            .on_click((_e, cx) => { ctx.request({ op: "switch", branch: b.name }); cx.notify(); }))
          .text_color(elsewhere ? t.dim : t.foreground)
          .child(div().flex_1().min_w(0).truncate().child(b.name))
          .child(div().flex_none().text_color(t.dim).child(on ? "current" : elsewhere ? "in another worktree" : ""));
      }))
      .when(!w, (e) => e.child(note(t, "Reading branches…")))));

  if (working) {
    out.push(h_flex().flex_none().gap(8).items_center().text_size(S().secondary).text_color(t.working)
      .child(icon("ring", 13, t.working).spin(900)).child(div().flex_1().min_w(0).truncate().child(ctx.busy)));
  }

  // 1. Sync: Herdr follows the repo, one way, then the running Herdr is checked.
  const subSync = newer.length ? `${plural(newer.length, "repo file")} newer than Herdr` : n ? `Replaces ${plural(n, "Herdr change")} (backed up)` : "Herdr matches the repo";
  out.push(rowFrame(t, title(t, "Sync", `${subSync} · from ${st?.branch ?? "this checkout"}`),
    ready && !working ? primary("herdr-sync", "Sync", t, req("herdrsync")) : disabledButton("herdr-sync-off", "Sync", t)));

  // 2. Push: only from main.
  out.push(rowFrame(t,
    h_flex().id("push-head").flex_1().min_w(0).gap(8).items_center().cursor_pointer().on_mouse_down("left", stop).on_click((_e, cx) => ctx.toggleRepo("files", cx))
      .child(icon(ctx.repoOpen.files && n > 0 ? "chevron-down" : "chevron-right", 12, t.muted))
      .child(title(t, n ? `${plural(n, "file")} changed in Herdr` : "No files changed in Herdr",
        !mainOnly ? NOT_MAIN : blocked ? SYNC_FIRST : unpushed.length ? `${plural(unpushed.length, "commit")} not pushed` : null)),
    (n || unpushed.length) && ready && !working && mainOnly && !blocked ? primary("push-button", "Push", t, req("push")) : disabledButton("push-off", "Push", t),
    [ctx.repoOpen.files && n > 0 ? v_flex().gap(2).pl(20).children(files.slice(0, 100).map((f, i) =>
      h_flex().id(`file-${i}`).gap(8).text_size(S().secondary)
        .child(div().flex_none().w(14).text_color(f.code === "D" ? t.ansi1 : f.code === "??" || f.code === "A" ? t.ansi2 : t.muted).child(f.code === "??" ? "+" : f.code))
        .child(div().flex_1().min_w(0).truncate().child(f.path))
        .child(div().flex_none().text_color(t.dim).child(f.where === "herdr" ? "Herdr" : "repo")))) : null,
    n > 0 && mainOnly ? v_flex().gap(4).child(sectionLabel(t, "Commit message"))
      .child(h_flex().h(30).px(10).items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
        .child(Input.new(ctx.msg).flex_1().min_w(0).h_full().text_size(S().secondary).text_color(t.foreground))) : null]));
  return v_flex().gap(10).children(out);
}
