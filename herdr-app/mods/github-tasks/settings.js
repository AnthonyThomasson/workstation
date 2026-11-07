// The Tasks settings page: a tab the Tasks panel opens (props.role "settings"). Which project statuses mean
// "backlog" and "groomed", and the exact prompt Start Grooming gives the grooming agent, as it would be sent now.
// Not a View of its own: main.js builds one in init and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { shared, setShared, theme } from "herdr";
import { normalizeSettings, sameStatus, groomPrompt, statusesKey } from "./model.js";
import { loadStatusField } from "./loader.js";
import { S, icon, stop, note, gh } from "./ui.js";

export class TaskSettings {
  constructor(props, cx) {
    this.repo = props?.repo ?? "";
    this.project = props?.project ?? null;
    this.where = props?.where ?? {};
    this.options = null; // the project's Status field options; null while loading
    cx.spawn(async (cx) => {
      try { this.options = (await loadStatusField(gh, this.project.id, this.where))?.options ?? []; } catch { this.options = []; }
      cx.notify();
    });
  }

  cfg() { return normalizeSettings(shared(statusesKey(this.repo))); }

  set(kind, name, cx) {
    setShared(statusesKey(this.repo), { ...this.cfg(), [kind]: name });
    cx.notify();
  }

  render(cx) {
    const t = theme(), cfg = this.cfg(), options = this.options ?? [];
    // The prompt names statuses as the project spells them ("Todo", not the default "To Do").
    const real = (name) => options.find((o) => sameStatus(o.name, name))?.name ?? name;
    const prompt = groomPrompt({ repo: this.repo, project: this.project, backlog: real(cfg.backlog), groomed: real(cfg.groomed) });
    return v_flex().id("task-settings").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .child(v_flex().flex_none().px(20).py(14).gap(4).border_b(1).border_color(t.border)
        .child(div().text_size(S().title).font_semibold().child("Task settings"))
        .child(note(t, `${this.repo}${this.project?.title ? ` · ${this.project.title}` : ""}`)))
      .child(div().id("task-settings-body").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(20).py(16).gap(20)
          .child(this.statuses(t, cfg, this.options, cx))
          .child(this.promptSection(t, prompt))));
  }

  statuses(t, cfg, options, cx) {
    const group = (kind, title, hint) => v_flex().flex_none().gap(4)
      .child(div().text_size(S().secondary).font_semibold().child(title))
      .child(note(t, hint))
      .child(v_flex().gap(2).children(options.map((o) => {
        const on = sameStatus(o.name, cfg[kind]);
        return h_flex().id(`status-${kind}-${o.id ?? o.name}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).when(on, (el) => el.bg(t.selected)).on_mouse_down("left", stop)
          .on_click((_e, cx) => this.set(kind, o.name, cx))
          .child(div().w(14).h(14).flex_none().child(on ? icon("check", 14, t.foreground) : div()))
          .child(div().flex_1().min_w(0).truncate().child(o.name));
      })))
      .when(!options.some((o) => sameStatus(o.name, cfg[kind])), (el) => el.child(note(t, `The project has no "${cfg[kind]}" status.`, t.blocked)));
    const body = this.options === null ? note(t, "Loading statuses…")
      : !options.length ? note(t, "This project has no Status field.")
      : v_flex().gap(14)
        .child(group("backlog", "Backlog status", "Tickets here are the ones Start Grooming works through."))
        .child(group("groomed", "Groomed status", "Ready tickets, listed under In Progress."));
    return v_flex().flex_none().gap(8)
      .child(div().text_size(S().title).font_semibold().child("Statuses"))
      .child(body);
  }

  promptSection(t, prompt) {
    return v_flex().flex_none().gap(8)
      .child(v_flex().gap(2)
        .child(div().text_size(S().title).font_semibold().child("Grooming agent prompt"))
        .child(note(t, "What Start Grooming tells the agent when it opens, with this repo, project and statuses filled in.")))
      .child(div().p(12).rounded(8).bg(t.chrome).border_1().border_color(t.border)
        .child(v_flex().gap(2).children(prompt.split("\n").map((line) => div().min_h(S().body).text_size(S().secondary).child(line)))));
  }
}
