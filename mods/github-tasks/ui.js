// What the sidebar, the settings and the editors and pages all draw with: text sizes, icons, buttons, the gh and
// herdr-app runners, and work started from render.
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

// badge: a color, to show a small dot at the button's top right.
export function iconButton(id, name, t, onClick, spin, tip, color, badge) {
  const glyph = icon(name, 14, color ?? t.muted);
  return h_flex().id(id).size(24).flex_none().justify_center().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .when(Boolean(badge), (el) => el.relative().child(div().absolute().top(3).right(3).size(7).rounded_full().bg(badge)))
    .on_mouse_down("left", stop).on_click(onClick).child(spin ? glyph.spin(900) : glyph);
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

// gh, as the loaders want it: a failure to start is an answer with a code, not a throw.
export const gh = (args, where) => exec("gh", args, where)
  .catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) }));

// The dim layer behind a picker: the theme's background, half see-through where it is a hex color.
export const scrim = (t) => (/^#[0-9a-f]{6}$/i.test(t.background ?? "") ? `${t.background}b3` : t.background);

// Work started from render: cx.notify() throws while a view renders, so it starts after.
export const later = (cx, fn) => cx.spawn(async (cx) => { await cx.sleep(0); return fn(cx); });

// One herdr-app command, waited for, with what it made ({ tab, terminal, pane, ... }). Throws with its message.
export async function app(name, args) {
  const r = await exec("herdr-app", ["do", name, ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, typeof v === "string" ? v : JSON.stringify(v)])]);
  let made = {};
  try { made = JSON.parse(r.stdout || "{}"); } catch { /* nothing readable */ }
  if (r.code !== 0 || made.error) throw new Error(made.error || r.stderr.trim() || `${name} failed`);
  return made;
}
