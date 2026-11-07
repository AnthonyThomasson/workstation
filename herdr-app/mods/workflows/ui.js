// What the panel and the editor both draw with: text sizes, icons, buttons, a checkbox.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { settings } from "herdr";

export function S() {
  const b = Number(settings().ui_font_size) || 13;
  return { title: b + 1, body: b + 0.5, secondary: b - 0.5, label: b - 1 };
}

export const icon = (name, size, color) => svg(`mods/workflows/icons/${name}.svg`).size(size).flex_none().text_color(color);
export const stop = (_e, cx) => cx.stop_propagation();
export const note = (t, text, color) => div().flex_none().text_size(S().secondary).text_color(color ?? t.muted).child(text);

export function iconButton(id, name, t, onClick, color) {
  return h_flex().id(id).size(24).flex_none().justify_center().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
    .on_mouse_down("left", stop).on_click(onClick).child(icon(name, 14, color ?? t.muted));
}

// A row of tabs, one chosen: options are [key, label] pairs.
export function segmented(id, options, value, t, onPick) {
  return h_flex().id(id).w_full().p(2).gap(2).rounded(8).bg(t.chrome).border_1().border_color(t.border).children(options.map(([key, label]) => {
    const on = key === value;
    return h_flex().id(`${id}-${key}`).flex_1().min_w(0).h(26).justify_center().items_center().rounded(6)
      .bg(on ? t.raised : t.chrome).text_size(S().secondary).text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_semibold())
      .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click((_e, cx) => onPick(key, cx))
      .child(div().truncate().child(label));
  }));
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

// A box that is ticked or not, with its label. The whole row is the target.
export function checkbox(id, label, on, t, onClick) {
  return h_flex().id(id).gap(8).flex_none().items_center().cursor_pointer().on_mouse_down("left", stop).on_click(onClick)
    .child(h_flex().w(16).h(16).flex_none().items_center().justify_center().rounded(4).border_1().border_color(on ? t.solid : t.input)
      .when(on, (el) => el.bg(t.solid).child(icon("check", 12, t.solid_foreground))))
    .child(div().text_size(S().body).text_color(t.foreground).child(label));
}
