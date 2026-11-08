// The built-in prompts page: every instruction the orchestrator, worker and reviewer get in every run, whatever the
// workflow. These are built into the app (run.js writes them into each run's folder); a workflow's
// own prompts, edited in its tab, are added under them. Read-only. Shown in a tab (props.role "prompts").
// Not a View of its own: main.js builds one in init and draws it from render.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme } from "herdr";
import { orchestratorPrompt, workerPrompt, reviewerPrompt } from "./run.js";
import { ROLE_LABELS } from "./workflow-model.js";
import { S, note } from "./ui.js";

const LABELS = ROLE_LABELS;

// What a run fills in, shown as it is in the prompts' own words.
const SAMPLE = {
  workflow: {
    name: "<workflow name>",
    orchestrator: { planning: "<the workflow's planning prompt goes here>", retro: "<the workflow's retro prompt goes here>", prompt: "<the workflow's orchestrator prompt goes here>" },
    worker: { prompt: "<the workflow's worker prompt goes here>" },
    reviewer: { prompt: "<the workflow's reviewer prompt goes here>" },
  },
  ticket: { number: 0, title: "<ticket title>" },
  repo: "<owner/repo>", runDir: "<run folder>", workDir: "<ticket worktree>", repoRoot: "<main checkout>", branch: "<branch>",
};
const clean = (text) => text.replace(/#0 <ticket title>/g, "<ticket>");

const PAGES = [
  ["orchestrator", "Directs the work: plans it, starts workers and reviewers, and decides what to fix.", orchestratorPrompt],
  ["worker", "Does one job the orchestrator gives it.", workerPrompt],
  ["reviewer", "Reads the finished work and reports findings. Read-only.", reviewerPrompt],
];

export class PromptsPage {
  constructor() {
    this.sections = PAGES.map(([role, hint, build]) => ({ role, hint, text: clean(build(SAMPLE)).trim() }));
  }

  render() {
    const t = theme();
    return v_flex().id("built-in-prompts-page").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .child(v_flex().flex_none().px(20).py(14).gap(4).border_b(1).border_color(t.border)
        .child(div().text_size(S().title).font_semibold().child("Built-in prompts"))
        .child(note(t, "What every run's orchestrator, workers and reviewers are told, in every workflow. A workflow's own prompts are added at the end of the workflow ones.")))
      .child(div().id("built-in-prompts-body").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().px(20).py(16).gap(20).children(this.sections.map((s) => this.section(t, s)))));
  }

  section(t, { role, hint, text }) {
    return v_flex().flex_none().gap(8)
      .child(v_flex().gap(2)
        .child(div().text_size(S().title).font_semibold().child(LABELS[role]))
        .child(note(t, hint)))
      .child(div().p(12).rounded(8).bg(t.chrome).border_1().border_color(t.border)
        .child(v_flex().gap(2).children(text.split("\n").map((line) => div().min_h(S().body).text_size(S().secondary).child(line)))));
  }
}
