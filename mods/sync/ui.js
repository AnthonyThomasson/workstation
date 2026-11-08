// Shared look for the sync mod's views: sizes, icons, buttons, the dialog frame. Herdr theme tokens only.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";

export function S() {
  const b = Number(settings().ui_font_size) || 13;
  return { dialog: b + 2, title: b + 1, body: b + 0.5, button: b - 0.5, secondary: b - 0.5, label: b - 1 };
}
export const mono = () => settings().font_family || "Menlo";
export const icon = (name, size, color) => svg(`mods/sync/icons/${name}.svg`).size(size).flex_none().text_color(color);
export const stop = (_e, cx) => cx.stop_propagation();
export const dot = (color, size = 8, hollow = false) => hollow
  ? div().w(size).h(size).flex_none().rounded_full().border(1.5).border_color(color)
  : div().w(size).h(size).flex_none().rounded_full().bg(color);
export const warnBox = (t, text) => div().flex_none().px(12).py(10).rounded(6).bg(t.selected).text_size(S().secondary).text_color(t.blocked).child(text);
// Work started from render runs after the render ends: cx.notify() throws while a view renders.
export const later = (cx, fn) => cx.spawn(async (cx) => { await cx.sleep(0); return fn(cx); });

export function primary(id, label, t, onClick, opts = {}) {
  return h_flex().id(id).h(opts.h ?? 28).px(opts.px ?? 12).gap(6).flex_none().items_center().rounded(6).bg(t.solid)
    .text_size(opts.size ?? S().button).font_semibold().text_color(t.solid_foreground).cursor_pointer().hover((s) => s.opacity(0.88))
    .on_mouse_down("left", stop).on_click(onClick).child(label);
}

export function secondary(id, label, t, onClick, opts = {}) {
  const color = opts.color ?? t.foreground;
  return h_flex().id(id).h(opts.h ?? 28).px(opts.px ?? 12).gap(6).flex_none().items_center().rounded(6)
    .when(!opts.quiet, (el) => el.border_1().border_color(t.border))
    .text_size(opts.size ?? S().button).text_color(color).cursor_pointer().hover((s) => s.bg(t.hover))
    .on_mouse_down("left", stop).on_click(onClick).child(label);
}

// A button that does nothing now: dimmed, with a spinner while `spin`.
export const disabledButton = (id, label, t, opts = {}) => h_flex().id(id).h(opts.h ?? 28).px(opts.px ?? 12).gap(6).flex_none().items_center().rounded(6)
  .border_1().border_color(t.border).text_size(opts.size ?? S().button).text_color(t.dim)
  .when(Boolean(opts.spin), (el) => el.child(icon("ring", 13, t.muted).spin(900))).child(label);

export const pill = (text, t, color) => h_flex().h(20).px(8).flex_none().items_center().rounded(10).bg(t.selected)
  .text_size(S().label).text_color(color ?? t.muted).child(text);
export const note = (t, text, color) => div().flex_none().text_size(S().secondary).text_color(color ?? t.muted).child(text);
export const sectionLabel = (t, text) => div().flex_none().text_size(S().label).font_semibold().text_color(t.muted).child(text);
export const monoBox = (t, id, text) => div().id(id).overflow_y_scrollbar().px(12).py(10).rounded(8).border_1().border_color(t.border)
  .bg(t.background).font_family(mono()).text_size(S().secondary).text_color(t.foreground).child(text);

export const dialogButton = (id, label, t, onClick, kind = "secondary", enabled = true) => {
  const solid = kind === "primary";
  return h_flex().id(id).h(32).px(14).flex_none().items_center().rounded(8).border_1()
    .border_color(solid ? t.solid : t.input).bg(!enabled ? t.raised : solid ? t.solid : t.raised)
    .text_size(S().button).text_color(!enabled ? t.muted : solid ? t.solid_foreground : t.foreground)
    .when(solid, (el) => el.font_semibold())
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick)).child(label);
};

// A dialog's frame: title, Esc hint, body, buttons. Esc closes; Enter runs onEnter.
export function dialogFrame(t, id, handle, title, body, buttons, onClose, onEnter) {
  return v_flex().id(id).track_focus(handle)
    .on_key_down((e, cx) => {
      if (e.key === "escape") onClose();
      else if (e.key === "enter" && onEnter) onEnter(cx);
      else return;
      cx.stop_propagation();
    })
    .size_full().min_h(0).p(18).gap(14).bg(t.popover).text_size(S().body).text_color(t.foreground)
    .child(h_flex().flex_none().items_center().gap(8)
      .child(div().flex_1().min_w(0).text_size(S().dialog).font_semibold().child(title))
      .child(div().text_size(S().label).text_color(t.muted).child("Esc")))
    .child(v_flex().flex_1().min_h(0).gap(12).children(body.filter(Boolean)))
    .child(h_flex().flex_none().justify_end().items_center().gap(8).children(buttons.filter(Boolean)));
}
