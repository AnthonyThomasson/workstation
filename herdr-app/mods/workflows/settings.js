// The settings page: every instruction the orchestrator, worker and reviewer get in every run, whatever the
// workflow. These are built into the app (github-tasks/run.js writes them into each run's folder); a workflow's
// own prompts, edited in its tab, are added under them. Read-only. Shown in a tab (props.role "settings").
// Not a View of its own: main.js builds one in init and draws it from render.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme } from "herdr";
import { orchestratorPrompt, workerPrompt, reviewerPrompt } from "./prompts.js";
import { ROLE_LABELS } from "./model.js";
import { S, note } from "./ui.js";

// What a run fills in, shown as it is in the prompts' own words.
const SAMPLE = {
  workflow: { name: "<workflow name>", orchestrator: {}, worker: {}, reviewer: {} },
  ticket: { number: 0, title: "<ticket title>" },
  repo: "<owner/repo>", runDir: "<run folder>", workDir: "<work folder>", branch: "<branch>",
};
const clean = (text) => text.replace(/#0 <ticket title>/g, "<ticket>");

const PAGES = [
  ["orchestrator", "Directs the work: plans it, starts workers and reviewers, and decides what to fix.", orchestratorPrompt],
  ["worker", "Does one job the orchestrator gives it.", workerPrompt],
  ["reviewer", "Reads the finished work and reports findings. Read-only.", reviewerPrompt],
];

export class SettingsPage {
  constructor() {
    this.sections = PAGES.map(([role, hint, build]) => ({ role, hint, text: clean(build(SAMPLE)).trim() }));
  }

  render() {
    const t = theme();
    return v_flex().id("workflow-settings").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .child(v_flex().flex_none().px(20).py(14).gap(4).border_b(1).border_color(t.border)
        .child(div().text_size(S().title).font_semibold().child("Workflow settings"))
        .child(note(t, "What every run's orchestrator, workers and reviewers are told, in every workflow. A workflow's own prompts are added at the end of these.")))
      .child(div().id("workflow-settings-body").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(20).py(16).gap(20).children(this.sections.map((s) => this.section(t, s)))));
  }

  section(t, { role, hint, text }) {
    return v_flex().flex_none().gap(8)
      .child(v_flex().gap(2)
        .child(div().text_size(S().title).font_semibold().child(ROLE_LABELS[role]))
        .child(note(t, hint)))
      .child(div().p(12).rounded(8).bg(t.chrome).border_1().border_color(t.border)
        .child(v_flex().gap(2).children(text.split("\n").map((line) => div().min_h(S().body).text_size(S().secondary).child(line)))));
  }
}
