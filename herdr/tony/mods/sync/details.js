// The Details tab (props.role "details"): one section per concern. Each section is a function that
// gets the view's context and returns an element, so a section can grow without touching the others.
//   ctx: { t, key, on, cfg, state, conflict, busy, request(op), openSettings() }
// Targets, Source and Machines are filled in by the next jobs of ticket #2.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { S, note, secondary } from "./ui.js";
import { badge, changedFiles, plural } from "./model.js";

const stub = (ctx, text) => note(ctx.t, text);

function conflicts(ctx) {
  const { t, conflict, state } = ctx;
  if (!conflict) return note(t, "No conflict. When a push or pull meets one, it is listed here until the repo is clean.");
  return v_flex().gap(8)
    .child(div().text_size(S().body).font_semibold().text_color(t.blocked).child("Conflict, resolving"))
    .child(note(t, conflict.kind === "copy"
      ? "Copying Herdr's files would overwrite uncommitted edits in the repo. Nothing was copied or pushed."
      : "Both sides changed the same files. The rebase was undone and nothing was pushed."))
    .children((conflict.files ?? []).map((f) => v_flex().gap(2).child(div().text_size(S().body).child(f.path))
      .when(Boolean(f.remote || f.local), (el) => el.child(note(t, `remote: ${f.remote || "-"} · here: ${f.local || "-"}`)))))
    .child(h_flex().child(secondary("reopen-agent", "Open the agent again", t, () => ctx.request({ op: "agent" }))))
    .when(Boolean(state?.inProgress), (el) => el.child(note(t, `A ${state.inProgress} is in progress in the repo.`, t.blocked)));
}

export const SECTIONS = [
  { id: "targets", title: "Targets", render: (ctx) => stub(ctx, "Skillshare targets and what needs syncing will be listed here.") },
  { id: "source", title: "Source", render: (ctx) => {
    const { t, state, cfg } = ctx, b = badge(state);
    if (!state?.repo) return stub(ctx, cfg.repo ? "The repo has not been read yet." : "No repo is set for this machine.");
    return v_flex().gap(3)
      .child(div().text_size(S().body).child(state.top ?? cfg.repo))
      .child(note(t, `${state.branch ?? "(detached)"}${state.upstream ? ` → ${state.upstream}` : " (no remote branch)"}`))
      .child(note(t, `${plural(b.down, "commit")} behind · ${plural(changedFiles(state).length, "file")} changed · ${plural(state.unpushed?.length ?? 0, "commit")} not pushed`));
  } },
  { id: "machines", title: "Machines", render: (ctx) => stub(ctx, "Each Herdr machine's source state will be listed here.") },
  { id: "conflicts", title: "Conflicts", render: conflicts },
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
