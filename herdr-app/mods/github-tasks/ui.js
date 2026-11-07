// What the panel and the editor both draw with: text sizes, icons, buttons, and the gh runner.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, settings } from "herdr";

export function S() {
  const b = Number(settings().ui_font_size) || 13;
  return { title: b + 1, body: b + 0.5, secondary: b - 0.5, label: b - 1 };
}

export const icon = (name, size, color) => svg(`mods/github-tasks/icons/${name}.svg`).size(size).flex_none().text_color(color);
export const stop = (_e, cx) => cx.stop_propagation();
export const note = (t, text, color) => div().flex_none().text_size(S().secondary).text_color(color ?? t.muted).child(text);

export function iconButton(id, name, t, onClick, spin) {
  const glyph = icon(name, 14, t.muted);
  return h_flex().id(id).size(24).flex_none().justify_center().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
    .on_mouse_down("left", stop).on_click(onClick).child(spin ? glyph.spin(900) : glyph);
}

// A solid button, or a quiet outline one. disabled: dimmed and inert.
export function action(id, label, t, onClick, quiet = false, disabled = false) {
  return h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(6).text_size(S().secondary)
    .when(!quiet, (el) => el.bg(t.solid).text_color(t.solid_foreground).font_semibold())
    .when(quiet, (el) => el.border_1().border_color(t.border).text_color(t.foreground))
    .when(disabled, (el) => el.opacity(0.4))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_mouse_down("left", stop).on_click(onClick))
    .child(label);
}

export const gh = (args, where) => exec("gh", args, where)
  .catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) }));
