// One workflow, in the center: a tab the Workflows panel opens (props.role "editor", props.id the
// workflow's id, or null for a new one). The trigger label, the Global box, and for the orchestrator,
// the worker and the reviewer their agent, model, effort and prompt. Save writes the JSON file.
// Not a View of its own: main.js builds one in init and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { run, setShared, theme } from "herdr";
import { ROLES, ROLE_LABELS, AGENTS, EFFORTS, STRATEGIES, STRATEGY_LABELS, STRATEGY_HINTS, blank, normalize, isDirty } from "./model.js";
import { StoreError } from "./store.js";
import { S, icon, stop, iconButton, action, checkbox } from "./ui.js";
import { CHANGED, store, repoDir, gh } from "./env.js";
import { findRepo, loadLabels, matchLabels, hasLabel } from "./labels.js";

// The dim layer behind the picker: the theme's background, half see-through where it is a hex color.
const scrim = (t) => (/^#[0-9a-f]{6}$/i.test(t.background ?? "") ? `${t.background}b3` : t.background);

export class WorkflowEditor {
  constructor(props, cx) {
    this.id = props?.id ?? null;
    this.where = props?.where ?? {}; // the selected space's folder and machine, to find its repo
    this.nameInput = InputState.new({ value: "", placeholder: "Feature development" });
    this.labelInput = InputState.new({ value: "", placeholder: "workflow:feature" });
    this.global = false;
    this.strategy = "branch";
    this.roles = {};
    for (const role of ROLES) {
      this.roles[role] = {
        agent: "claude", effort: "medium",
        model: InputState.new({ value: "", placeholder: "Agent's default" }),
        prompt: TextareaState.new({ value: "", rows: 7 }),
      };
    }
    const touched = (_e, cx) => { if (this.notice?.kind === "saved") this.notice = null; cx.notify(); };
    const inputs = [this.nameInput, ...ROLES.flatMap((r) => [this.roles[r].model, this.roles[r].prompt])];
    for (const input of inputs) input.on("change", touched);

    // The trigger completes from the repo's labels: suggestions show while it has focus or is typed in.
    this.labels = []; // [{ name, color }] of the repo the selected space is in
    this.repo = null;
    this.labelNote = "Looking up the repo's labels…"; // why there are none, while there are none
    this.suggesting = false;
    this.labelInput.on("change", (_e, cx) => { this.suggesting = true; touched(_e, cx); });
    this.labelInput.on("focus", (_e, cx) => { this.suggesting = true; cx.notify(); });
    // A click on a suggestion lands after the blur, so hiding waits a moment.
    this.labelInput.on("blur", (_e, cx) => cx.timer.after(200, (cx) => { this.suggesting = false; cx.notify(); }));
    this.labelInput.on("submit", (_e, cx) => { const first = this.suggestions()[0]; if (first) this.chooseLabel(first.name, cx); });

    this.picker = null; // the role whose agent is being chosen
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.on("submit", (_e, cx) => { const first = this.options()[0]; if (first) this.choose(first, cx); });

    this.previous = null; // what the file held when it was read: { workflow, text, global }
    this.base = blank();
    this.loaded = false;
    this.loadError = null;
    this.saving = false;
    this.notice = null; // { kind: "saved" | "error" | "conflict", text }
    this.load(cx);
    this.loadLabels(cx);
  }

  // The repo's labels, asked of GitHub from the selected space. Failing only costs the completion.
  loadLabels(cx) {
    cx.spawn(async (cx) => {
      try {
        this.repo = await findRepo(gh, this.where);
        this.labels = await loadLabels(gh, this.repo, this.where);
        this.labelNote = this.labels.length ? null : `${this.repo} has no labels yet.`;
      } catch (e) {
        this.labels = [];
        this.labelNote = e.kind === "no-auth" ? "gh isn't signed in to GitHub, so labels can't be suggested."
          : e.kind === "not-a-repo" ? "The selected space isn't in a GitHub repo, so labels can't be suggested."
            : `Couldn't look up labels: ${e.message}`;
      }
      cx.notify();
    });
  }

  // The labels offered under the trigger field: what it holds, a few at most. None once it is a label.
  suggestions() {
    const text = this.labelInput.value();
    if (!this.suggesting || !this.labels.length || hasLabel(this.labels, text)) return [];
    return matchLabels(this.labels, text, 6);
  }

  chooseLabel(name, cx) {
    this.labelInput.set_value(name);
    this.suggesting = false;
    if (this.notice?.kind === "saved") this.notice = null;
    cx.notify();
  }

  // The form as a workflow.
  current() {
    const w = { ...blank(), id: this.id ?? "", name: this.nameInput.value(), global: this.global, strategy: this.strategy, trigger: { label: this.labelInput.value() } };
    for (const role of ROLES) {
      const r = this.roles[role];
      w[role] = { prompt: r.prompt.value(), agent: r.agent, model: r.model.value(), effort: r.effort };
    }
    return normalize(w);
  }

  // Puts a workflow in the form.
  show(workflow) {
    this.nameInput.set_value(workflow.name);
    this.labelInput.set_value(workflow.trigger.label);
    this.global = workflow.global;
    this.strategy = workflow.strategy;
    for (const role of ROLES) {
      const r = this.roles[role], w = workflow[role];
      r.agent = w.agent;
      r.effort = w.effort;
      r.model.set_value(w.model);
      r.prompt.set_value(w.prompt);
    }
    this.base = normalize(workflow);
  }

  dirty() {
    return this.loaded && isDirty(this.base, this.current());
  }

  load(cx) {
    this.loaded = false;
    this.loadError = null;
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (this.id) {
          const found = await store().load(this.id);
          if (!found) throw new Error("This workflow's file is gone.");
          this.previous = found;
          this.show(found.workflow);
        } else {
          this.previous = null;
          this.show(blank());
        }
        this.loaded = true;
      } catch (e) {
        this.loadError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  revert(cx) {
    this.show(this.base);
    this.notice = null;
    cx.notify();
  }

  // Writes the file. Unless force, a file that changed since it was read is a conflict, and asks.
  save(cx, force = false) {
    if (this.saving || !this.dirty()) return;
    const after = this.current();
    this.saving = true;
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const s = store();
        // Overwrite: take the file as it is now as the thing being replaced.
        if (force && this.id) this.previous = (await s.load(this.id)) ?? this.previous;
        const saved = await s.save(after, this.previous);
        const named = !this.id || saved.workflow.name !== this.base.name;
        this.id = saved.workflow.id;
        this.previous = { workflow: saved.workflow, text: saved.text, global: saved.global };
        this.base = normalize(saved.workflow);
        const extra = saved.global && !saved.mirror.mirrored
          ? (saved.mirror.error ? ` Not copied to the clone: ${saved.mirror.error}.` : " Set the workstation clone in the Workflows panel to copy it there.")
          : saved.global ? " Copied to the workstation clone." : "";
        this.notice = { kind: "saved", text: `Saved.${extra}` };
        if (named) run("tab.rename", { name: saved.workflow.name });
        setShared(CHANGED, Date.now());
      } catch (e) {
        this.notice = e instanceof StoreError && e.kind === "conflict"
          ? { kind: "conflict", text: e.message }
          : { kind: "error", text: String(e?.message ?? e) };
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  openPicker(role, cx) {
    this.picker = role;
    this.search.set_value("");
    cx.notify();
    cx.timer.after(50, () => this.search.focus());
  }

  closePicker(cx) {
    this.picker = null;
    cx.notify();
  }

  // The agent names that match the dialog's search.
  options() {
    const q = this.search.value().trim().toLowerCase();
    return q ? AGENTS.filter((a) => a.includes(q)) : AGENTS;
  }

  choose(option, cx) {
    if (this.picker) this.roles[this.picker.role].agent = option;
    this.picker = null;
    if (this.notice?.kind === "saved") this.notice = null;
    cx.notify();
  }

  setStrategy(strategy, cx) {
    this.strategy = strategy;
    if (this.notice?.kind === "saved") this.notice = null;
    cx.notify();
  }

  setEffort(role, effort, cx) {
    this.roles[role].effort = effort;
    if (this.notice?.kind === "saved") this.notice = null;
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const body = this.loadError ? this.renderLoadError(t)
      : !this.loaded ? v_flex().flex_1().min_h(0).p(20).gap(10)
        .children([0, 1, 2].map((i) => div().h(i === 0 ? 40 : 120).flex_none().rounded(8).bg(t.chrome).opacity(1 - i * 0.2)))
      : div().id("workflow-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(20).py(16).gap(16)
          .child(this.renderBasics(t))
          .children(ROLES.map((role) => this.renderRole(t, role))));
    return v_flex().id("workflow-editor").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.picker) { this.closePicker(cx); cx.stop_propagation(); }
        else if (e.keystroke === "cmd-s") { this.save(cx); cx.stop_propagation(); }
      })
      .child(this.renderHeader(t))
      .child(body)
      .when(this.loaded, (el) => el.child(this.renderFooter(t)))
      .when(Boolean(this.picker), (el) => el.child(this.renderPicker(t)));
  }

  renderHeader(t) {
    return h_flex().h(44).flex_none().pl(20).pr(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(S().secondary).text_color(t.muted)
        .child(this.id ? `Workflow · ${this.id}` : "New workflow"));
  }

  renderLoadError(t) {
    return v_flex().flex_1().min_h(0).p(20).gap(10)
      .child(h_flex().gap(7).items_start().text_size(S().secondary).text_color(t.ansi1)
        .child(icon("alert", 14, t.ansi1))
        .child(div().flex_1().min_w(0).child(this.loadError)))
      .child(action("workflow-reload", "Try again", t, (_e, cx) => this.load(cx)));
  }

  // A bordered one-line text field around an Input.
  field(t, id, state, height = 34) {
    return div().id(`field-${id}`).h(height).flex_none().px(10).flex().items_center().rounded(8).border_1().border_color(t.input)
      .on_mouse_down("left", stop).child(Input.new(state).h_full().w_full().text_size(S().body).text_color(t.foreground));
  }

  heading(t, label, hint) {
    return h_flex().h(22).gap(8).items_center().flex_none()
      .child(div().text_size(S().label).font_semibold().text_color(t.muted).child(label))
      .when(Boolean(hint), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(S().label).text_color(t.muted).child(hint)));
  }

  renderBasics(t) {
    const repo = repoDir();
    return v_flex().flex_none().gap(12)
      .child(v_flex().gap(4).child(this.heading(t, "Name")).child(this.field(t, "name", this.nameInput, 36)))
      .child(this.renderTrigger(t))
      .child(v_flex().gap(4).child(this.heading(t, "Work strategy"))
        .child(h_flex().flex_wrap().gap(4).children(STRATEGIES.map((strategy) => {
          const on = strategy === this.strategy;
          return h_flex().id(`strategy-${strategy}`).h(28).px(12).items_center().rounded(6).cursor_pointer()
            .border_1().border_color(t.border).bg(on ? t.selected : t.background).text_size(S().secondary)
            .text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_semibold())
            .hover((s) => s.bg(on ? t.selected : t.hover)).on_mouse_down("left", stop)
            .on_click((_e, cx) => this.setStrategy(strategy, cx))
            .child(STRATEGY_LABELS[strategy] ?? strategy);
        })))
        .child(div().text_size(S().label).text_color(t.muted).child(STRATEGY_HINTS[this.strategy] ?? "")))
      .child(v_flex().gap(4)
        .child(checkbox("workflow-global", "Global", this.global, t, (_e, cx) => { this.global = !this.global; if (this.notice?.kind === "saved") this.notice = null; cx.notify(); }))
        .child(div().pl(24).text_size(S().label).text_color(t.muted)
          .child(this.global
            ? (repo ? `Saved for everyone using this workstation, and copied to ${repo}/herdr-app/workflows.` : "Saved for everyone using this workstation. Set the workstation clone in the Workflows panel to copy it into the repo.")
            : "Only on this computer.")));
  }

  // The label that starts the workflow: a field that completes from the repo's labels.
  renderTrigger(t) {
    const text = this.labelInput.value().trim(), found = this.suggestions();
    const unknown = this.labels.length > 0 && text && !hasLabel(this.labels, text);
    return v_flex().gap(4)
      .child(this.heading(t, "Trigger", "the GitHub label that starts this workflow"))
      .child(this.field(t, "trigger", this.labelInput))
      .when(found.length > 0, (el) => el.child(v_flex().id("trigger-suggestions").p(4).gap(2).rounded(8).border_1().border_color(t.border).bg(t.popover)
        .children(found.map((l) => h_flex().id(`suggest-${l.name}`).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          // On press, not click: the field's blur would otherwise take the list away before the click lands.
          .on_mouse_down("left", (_e, cx) => { this.chooseLabel(l.name, cx); cx.stop_propagation(); })
          .when(Boolean(l.color), (e) => e.child(div().w(8).h(8).flex_none().rounded_full().bg(`#${l.color}`)))
          .child(div().flex_1().min_w(0).truncate().text_size(S().body).child(l.name))))))
      .when(Boolean(this.labelNote), (el) => el.child(div().text_size(S().label).text_color(t.muted).child(this.labelNote)))
      .when(Boolean(unknown), (el) => el.child(div().text_size(S().label).text_color(t.blocked ?? t.muted)
        .child(`${this.repo} has no label named "${text}". Create it on GitHub, or the trigger won't ever fire.`)));
  }

  // Orchestrator, worker or reviewer: agent, model, effort, prompt.
  renderRole(t, role) {
    const r = this.roles[role];
    return v_flex().id(`role-${role}`).flex_none().p(14).gap(12).rounded(10).border_1().border_color(t.border)
      .child(div().text_size(S().title).font_semibold().child(ROLE_LABELS[role]))
      .child(h_flex().gap(10).items_end()
        .child(v_flex().w(150).flex_none().gap(4).child(this.heading(t, "Agent"))
          .child(h_flex().id(`agent-${role}`).h(34).px(10).gap(6).items_center().rounded(8).border_1().border_color(t.input).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => this.openPicker(role, cx))
            .child(div().flex_1().min_w(0).truncate().child(r.agent))
            .child(icon("chevron-down", 14, t.muted))))
        .child(v_flex().flex_1().min_w(0).gap(4).child(this.heading(t, "Model")).child(this.field(t, `model-${role}`, r.model))))
      .child(v_flex().gap(4).child(this.heading(t, "Effort"))
        .child(h_flex().flex_wrap().gap(4).children(EFFORTS.map((effort) => {
          const on = effort === r.effort;
          return h_flex().id(`effort-${role}-${effort}`).h(28).px(10).items_center().rounded(6).cursor_pointer()
            .border_1().border_color(t.border).bg(on ? t.selected : t.background).text_size(S().secondary)
            .text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_semibold())
            .hover((s) => s.bg(on ? t.selected : t.hover)).on_mouse_down("left", stop)
            .on_click((_e, cx) => this.setEffort(role, effort, cx))
            .child(effort);
        }))))
      .child(v_flex().gap(4).child(this.heading(t, "Prompt"))
        .child(div().id(`field-prompt-${role}`).p(10).rounded(8).border_1().border_color(t.input).on_mouse_down("left", stop)
          .child(Textarea.new(r.prompt).w_full().text_size(S().body).text_color(t.foreground))));
  }

  // The dialog over the editor: a search box and the agents, the current one marked.
  renderPicker(t) {
    const options = this.options(), current = this.roles[this.picker].agent;
    const row = (agent) => h_flex().id(`pick-${agent}`).h(32).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(agent === current, (el) => el.bg(t.selected))
      .on_mouse_down("left", stop).on_click((_e, cx) => this.choose(agent, cx))
      .child(div().w(14).h(14).flex_none().child(agent === current ? icon("check", 14, t.foreground) : div()))
      .child(div().flex_1().min_w(0).truncate().text_size(S().body).child(agent));
    const dialog = v_flex().id("agent-picker").w(320).max_h(460).flex_none().p(16).gap(12).rounded(12).border_1().border_color(t.border)
      .bg(t.popover).shadow_lg().text_color(t.foreground).text_size(S().body)
      .on_mouse_down("left", stop)
      .child(h_flex().flex_none().items_center().gap(8)
        .child(div().flex_1().min_w(0).text_size(S().title).font_semibold().child(`${ROLE_LABELS[this.picker]} agent`))
        .child(div().text_size(S().label).text_color(t.muted).child("Esc"))
        .child(iconButton("picker-close", "close", t, (_e, cx) => this.closePicker(cx))))
      .child(h_flex().id("picker-search").h(34).flex_none().px(10).gap(8).items_center().rounded(8).border_1().border_color(t.input)
        .child(icon("search", 14, t.muted))
        .child(Input.new(this.search).h_full().flex_1().text_size(S().body).text_color(t.foreground)))
      .child(div().id("picker-options").max_h(300).overflow_y_scrollbar()
        .child(v_flex().gap(2).children(options.length ? options.map(row) : [div().px(8).py(8).text_size(S().secondary).text_color(t.muted).child("No matches.")])));
    return div().id("agent-picker-backdrop").absolute().inset_0().flex().items_center().justify_center().bg(scrim(t))
      .on_mouse_down("left", (_e, cx) => { this.closePicker(cx); cx.stop_propagation(); })
      .child(dialog);
  }

  renderFooter(t) {
    const dirty = this.dirty(), n = this.notice;
    return v_flex().flex_none().px(20).py(12).gap(10).border_t(1).border_color(t.border)
      .when(Boolean(n) && n.kind !== "saved", (el) => el.child(h_flex().gap(7).items_start().text_size(S().secondary).text_color(t.ansi1)
        .child(icon("alert", 14, t.ansi1)).child(div().flex_1().min_w(0).child(n.text))))
      .when(n?.kind === "conflict", (el) => el.child(h_flex().gap(6)
        .child(action("workflow-overwrite", "Overwrite", t, (_e, cx) => this.save(cx, true)))
        .child(action("workflow-reload-file", "Reload from disk", t, (_e, cx) => this.load(cx), true))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(S().secondary).text_color(n?.kind === "saved" ? t.ansi2 : t.muted)
          .child(this.saving ? "Saving…" : n?.kind === "saved" ? n.text : dirty ? "Unsaved changes" : "No changes"))
        .child(action("workflow-revert", "Revert", t, (_e, cx) => this.revert(cx), true, !dirty || this.saving))
        .child(action("workflow-save", this.saving ? "Saving…" : "Save", t, (_e, cx) => this.save(cx), false, !dirty || this.saving)));
  }
}
