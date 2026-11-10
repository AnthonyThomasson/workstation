// The Tasks settings page: four agent sections (only New Task collapses), each with a read-only prompt tab, then the workflows
// (workflow-list.js), which main.js builds once so they keep their place between renders. The agent controls are
// global; the prompt tabs carry a snapshot of the current repo/project/status spellings. Not a View of its own:
// main.js builds one and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popover, TextView } from "gpui-base";
import { home, run, shared, setShared, theme } from "herdr";
import { normalizeGroomer, normalizeSubAgent, GROOMER_KEY, INVESTIGATOR_KEY, WORKER_KEY, EFFORTS, PLACE, TASK_SOURCE } from "./model.js";
import { CHANGED } from "./editor.js";
import { NEW_TASK_LABELS } from "./workflow-model.js";
import { CLAUDE_MODELS } from "./models.js";
import { installedAgents } from "./groom.js";
import { loadStatusField } from "./loader.js";
import { normalizeSettingsSections, markdownLiteral } from "./settings-model.js";
import { DOCTOR_KEY, fixPrompt, doctorFor } from "./doctor.js";
import { statusDir } from "./local-tasks.js";
import { tasksConfig } from "./local-tasks-env.js";
import { sourceFor, sourceToggle } from "./local-ui.js";
import { S, stop, note, icon, iconButton, action, gh } from "./ui.js";

const SECTIONS_KEY = "github-tasks.settingsSections";
const SECTIONS = [
  { role: "newTask", label: "New Task" },
  { role: "orchestrator", label: "Orchestrator" },
  { role: "worker", label: "Worker" },
  { role: "reviewer", label: "Reviewer" },
  { role: "investigator", label: "Investigator" },
];

