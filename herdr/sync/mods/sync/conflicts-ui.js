// The Conflicts section of the Details tab: the conflict a push or pull stopped on, both sides of each
// file with a button to keep one, and the conflict agent. It only draws; work goes through ctx.request.
//   ctx: { t, conflict, stopped, state, choices, pick(file, side, cx), pickAll(side, cx), request(op) } (see details.js)
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { S, mono, warnBox, note, primary, secondary, disabledButton } from "./ui.js";
import { plural } from "./model.js";

function side(ctx, f, fi, k, label, shown, differ) {
  const { t } = ctx, on = ctx.choices[f] === k, small = { h: 24, px: 10, size: S().label };
  const pick = (_e, cx) => ctx.pick(f, k, cx);
  const body = shown === undefined ? [div().px(10).text_color(t.muted).child("Preview unavailable")]
    : shown === null ? [div().px(10).text_color(t.muted).child("Deleted on this side")]
    : [...shown.lines.map((l) => div().px(10).truncate().when(l.mark, (el) => el.bg(t.selected).text_color(t.blocked)).when(!l.mark, (el) => el.text_color(t.muted)).child(l.text || " ")),
      shown.cut ? div().px(10).text_color(t.muted).child("… the preview stops here; the whole file is kept") : null].filter(Boolean);
  return v_flex().id(`cf-${fi}-${k}`).flex_1().min_w(0).rounded(6).overflow_hidden().border_1().border_color(on ? t.accent : t.border)
    .child(h_flex().h(32).pl(10).pr(6).gap(8).items_center().bg(t.raised)
      .child(div().flex_none().font_semibold().text_size(S().secondary).child(label))
      .child(div().flex_1().min_w(0).truncate().text_size(S().label).text_color(t.blocked).child(shown ? `${plural(differ ?? 0, "line")} differ${differ === 1 ? "s" : ""}` : ""))
      .child(on ? primary(`pick-${fi}-${k}`, "Selected", t, pick, small) : secondary(`pick-${fi}-${k}`, "Keep this", t, pick, small)))
    .child(v_flex().py(4).bg(t.background).font_family(mono()).text_size(S().label).children(body));
}

// Pick a side per file (a stopped pull whose files are known).
function picker(ctx) {
  const { t, stopped } = ctx, files = stopped.files ?? [];
  const chosen = files.filter((f) => ctx.choices[f]).length, all = chosen === files.length;
  const small = { h: 24, px: 10, size: S().label };
  const where = stopped.target === "source" ? "the skillshare source" : "the config repo";
  return v_flex().gap(10)
    .child(warnBox(t, `Pick the whole-file version to keep for each conflict in ${where}. Other files merge normally and both histories are kept. Nothing changes until you apply. .metadata.json is merged entry by entry, without asking.`))
    .child(h_flex().gap(6).justify_end()
      .child(secondary("all-local", "Keep all local", t, (_e, cx) => ctx.pickAll("local", cx), small))
      .child(secondary("all-remote", "Keep all remote", t, (_e, cx) => ctx.pickAll("remote", cx), small)))
    .children(files.map((f, fi) => {
      const d = stopped.previews?.[f];
      return v_flex().flex_none().gap(8)
        .child(div().font_family(mono()).font_semibold().text_size(S().secondary).child(f))
        .child(h_flex().gap(8).items_start().child(side(ctx, f, fi, "local", "This computer", d?.local, d?.differ)).child(side(ctx, f, fi, "remote", "Remote", d?.remote, d?.differ)));
    }))
    .when(files.length > (stopped.shown ?? files.length), (el) => el.child(note(t, "Some files have no preview here; you still choose a side for each.")))
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(S().secondary).text_color(t.muted).child(`${chosen} of ${plural(files.length, "file")} chosen`))
      .child(secondary("conflict-dismiss", stopped.target === "source" ? "Dismiss" : "Hide", t, () => ctx.request({ op: "dismiss" })))
      .child(ctx.busy ? disabledButton("conflict-apply-busy", "Working…", t) : all ? primary("conflict-apply", "Apply choices", t, () => ctx.request({ op: "resolve", choices: { ...ctx.choices } })) : disabledButton("conflict-apply-off", "Apply choices", t)));
}

export function renderConflicts(ctx) {
  const { t, conflict, state, stopped } = ctx;
  if (!conflict && !stopped) return note(t, "No conflict. When a push or pull meets one, it is listed here until the repo is clean.");
  return v_flex().gap(10)
    .when(Boolean(conflict), (el) => el.child(v_flex().gap(8)
      .child(div().text_size(S().body).font_semibold().text_color(t.blocked).child("Conflict, resolving"))
      .child(note(t, conflict.kind === "copy"
        ? "Copying Herdr's files would overwrite uncommitted edits in the repo. Nothing was copied or pushed."
        : "Both sides changed the same files. The rebase was undone and nothing was pushed."))
      .children((conflict.files ?? []).map((f) => v_flex().gap(2).child(div().text_size(S().body).child(f.path))
        .when(Boolean(f.remote || f.local), (el) => el.child(note(t, `remote: ${f.remote || "-"} · here: ${f.local || "-"}`)))))
      .when(Boolean(state?.inProgress), (el) => el.child(note(t, `A ${state.inProgress} is in progress in the repo.`, t.blocked)))))
    .when(Boolean(stopped), (el) => el.child(stopped.target === "source"
      ? div().text_size(S().body).font_semibold().text_color(t.blocked).child("Source pull stopped, nothing changed") : null).child(picker(ctx)))
    .child(h_flex().child(secondary("reopen-agent", "Hand it to the agent", t, () => ctx.request({ op: "agent" }))));
}
