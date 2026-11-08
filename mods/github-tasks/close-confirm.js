// The question close-tab.js asks: a dialog over the window (props.role "close-confirm"), with Cancel and Close.
// props: { tab, name }. Not a View of its own: main.js builds one in init and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, notify, props as blockProps, run, spaces, theme } from "herdr";
import { S, action } from "./ui.js";
import { closeConfirmed, closeMessage } from "./close-tab.js";

export class CloseConfirm {
  constructor(props) {
    this.tab = props?.tab ?? "";
    this.name = props?.name ?? "This task";
    this.overlay = blockProps()?.overlay ?? null;
  }

  dismiss() { if (this.overlay) closeOverlay(this.overlay); }

  render() {
    const t = theme();
    return v_flex().size_full().p(16).gap(14).bg(t.background).text_color(t.foreground)
      .child(div().text_size(S().body).child(closeMessage(this.name)))
      .child(h_flex().gap(8).justify_end()
        .child(action("close-cancel", "Cancel", t, () => this.dismiss(), true))
        .child(action("close-confirm", "Close tab", t, () => { this.dismiss(); closeConfirmed({ tab: this.tab }, { run, notify }); })));
  }
}
