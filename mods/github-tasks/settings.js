// The Tasks settings page: the grooming agent (global, not per project) and the exact prompt Start Grooming gives it,
// as it would be sent now. It works with no repo or project linked: the prompt then shows placeholders.
// Not a View of its own: main.js builds one and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { shared, setShared, theme } from "herdr";
import { normalizeGroomer, spelled, groomPrompt, STATUSES, GROOMER_KEY, EFFORTS, CLAUDE_MODELS } from "./model.js";
import { installedAgents } from "./groom.js";
import { loadStatusField } from "./loader.js";
import { S, stop, note, iconButton, gh } from "./ui.js";

export class TaskSettings {
  constructor(props, cx, onClose) {
    this.onClose = onClose ?? null; // set when the settings sit in the side panel, which needs a way to close
    this.repo = props?.repo ?? ""; // "" until a repo is known
    this.project = props?.project ?? null; // null until the repo has a linked project
    this.where = props?.where ?? {};
    this.options = []; // the project's Status field options, for spelling the prompt's statuses; empty with no project
    this.agents = []; // installed agents Start Grooming can use
    installedAgents().then((list) => { this.agents = list; cx.notify(); });
    this.model = InputState.new({ value: this.groomer().model, placeholder: "Agent's default" });
    this.model.on("change", (_e, cx) => { this.saveGroomer({ model: this.model.value().trim() }); cx.notify(); });
    if (this.project) cx.spawn(async (cx) => {
      try { this.options = (await loadStatusField(gh, this.project.id, this.where))?.options ?? []; } catch { this.options = []; }
      cx.notify();
    });
  }

  groomer() { return normalizeGroomer(shared(GROOMER_KEY)); }
  saveGroomer(patch) { setShared(GROOMER_KEY, { ...this.groomer(), ...patch }); }

  // The chosen agent: the saved one if it is installed, else Claude, else the first installed (as the panel picks it).
  agent() {
    const saved = this.groomer().agent ?? shared("github-tasks.groomAgent");
    return this.agents.find((a) => a.key === saved) ?? this.agents.find((a) => a.key === "claude") ?? this.agents[0] ?? null;
  }

  render(cx) {
    const t = theme();
    // The prompt names statuses as the project spells them ("Todo", not the fixed "To Do").
    const prompt = groomPrompt({ repo: this.repo, project: this.project, backlog: spelled(this.options, STATUSES.backlog), groomed: spelled(this.options, STATUSES.groomed) });
    const where = [this.repo, this.project?.title].filter(Boolean).join(" · ");
    return v_flex().id("task-settings").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .child(h_flex().flex_none().px(20).py(14).gap(8).items_start().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().text_size(S().title).font_semibold().child("Task settings"))
          .child(note(t, where || "No repo or project linked yet.")))
        .when(Boolean(this.onClose), (el) => el.child(iconButton("settings-close", "close", t, () => this.onClose(), false, "Close"))))
      .child(div().id("task-settings-body").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(20).py(16).gap(20)
          .child(this.agentSection(t))
          .child(this.promptSection(t, prompt))));
  }

  agentSection(t) {
    const g = this.groomer(), agent = this.agent();
    const chip = (id, label, on, onClick) => h_flex().id(id).h(28).px(10).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(on ? t.selected : t.hover)).on_mouse_down("left", stop).on_click(onClick).child(label);
    const heading = (text) => div().text_size(S().secondary).font_semibold().child(text);
    return v_flex().flex_none().gap(10)
      .child(v_flex().gap(2)
        .child(div().text_size(S().title).font_semibold().child("Grooming agent"))
        .child(note(t, "What Start Grooming and Set Up Project open. The model and effort are passed to the agent when it starts.")))
      .child(v_flex().gap(4).child(heading("Agent"))
        .child(h_flex().flex_wrap().gap(4).children(this.agents.length
          ? this.agents.map((a) => chip(`groom-agent-${a.key}`, a.name, a.key === agent?.key, (_e, cx) => { this.saveGroomer({ agent: a.key }); cx.notify(); }))
          : [note(t, "No installed agents were found.")])))
      .child(v_flex().gap(4).child(heading("Model"))
        .child(div().id("groom-model-field").h(34).flex_none().px(10).flex().items_center().rounded(8).border_1().border_color(t.input).on_mouse_down("left", stop)
          .child(Input.new(this.model).h_full().w_full().text_size(S().body).text_color(t.foreground)))
        .when(agent?.key === "claude", (el) => el.child(h_flex().flex_wrap().gap(4).children(CLAUDE_MODELS.map((m) =>
          chip(`groom-model-${m.id}`, m.name, g.model === m.id, (_e, cx) => { this.model.set_value(m.id); this.saveGroomer({ model: m.id }); cx.notify(); }))))))
      .child(v_flex().gap(4).child(heading("Effort"))
        .child(h_flex().flex_wrap().gap(4).children(EFFORTS.map((e) => chip(`groom-effort-${e}`, e, g.effort === e, (_e, cx) => { this.saveGroomer({ effort: e }); cx.notify(); })))));
  }

  promptSection(t, prompt) {
    return v_flex().flex_none().gap(8)
      .child(v_flex().gap(2)
        .child(div().text_size(S().title).font_semibold().child("Grooming agent prompt"))
        .child(note(t, "What Start Grooming tells the agent when it opens, with this repo and project filled in (<repo> and <project> until they are known).")))
      .child(div().p(12).rounded(8).bg(t.chrome).border_1().border_color(t.border)
        .child(v_flex().gap(2).children(prompt.split("\n").map((line) => div().min_h(S().body).text_size(S().secondary).child(line)))));
  }
}
