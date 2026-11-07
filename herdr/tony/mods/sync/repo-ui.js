// The Repo section of the Details panel: pull, push and the skillshare sync row for the shown machine, moved
// here from the old popover. It only draws; work goes through ctx.request (the button runs it).
//   ctx: { t, key, cfg, state, conflict, busy, kind, targets, msg, auto, repoOpen: { commits, files }, toggleRepo(name, cx),
//          request(op), openSettings(cx) } (see details.js). `kind` is viewState (model.js); `auto` the generated commit message.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { S, icon, stop, note, sectionLabel, primary, secondary, disabledButton } from "./ui.js";
import { changedFiles, pushBlocked, PULL_FIRST, plural, ago, pullReplaces, replacesText } from "./model.js";
import { needsSync, scopesToSync } from "./targets.js";

function rowFrame(t, left, button, extra) {
  return v_flex().flex_none().gap(8).py(10).border_b(1).border_color(t.border)
    .child(h_flex().gap(10).items_center().child(left).child(button))
    .children((Array.isArray(extra) ? extra : [extra]).filter(Boolean));
}

function toggleHead(t, id, text, sub, open, onToggle) {
  return h_flex().id(id).flex_1().min_w(0).gap(8).items_center().cursor_pointer().on_mouse_down("left", stop).on_click(onToggle)
    .child(icon(open ? "chevron-down" : "chevron-right", 12, t.muted))
    .child(v_flex().flex_1().min_w(0)
      .child(div().truncate().text_size(S().body).font_semibold().child(text))
      .when(Boolean(sub), (el) => el.child(div().truncate().text_size(S().label).text_color(t.muted).child(sub))));
}

