// The small light beside the sidebar's gear when a Test device is bound: its colour is the cheap light, its tooltip lists the failing
// checks with their fixes, and a press opens Task settings. null when unbound or before hc machine ls has answered.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { shared } from "herdr";
import { TEST_DEVICE } from "../lib/index.js";
import { headerDot, normalizeBinding } from "../devices/index.js";
import { stop } from "../widgets/index.js";

export function deviceDot(t, machines, onOpen) {
  const dot = headerDot(normalizeBinding(shared(TEST_DEVICE)), machines.list);
  if (!dot) return null;
  return h_flex().id("device-light").size(24).flex_none().justify_center().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
    .tooltip(dot.tip).on_mouse_down("left", stop).on_click(onOpen)
    .child(div().size(8).rounded_full().bg(t[dot.color]));
}
