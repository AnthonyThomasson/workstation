// One read-only, rendered-markdown agent prompt in a center tab (props.role "prompt"). New Task carries the current
// repo/project/status context; the other roles show their built-in instructions with sample run placeholders.
// Not a View of its own: main.js builds one and draws it from render.
import { div } from "gpui-kit";
import { v_flex, TextView } from "gpui-base";
import { theme } from "herdr";
import { markdownLiteral, promptForRole, promptTitle } from "./settings-model.js";
import { S, note } from "./widgets/index.js";

const PAGES = [
  ["newTask", "What the + in the Tasks header tells the New Task Orchestrator when it opens: wait for what you want to make, grill you on the acceptance criteria, then ask whether to create it and in which status."],
  ["orchestrator", "The Task Orchestrator runs a workflow: it plans the work, starts Workers, Reviewers and Investigators, and decides what to fix."],
  ["refactor", "What the broom button tells the Refactor Orchestrator when it opens: run the refactor type, find and rate candidates, then make a ticket for each one you pick. It starts Investigators and Workers (prototypes)."],
  ["worker", "Started by the Task Orchestrator, in workflow runs only. Does one job the Task Orchestrator gives it."],
  ["reviewer", "Started by the Task Orchestrator, in workflow runs only. Reads the finished work and reports findings. Read-only."],
  ["investigator", "A shared read-only agent: explores the code to answer a question from the agent that started it. The New Task, Task and Refactor Orchestrators can all start it."],
  ["newTaskInvestigator", "What an investigator the New Task Orchestrator starts is told: explore the session's worktree read-only to answer its question, and report back."],
  ["newTaskWorker", "What a prototype worker the New Task Orchestrator starts is told: build a throwaway prototype in its own worktree and report back. Its code is discarded when the session is done."],
];
export const PROMPT_HINTS = Object.fromEntries(PAGES);

export class PromptPage {
  constructor(props = {}) {
    this.role = props.promptRole;
    this.text = promptForRole(this.role, props);
  }

  render() {
    const t = theme();
    const hint = PROMPT_HINTS[this.role];
    return v_flex().id("prompt-page").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .child(v_flex().flex_none().px(20).py(14).gap(4).border_b(1).border_color(t.border)
        .child(div().text_size(S().title).font_semibold().child(promptTitle(this.role)))
        .when(Boolean(hint), (el) => el.child(note(t, hint))))
      .child(div().id("prompt-body").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(16)
        .child(this.text == null
          ? note(t, "This prompt isn't available.")
          : TextView.markdown(`prompt-${this.role}`, markdownLiteral(this.text)).selectable(true)));
  }
}
