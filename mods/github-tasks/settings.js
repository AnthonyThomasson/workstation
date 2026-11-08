// The Tasks settings page: four agent sections (only New Task collapses), each with a read-only prompt tab, then the workflows
// (workflow-list.js), which main.js builds once so they keep their place between renders. The agent controls are
// global; the prompt tabs carry a snapshot of the current repo/project/status spellings. Not a View of its own:
// main.js builds one and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popover, TextView } from "gpui-base";
import { run, shared, setShared, theme } from "herdr";
import { normalizeGroomer, GROOMER_KEY, EFFORTS, PLACE } from "./model.js";
import { CLAUDE_MODELS } from "./models.js";
import { installedAgents } from "./groom.js";
import { loadStatusField } from "./loader.js";
import { normalizeSettingsSections, markdownLiteral } from "./settings-model.js";
import { DOCTOR_KEY, fixPrompt, doctorFor } from "./doctor.js";
import { S, stop, note, icon, iconButton, action, gh } from "./ui.js";

const SECTIONS_KEY = "github-tasks.settingsSections";
const SECTIONS = [
  { role: "newTask", label: "New Task" },
  { role: "orchestrator", label: "Orchestrator" },
  { role: "worker", label: "Worker" },
  { role: "reviewer", label: "Reviewer" },
];

