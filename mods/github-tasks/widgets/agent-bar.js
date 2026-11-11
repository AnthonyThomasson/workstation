// The bar over a peeked agent's terminal (props.role "agent-bar", props { terminal, overlay }): the agent's status dot or
// spinner, program icon, name, status word, who it is from, a muted "Esc" hint and a ✕. It looks like Herdr's own peek bar
// (mods/peek) without "keep" and "go to". It takes the keyboard when the popup opens and closes it on Esc, stopping the key,
// so Esc never reaches the agent; a click into the terminal gives the agent the keyboard (and its Esc) until the bar is
// clicked or the popup reopened. Not a View of its own: main.js builds one in init and draws it from render.
import { div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, closeOverlay, openOverlay, props as blockProps, terminals, theme } from "herdr";
import { PRESS_BUTTONS, WORDS, agentPopupOverlay, barTitle, isEscape, parentLabel } from "../lib/index.js";
import { S, stop } from "./ui.js";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Opens (or replaces) the popup for an agent's terminal address.
export const openAgentPopup = (address) => openOverlay(agentPopupOverlay(address));

// The icon from the app's program table: a one-color glyph or a picture.
const programIcon = (p, size, color) => {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
};

export class AgentBar {
  constructor(props, cx) {
    this.props = props ?? {};
    this.handle = cx.focus_handle();
    // A window doesn't take the keyboard when it opens: take it now, and again once the layout has settled (the terminal block may grab it after the first try).
    this.handle.focus();
    cx.timer.after(50, () => this.handle.focus());
    cx.timer.after(250, () => this.handle.focus());
  }

  close() { if (this.props.overlay) closeOverlay(this.props.overlay); }

  term() { return terminals().find((t) => t.address === this.props.terminal); }

  status() { return agents().find((a) => a.address === this.props.terminal)?.status ?? this.term()?.status ?? null; }

  render() {
    const t = theme(), { terminal } = this.props;
    const k = this.term(), st = this.status();
    const pic = programIcon(k?.program, 14, t.foreground);
    const from = parentLabel(k?.parent ? terminals().find((p) => p.address === k.parent) : null);
    const glyph = st === "working" ? SPIN[0] : st === "idle" ? "○" : st ? "●" : "·";
    const close = PRESS_BUTTONS.reduce((el, b) => el.on_mouse_down(b, stop), // a press on the ✕ must not drag the window
      div().id("agent-bar-close").px(8).py(2).rounded(5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click(() => this.close()).child("✕");
    return h_flex().id("agent-bar").track_focus(this.handle).size_full().px(12).gap(8).items_center().bg(t.surface).border_b(1).border_color(t.border).text_size(S().label)
      .on_key_down((e, cx) => { if (isEscape(e)) { this.close(); cx.stop_propagation(); } })
      .child(div().w(12).flex_none().text_color(t[st] ?? t.dim).when(st === "working", (el) => el.frames(SPIN, 90)).child(glyph))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().truncate().font_semibold().text_color(t.foreground).child(barTitle(k, terminal)))
      .when(Boolean(st), (el) => el.child(div().flex_none().text_color(t[st] ?? t.dim).child(WORDS[st] ?? st)))
      .when(Boolean(from), (el) => el.child(div().truncate().text_color(t.dim).child(from)))
      .child(div().flex_1())
      .child(div().flex_none().text_color(t.dim).child("Esc"))
      .child(close);
  }
}
