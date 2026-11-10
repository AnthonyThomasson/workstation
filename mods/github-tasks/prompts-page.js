// One read-only, rendered-markdown agent prompt in a center tab (props.role "prompt"). New Task carries the current
// repo/project/status context; the other roles show their built-in instructions with sample run placeholders.
// Not a View of its own: main.js builds one and draws it from render.
import { div } from "gpui-kit";
import { v_flex, TextView } from "gpui-base";
import { theme } from "herdr";
import { markdownLiteral, promptForRole } from "./settings-model.js";
import { ROLE_LABELS } from "./workflow-model.js";
import { S, note } from "./ui.js";

const PAGES = [
  ["newTask", "What the + in the Tasks header tells the agent when it opens: wait for what you want to make, grill you on the acceptance criteria, then ask whether to create it and in which status."],
  ["orchestrator", "Directs the work: plans it, starts workers, reviewers and investigators, and decides what to fix."],
  ["worker", "Does one job the orchestrator gives it."],
  ["reviewer", "Reads the finished work and reports findings. Read-only."],
  ["investigator", "Explores the code to answer a question from the agent that started it. Read-only."],
  ["newTaskInvestigator", "What an investigator the New Task agent starts is told: explore the session's worktree read-only to answer the agent's question, and report back."],
  ["newTaskWorker", "What a prototype worker the New Task agent starts is told: build a throwaway prototype in its own worktree and report back. Its code is discarded when the session is done."],
];
export const PROMPT_HINTS = Object.fromEntries(PAGES);
const NEW_TASK_LABELS = { newTask: "New Task", newTaskInvestigator: "New Task investigator", newTaskWorker: "New Task prototype worker" };

export class PromptPage {
  constructor(props = {}) {
    this.role = props.promptRole;
    this.text = promptForRole(this.role, props);
  }

  render() {
    const t = theme();
    const label = NEW_TASK_LABELS[this.role] ?? ROLE_LABELS[this.role];
    const hint = PROMPT_HINTS[this.role];
    return v_flex().id("prompt-page").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(S().body)
      .child(v_flex().flex_none().px(20).py(14).gap(4).border_b(1).border_color(t.border)
        .child(div().text_size(S().title).font_semibold().child(label ? `${label} prompt` : "Prompt"))
        .when(Boolean(hint), (el) => el.child(note(t, hint))))
      .child(div().id("prompt-body").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(16)
        .child(this.text == null
          ? note(t, "This prompt isn't available.")
          : TextView.markdown(`prompt-${this.role}`, markdownLiteral(this.text)).selectable(true)));
  }
}