export class TaskSettings {
  constructor(props, cx, onClose, workflows) {
    this.workflows = workflows ?? null; // the WorkflowList to draw under the agent settings
    this.onClose = onClose ?? null; // set when the settings sit in the side panel, which needs a way to close
    this.repo = props?.repo ?? ""; // "" until a repo is known
    this.project = props?.project ?? null; // null until the repo has a linked project
    this.where = props?.where ?? {};
    this.options = []; // the project's Status field options, for spelling the prompt's statuses; empty with no project
    this.agents = []; // installed agents New Task can use
    this.doctorOpen = false; // the doctor's popover
    this.copied = false; // the prompt was just copied
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
  sections() { return normalizeSettingsSections(shared(SECTIONS_KEY)); }

  toggleSection(role, cx) {
    const open = this.sections();
    setShared(SECTIONS_KEY, { ...open, [role]: !open[role] });
    cx.notify();
  }

  openPrompt(role) {
    const section = SECTIONS.find((s) => s.role === role);
    run("tab.new", {
      name: `${section.label} prompt`,
      mod: "github-tasks",
      props: { role: "prompt", promptRole: role, repo: this.repo, project: this.project, options: this.options },
    });
  }

  // The chosen agent: the saved one if it is installed, else Claude, else the first installed (as the panel picks it).
  agent() {
    const saved = this.groomer().agent ?? shared("github-tasks.groomAgent");
    return this.agents.find((a) => a.key === saved) ?? this.agents.find((a) => a.key === "claude") ?? this.agents[0] ?? null;
  }

  render(cx) {
    const t = theme();
    if (!this.problems().length) this.doctorOpen = false; // a popover for nothing would reappear open with the next problem
    const where = [this.repo, this.project?.title].filter(Boolean).join(" · ");
    return v_flex().id("task-settings").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .child(h_flex().flex_none().px(20).py(14).gap(8).items_start().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().text_size(S().title).font_semibold().child("Task settings"))
          .child(note(t, where || "No repo or project linked yet.")))
        .when(this.problems().length > 0, (el) => el.child(this.doctor(t)))
        .when(Boolean(this.onClose), (el) => el.child(iconButton("settings-close", "close", t, () => this.onClose(), false, "Close"))))
      .child(div().id("task-settings-body").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(20).py(16).gap(16)
          .children(SECTIONS.map((section) => this.section(t, cx, section)))
          .when(Boolean(this.workflows), (el) => el.child(this.workflows.render(cx)))));
  }

  // What the doctor found at its last check of this place (published by doctor-run.js, not by this page).
  found() { return doctorFor(shared(DOCTOR_KEY), shared(PLACE)); }
  problems() { return this.found()?.issues ?? []; }

  // The red doctor beside Close, shaking while there are problems. Pressing it opens what is wrong and a prompt for an agent.
  doctor(t) {
    const found = this.found(), issues = found?.issues ?? [];
    const prompt = fixPrompt(issues, { repo: found?.repo ?? (this.repo || null), project: found?.project ?? this.project });
    const count = `${issues.length} ${issues.length === 1 ? "problem" : "problems"} found`;
    const shaking = h_flex().id("doctor").relative().size(24).flex_none().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(count)
      .child(icon("doctor", 14, t.ansi1).absolute().top(5).left(5).loop("left", { from: 3, to: 7, period: 160 }));
    return Popover.new("doctor-popover")
      .open(this.doctorOpen)
      .on_open_change((open, cx) => { this.doctorOpen = open; this.copied = false; cx.notify(); })
      .anchor("top_right")
      .trigger(shaking)
      .content(v_flex().id("doctor-popover-content").w(360).max_h(480).p(14).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .text_color(t.foreground).text_size(S().body)
        .child(div().flex_none().text_size(S().title).font_semibold().text_color(t.ansi1).child(count))
        // The problems and the prompt scroll; the header and Copy prompt stay in view however many problems there are.
        .child(div().id("doctor-scroll").flex_1().min_h(0).overflow_y_scrollbar()
          .child(v_flex().gap(10)
            .child(v_flex().gap(4).children(issues.map((issue) => h_flex().gap(6).items_start().flex_none()
              .child(div().flex_none().text_color(t.muted).child("•"))
              .child(div().flex_1().min_w(0).child(issue.message)))))
            .child(div().text_size(S().secondary).font_semibold().child("Prompt for an agent:"))
            .child(div().id("doctor-prompt").flex_none().p(10).rounded(6).border_1().border_color(t.border).bg(t.chrome)
              .text_size(S().secondary)
              .child(TextView.markdown("doctor-prompt-text", markdownLiteral(prompt)).selectable(true)))))
        .child(h_flex().flex_none().justify_end()
          .child(action("doctor-copy", this.copied ? "Copied" : "Copy prompt", t, (_e, cx) => { cx.write_to_clipboard(prompt); this.copied = true; cx.notify(); }))));
  }

  section(t, cx, { role, label }) {
    const prompt = action(`settings-${role}-prompt`, "Prompt", t, () => this.openPrompt(role), true);
    // Orchestrator, Worker and Reviewer have nothing to set: just the name and a button to see the prompt.
    if (role !== "newTask") return h_flex().id(`settings-${role}`).flex_none().h(30).gap(6).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(S().title).font_semibold().child(label))
      .child(prompt);
    const open = this.sections()[role];
    return v_flex().id(`settings-${role}`).flex_none().gap(8)
      .child(h_flex().gap(6).items_center()
        .child(h_flex().id(`settings-${role}-toggle`).flex_1().min_w(0).h(30).gap(6).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.text_color(t.muted)).on_mouse_down("left", stop).on_click((_e, cx) => this.toggleSection(role, cx))
          .child(icon(open ? "chevron-down" : "chevron-right", 14, t.muted))
          .child(div().truncate().text_size(S().title).font_semibold().child(label)))
        .child(prompt))
      .when(open, (el) => el.child(div().pl(20).pb(4).child(this.agentBody(t))));
  }

  agentBody(t) {
    const g = this.groomer(), agent = this.agent();
    const chip = (id, label, on, onClick) => h_flex().id(id).h(28).px(10).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(on ? t.selected : t.hover)).on_mouse_down("left", stop).on_click(onClick).child(label);
    const heading = (text) => div().text_size(S().secondary).font_semibold().child(text);
    return v_flex().flex_none().gap(10)
      .child(note(t, `The + beside Backlog and Set Up Project open this agent. The model and effort are passed to the agent when it starts.`))
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
}