export function renderRepo(ctx) {
  const { t, state: st, conflict, kind, cfg } = ctx;
  if (kind === "norepo" || kind === "error" || kind === "loading") {
    return v_flex().gap(8)
      .child(note(t, kind === "norepo" ? `${cfg.repo} is not a git repository.` : kind === "loading" ? "Checking the repo…" : st.error, kind === "loading" ? t.muted : t.blocked))
      .when(kind !== "loading", (el) => el.child(h_flex().child(secondary("change-repo", "Open Settings", t, (_e, cx) => ctx.openSettings(cx)))));
  }
  const files = st?.repo ? changedFiles(st) : [], behind = st?.behind ?? [], unpushed = st?.unpushed ?? [], newer = st?.repo ? st.repoNewer ?? [] : [];
  const blocked = pushBlocked(st), ready = kind === "ok", working = Boolean(ctx.busy);
  const req = (op) => (_e, cx) => { ctx.request({ op, message: ctx.msg.value().trim() || ctx.auto }); cx.notify(); };
  const out = [];

  out.push(h_flex().gap(8).items_center()
    .child(div().flex_1().min_w(0).truncate().text_size(S().secondary).text_color(t.muted)
      .child(st?.branch ? `Branch ${st.branch}${st.upstream ? ` → ${st.upstream}` : ""}` : "Detached HEAD"))
    .child(div().flex_none().text_size(S().label).text_color(t.dim).child(st?.fetchedAt ? `Fetched ${ago(st.fetchedAt)}` : "")));

  if (conflict) {
    out.push(v_flex().flex_none().gap(6).px(12).py(10).rounded(6).bg(t.selected)
      .child(div().text_size(S().body).font_semibold().text_color(t.blocked).child("Conflict, resolving"))
      .child(note(t, `${(conflict.files ?? []).map((f) => f.path).join(", ") || "See git status"}. ${conflict.op === "pull" ? "The pull was undone" : "Nothing was pushed"}; it clears when the repo is clean.`))
      .child(h_flex().child(secondary("agent-again", "Open the agent again", t, req("agent"), { h: 26 }))));
  }
  if (working) {
    out.push(h_flex().flex_none().gap(8).items_center().text_size(S().secondary).text_color(t.working)
      .child(icon("ring", 13, t.working).spin(900)).child(div().flex_1().min_w(0).truncate().child(ctx.busy)));
  }

  // 1. Pull (also the way to bring the repo's newer files into Herdr)
  const pullTitle = behind.length ? `Behind by ${plural(behind.length, "commit")}` : newer.length ? `${plural(newer.length, "repo file")} newer than Herdr` : "Up to date with the remote";
  const pullSub = behind.length ? `from ${st.upstream ?? "the remote"}${newer.length ? ` · ${plural(newer.length, "repo file")} newer than Herdr` : ""}`
    : newer.length ? "Pull to update Herdr from the repo"
    : st.fetchError ? `Could not fetch: ${st.fetchError}` : `Fetched ${ago(st.fetchedAt) || "not yet"}`;
  const replaced = pullReplaces(st);
  const pullSubShown = replaced.length && (behind.length || newer.length) ? `${pullSub} · ${replacesText(replaced.length)}` : pullSub;
  const pullOpen = ctx.repoOpen.commits && (behind.length > 0 || newer.length > 0);
  out.push(rowFrame(t,
    toggleHead(t, "pull-head", pullTitle, pullSubShown, pullOpen, (_e, cx) => ctx.toggleRepo("commits", cx)),
    (behind.length || newer.length) && ready && !working ? primary("pull-button", "Pull", t, req("pull")) : disabledButton("pull-off", "Pull", t),
    pullOpen ? v_flex().gap(2).pl(20)
      .children(behind.slice(0, 50).map((cm, i) =>
        h_flex().id(`commit-${i}`).gap(8).text_size(S().secondary)
          .child(div().flex_none().w(56).text_color(t.muted).child(cm.hash)).child(div().flex_1().min_w(0).truncate().child(cm.subject))))
      .children(newer.slice(0, 50).map((f, i) =>
        h_flex().id(`newer-${i}`).gap(8).text_size(S().secondary)
          .child(div().flex_1().min_w(0).truncate().child(f)).child(div().flex_none().text_color(t.dim).child("repo newer"))))
      .children(replaced.length && (behind.length || newer.length) ? [div().text_size(S().secondary).text_color(t.muted).child(`${replacesText(replaced.length)}:`)] : [])
      .children(replaced.length && (behind.length || newer.length) ? replaced.slice(0, 50).map((f, i) =>
        h_flex().id(`replaced-${i}`).gap(8).text_size(S().secondary)
          .child(div().flex_1().min_w(0).truncate().child(f)).child(div().flex_none().text_color(t.dim).child("Herdr"))) : []) : null));

  // 2. Push
  const n = files.length;
  out.push(rowFrame(t,
    toggleHead(t, "push-head", n ? `${plural(n, "file")} changed in Herdr` : "No files changed in Herdr",
      blocked ? PULL_FIRST : unpushed.length ? `${plural(unpushed.length, "commit")} not pushed` : null,
      ctx.repoOpen.files && n > 0, (_e, cx) => ctx.toggleRepo("files", cx)),
    (n || unpushed.length) && ready && !working && !blocked ? primary("push-button", "Push", t, req("push")) : disabledButton("push-off", "Push", t),
    [ctx.repoOpen.files && n > 0 ? v_flex().gap(2).pl(20).children(files.slice(0, 100).map((f, i) =>
      h_flex().id(`file-${i}`).gap(8).text_size(S().secondary)
        .child(div().flex_none().w(14).text_color(f.code === "D" ? t.ansi1 : f.code === "??" || f.code === "A" ? t.ansi2 : t.muted).child(f.code === "??" ? "+" : f.code))
        .child(div().flex_1().min_w(0).truncate().child(f.path))
        .child(div().flex_none().text_color(t.dim).child(f.where === "herdr" ? "Herdr" : "repo")))) : null,
    n > 0 ? v_flex().gap(4).child(sectionLabel(t, "Commit message"))
      .child(h_flex().h(30).px(10).items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
        .child(Input.new(ctx.msg).flex_1().min_w(0).h_full().text_size(S().secondary).text_color(t.foreground))) : null]));

  // 3. Skillshare: what the targets still need
  const ts = ctx.targets, pendingItems = ts?.items ?? [], nSync = needsSync(pendingItems);
  const names = pendingItems.filter((i) => !i.notice && (i.state === "sync" || i.state === "missing")).map((i) => i.label);
  const head = !ts ? ["Skillshare", "Reading targets…"]
    : ts.installed === false ? ["Skillshare is not installed", "Nothing to link on this machine"]
    : ts.error && !ts.ok && !pendingItems.length ? ["Skillshare could not be read", ts.error]
    : nSync ? [`Skillshare: ${nSync} need sync`, names.length ? `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}` : "Native hook files need sync"]
    : ["Skillshare: in sync", `${ts.ok ?? 0} in sync · checked ${ago(ts.at) || "just now"}`];
  out.push(rowFrame(t,
    v_flex().flex_1().min_w(0).child(div().truncate().text_size(S().body).font_semibold().child(head[0]))
      .child(div().truncate().text_size(S().label).text_color(t.muted).child(head[1])),
    nSync && ready && !working ? primary("sync-targets", "Sync targets", t, (_e, cx) => { ctx.request({ op: "sync", scopes: scopesToSync(pendingItems, ts.project) }); cx.notify(); })
      : disabledButton("sync-targets-off", "Sync targets", t), null));
  return v_flex().gap(10).children(out);
}
