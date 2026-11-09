// Shared look for the sync mod's views: sizes, icons, buttons. Herdr theme tokens only.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { settings } from "herdr";

export function S() {
  const b = Number(settings().ui_font_size) || 13;
  return { title: b + 1, body: b + 0.5, button: b - 0.5, secondary: b - 0.5, label: b - 1 };
}
export const icon = (name, size, color) => svg(`mods/sync/icons/${name}.svg`).size(size).flex_none().text_color(color);
export const stop = (_e, cx) => cx.stop_propagation();
// Work started from render runs after the render ends: cx.notify() throws while a view renders.
export const later = (cx, fn) => cx.spawn(async (cx) => { await cx.sleep(0); return fn(cx); });

export function primary(id, label, t, onClick, opts = {}) {
  return h_flex().id(id).h(opts.h ?? 28).px(opts.px ?? 12).gap(6).flex_none().items_center().rounded(6).bg(t.solid)
    .text_size(opts.size ?? S().button).font_semibold().text_color(t.solid_foreground).cursor_pointer().hover((s) => s.opacity(0.88))
    .on_mouse_down("left", stop).on_click(onClick).child(label);
}

export const note = (t, text, color) => div().flex_none().text_size(S().secondary).text_color(color ?? t.muted).child(text);
export const sectionLabel = (t, text) => div().flex_none().text_size(S().label).font_semibold().text_color(t.muted).child(text);
