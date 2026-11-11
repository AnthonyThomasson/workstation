// The repository's Project buttons. Reusable by a page that supplies its ticket worktree and target space.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, notify, readTextFile, run, spaces } from "herdr";
import { parseProjectButtons, projectButtonArgv } from "../runs/index.js";
import { projectConfigPath } from "../workflow/index.js";
import { app, S, stop } from "../widgets/index.js";

export class ProjectButtons {
  constructor({ folder, space }) {
    this.folder = folder ?? "";
    this.space = space; // an id, or a function that finds the current ticket space
    this.buttons = [];
    this.errors = [];
    this.tabs = new Map(); // name + command -> the tab this widget opened
    this.opening = new Set();
    this.reading = false;
  }

  visible() { return Boolean(this.buttons.length || this.errors.length); }
  targetSpace() { return typeof this.space === "function" ? this.space() : this.space; }
  key(button) { return `${button.name}\n${button.command}`; }

  // The run page's refresh re-reads the file, so edits appear without rebuilding the page. A missing file is simply empty.
  async refresh() {
    if (this.reading) return;
    this.reading = true;
    try {
      const source = this.folder ? await readTextFile(projectConfigPath(this.folder)).catch(() => null) : null;
      const next = parseProjectButtons(source);
      this.buttons = next.buttons;
      this.errors = next.errors;
    } finally { this.reading = false; }
  }

  render(t) {
    return v_flex().id("run-project").flex_none().gap(2)
      .child(div().px(8).pb(4).text_size(S().label).font_semibold().text_color(t.muted).child("Project"))
      .when(Boolean(this.buttons.length), (el) => el.child(h_flex().px(8).pb(2).flex_wrap().gap(6)
        .children(this.buttons.map((button, i) => h_flex().id(`run-project-button-${i}`).h(26).px(10).flex_none().items_center().rounded(6)
          .bg(t.selected).text_size(S().secondary).font_medium().cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(button.command).on_mouse_down("left", stop).on_click((_e, cx) => this.open(button, cx))
          .child(`▶ ${button.name}`)))))
      .when(Boolean(this.errors.length), (el) => el.child(div().id("run-project-errors").px(8).text_size(S().secondary).text_color(t.muted)
        .child(this.errors.join(" "))));
  }

  focus(tab) {
    for (const space of spaces()) {
      if (space.tabs?.some((t) => t.id === tab)) {
        run("space.select", { id: space.id });
        run("tab.select", { id: tab });
        return true;
      }
    }
    return false;
  }

  // Opens one terminal tab for the command, or focuses the one this widget already opened, even if it was moved to another space.
  open(button, cx) {
    const key = this.key(button), tab = this.tabs.get(key);
    if (tab && this.focus(tab)) return;
    this.tabs.delete(key);
    if (this.opening.has(key)) return;
    const space = this.targetSpace();
    if (!this.folder || !space) {
      notify({ title: `Couldn't open ${button.name}`, body: "The ticket's space isn't open.", level: "warning" });
      return;
    }
    this.opening.add(key);
    cx.spawn(async () => {
      try {
        const found = await exec("sh", ["-c", 'printf %s "${SHELL:-/bin/sh}"']);
        const shell = found.stdout.trim();
        if (found.code !== 0 || !shell) throw new Error(found.stderr.trim() || "Your shell couldn't be found.");
        const made = await app("tab.new", { name: button.name, folder: this.folder, space, argv: projectButtonArgv(button.command, shell) });
        if (!made.tab) throw new Error("The project tab didn't open.");
        this.tabs.set(key, made.tab);
        run("space.select", { id: space });
        run("tab.select", { id: made.tab });
      } catch (e) {
        notify({ title: `Couldn't open ${button.name}`, body: String(e?.message ?? e), level: "error" });
      } finally { this.opening.delete(key); }
    });
  }
}