// The helpers the New Task agent may start (investigation-spawn.js), each with agent, model and effort of its own and a prompt tab.
const SUB_AGENTS = [
  { id: "investigator", heading: "Investigators", role: "newTaskInvestigator", about: "Read-only helpers the New Task agent starts to explore the code." },
  { id: "worker", heading: "Workers (prototypes)", role: "newTaskWorker", about: "Helpers it starts to build a throwaway prototype of something complex. Their code is discarded when the session is done." },
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
    this.sourceBusy = false; // tasks.json is being written
    this.sourceError = null;
    installedAgents().then((list) => { this.agents = list; cx.notify(); });
    this.model = InputState.new({ value: this.groomer().model, placeholder: "Agent's default" });
    this.model.on("change", (_e, cx) => { this.saveGroomer({ model: this.model.value().trim() }); cx.notify(); });
    this.subModels = {}; // the model boxes of the investigators and the workers, by SUB_AGENTS id
    for (const sub of SUB_AGENTS) {
      const input = InputState.new({ value: this.subAgent(sub.id).model, placeholder: "Agent's default" });
      input.on("change", (_e, cx) => { this.saveSubAgent(sub.id, { model: input.value().trim() }); cx.notify(); });
      this.subModels[sub.id] = input;
    }
    if (this.project) cx.spawn(async (cx) => {
      try { this.options = (await loadStatusField(gh, this.project.id, this.where))?.options ?? []; } catch { this.options = []; }
      cx.notify();
    });
  }

  groomer() { return normalizeGroomer(shared(GROOMER_KEY)); }
  saveGroomer(patch) { setShared(GROOMER_KEY, { ...this.groomer(), ...patch }); }
  // An investigator's or worker's saved choice: claude / the agent's own model / medium until the person changes it, whatever is saved.
  subAgent(id) { return normalizeSubAgent(id === "investigator" ? shared(INVESTIGATOR_KEY) : shared(WORKER_KEY)); }
  saveSubAgent(id, patch) {
    const next = { ...this.subAgent(id), ...patch };
    if (id === "investigator") setShared(INVESTIGATOR_KEY, next); else setShared(WORKER_KEY, next);
  }
  sections() { return normalizeSettingsSections(shared(SECTIONS_KEY)); }

  toggleSection(role, cx) {
    const open = this.sections();
    setShared(SECTIONS_KEY, { ...open, [role]: !open[role] });
    cx.notify();
  }

  openPrompt(role) {
    const label = SECTIONS.find((s) => s.role === role)?.label ?? NEW_TASK_LABELS[role];
    run("tab.new", {
      name: `${label} prompt`,
      mod: "github-tasks",
      props: { role: "prompt", promptRole: role, repo: this.repo, project: this.project, options: this.options, local: this.localPrompt() },
    });
  }

  // What the source says about the place the sidebar shows (null while it is looking), and the checkbox that follows it.
  source() { return sourceFor(shared(TASK_SOURCE), shared(PLACE)); }

  // The folders and root the New Task prompt tab names when the repo's tasks are local files; null otherwise.
  localPrompt() {
    const info = this.source();
    if (info?.source !== "local" || !info.mainRoot || info.remote) return null;
    return { mainRoot: info.mainRoot, todoDir: statusDir(home(), info.mainRoot, "to-do"), upNextDir: statusDir(home(), info.mainRoot, "up-next") };
  }

  // Writes the other source to <main checkout>/.herdr/tasks/tasks.json (and never runs git on it). The sidebar sees the new
  // value at once through the shared state, and again from the file on its next look, so a hand edit wins over this page.
  toggleSource(cx) {
    const info = this.source(), view = sourceToggle(info);
    if (!view.enabled || this.sourceBusy) return;
    this.sourceBusy = true;
    this.sourceError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await tasksConfig.write(info.mainRoot, view.next);
        setShared(TASK_SOURCE, { ...info, source: view.next });
        setShared(CHANGED, Date.now()); // the sidebar switches now
      } catch (e) {
        this.sourceError = `Couldn't write tasks.json: ${e?.message ?? e}`;
      } finally {
        this.sourceBusy = false;
        cx.notify();
      }
    });
  }

  // The Local tasks checkbox, at the top of the page. Disabled (dimmed, with the reason as its tooltip) outside a git repo
  // and in a space on another machine.
  renderSource(t) {
    const view = sourceToggle(this.source());
    const box = div().size(16).flex_none().flex().items_center().justify_center().rounded(4).border_1()
      .border_color(view.checked ? t.solid : t.input).bg(view.checked ? t.solid : t.background)
      .when(view.checked, (el) => el.child(icon("check", 12, t.solid_foreground)));
    return v_flex().flex_none().gap(6)
      .child(h_flex().id("local-tasks").h(30).gap(8).items_center().tooltip(view.tooltip)
        .when(!view.enabled, (el) => el.opacity(0.5))
        .when(view.enabled && !this.sourceBusy, (el) => el.cursor_pointer().on_mouse_down("left", stop).on_click((_e, cx) => this.toggleSource(cx)))
        .child(box)
        .child(div().text_size(S().title).font_semibold().child("Local tasks")))
      .child(note(t, view.checked ? "This repo's tasks are YAML files on this computer." : "Off: this repo's tasks are on its GitHub Project."))
      .when(Boolean(this.sourceError), (el) => el.child(note(t, this.sourceError, t.blocked)));
  }

  // The chosen agent: the saved one if it is installed, else Claude, else the first installed (as the panel picks it).
  agent() {
    const saved = this.groomer().agent ?? shared("github-tasks.groomAgent");
    return this.agents.find((a) => a.key === saved) ?? this.agents.find((a) => a.key === "claude") ?? this.agents[0] ?? null;
  }

  render(cx) {
    const t = theme();
    if (!this.problems().length) this.doctorOpen = false; // a popover for nothing would reappear open with the next problem
    const local = this.source()?.source === "local" && !this.source().remote;
    const where = local ? `Local tasks · ${String(this.source().mainRoot ?? "").split("/").filter(Boolean).pop() ?? ""}` : [this.repo, this.project?.title].filter(Boolean).join(" · ");
    return v_flex().id("task-settings").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .child(h_flex().flex_none().px(20).py(14).gap(8).items_start().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().text_size(S().title).font_semibold().child("Task settings"))
          .child(note(t, where || "No repo or project linked yet.")))
        .when(this.problems().length > 0, (el) => el.child(this.doctor(t)))
        .when(Boolean(this.onClose), (el) => el.child(iconButton("settings-close", "close", t, () => this.onClose(), false, "Close"))))
      .child(div().id("task-settings-body").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(20).py(16).gap(16)
          .child(this.renderSource(t))
          .children(SECTIONS.map((section) => this.section(t, cx, section)))
          .when(Boolean(this.workflows), (el) => el.child(this.workflows.render(cx)))));
  }

  // What the doctor found at its last check of this place (published by doctor-run.js, not by this page).
  found() { return doctorFor(shared(DOCTOR_KEY), shared(PLACE)); }
  problems() { return this.found()?.issues ?? []; }

  // The red doctor beside Close, shaking while there are problems. Pressing it opens what is wrong and a prompt for an agent.
  doctor(t) {
    const found = this.found(), issues = found?.issues ?? [];
    const prompt = fixPrompt(issues, { repo: found?.repo ?? (this.repo || null), project: found?.project ?? this.project, source: found?.source ?? this.source()?.source });
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
    // Orchestrator, Worker, Reviewer and Investigator have nothing to set: just the name and a button to see the prompt.
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
    return v_flex().flex_none().gap(10)
      .child(note(t, `The + in the Tasks header opens this agent. The model and effort are passed to the agent when it starts.`))
      .child(this.agentPicker(t, { prefix: "groom", state: g, selected: agent?.key, input: this.model, save: (patch) => this.saveGroomer(patch) }))
      .children(SUB_AGENTS.map((sub) => {
        const state = this.subAgent(sub.id);
        return v_flex().id(`settings-${sub.id}s`).flex_none().gap(10).pt(6)
          .child(h_flex().gap(6).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(S().title).font_semibold().child(sub.heading))
            .child(action(`settings-${sub.role}-prompt`, "Prompt", t, () => this.openPrompt(sub.role), true)))
          .child(note(t, sub.about))
          .child(this.agentPicker(t, { prefix: sub.id, state, selected: state.agent, input: this.subModels[sub.id], save: (patch) => this.saveSubAgent(sub.id, patch) }));
      }));
  }

  // The Agent, Model and Effort controls of one agent. prefix makes their ids distinct from the other agents' on the page; selected is the
  // agent key to mark (the New Task agent's falls back to what is installed, a helper's is what is saved); save(patch) keeps a change.
  agentPicker(t, { prefix, state, selected, input, save }) {
    const chip = (id, label, on, onClick) => h_flex().id(id).h(28).px(10).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(on ? t.selected : t.hover)).on_mouse_down("left", stop).on_click(onClick).child(label);
    const heading = (text) => div().text_size(S().secondary).font_semibold().child(text);
    return v_flex().flex_none().gap(10)
      .child(v_flex().gap(4).child(heading("Agent"))
        .child(h_flex().flex_wrap().gap(4).children(this.agents.length
          ? this.agents.map((a) => chip(`${prefix}-agent-${a.key}`, a.name, a.key === selected, (_e, cx) => { save({ agent: a.key }); cx.notify(); }))
          : [note(t, "No installed agents were found.")])))
      .child(v_flex().gap(4).child(heading("Model"))
        .child(div().id(`${prefix}-model-field`).h(34).flex_none().px(10).flex().items_center().rounded(8).border_1().border_color(t.input).on_mouse_down("left", stop)
          .child(Input.new(input).h_full().w_full().text_size(S().body).text_color(t.foreground)))
        .when(selected === "claude", (el) => el.child(h_flex().flex_wrap().gap(4).children(CLAUDE_MODELS.map((m) =>
          chip(`${prefix}-model-${m.id}`, m.name, state.model === m.id, (_e, cx) => { input.set_value(m.id); save({ model: m.id }); cx.notify(); }))))))
      .child(v_flex().gap(4).child(heading("Effort"))
        .child(h_flex().flex_wrap().gap(4).children(EFFORTS.map((e) => chip(`${prefix}-effort-${e}`, e, state.effort === e, (_e, cx) => { save({ effort: e }); cx.notify(); })))));
  }
}
