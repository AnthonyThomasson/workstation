// The question close-tab.js asks: a dialog over the window (props.role "close-confirm"), with Cancel and Close.
// props: { tab, name }. Not a View of its own: main.js builds one in init and draws it from render.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, notify, props as blockProps, shared, setShared, theme } from "herdr";
import { S, action, app } from "./ui.js";
import { cancelClose, closeMessage, confirmClose, ASKING } from "./close-tab.js";

export class CloseConfirm {
  constructor(props) {
    this.tab = props?.tab ?? "";
    this.name = props?.name ?? "This task";
    this.overlay = blockProps()?.overlay ?? null;
    this.deps = { run: app, notify, dismiss: () => this.dismiss() }; // app: a failed close reaches the error notification
  }

  // The dialog is gone (Cancel, Close, or Esc): a key press may ask again.
  forget() { setShared(ASKING, Object.fromEntries(Object.entries(shared(ASKING) ?? {}).filter(([tab]) => tab !== this.tab))); }
  dismiss() { this.forget(); if (this.overlay) closeOverlay(this.overlay); }
  async close() { this.forget(); }

  render() {
    const t = theme();
    return v_flex().size_full().p(16).gap(14).bg(t.background).text_color(t.foreground)
      .child(div().text_size(S().body).child(closeMessage(this.name)))
      .child(h_flex().gap(8).justify_end()
        .child(action("close-cancel", "Cancel", t, () => cancelClose(this.deps), true))
        .child(action("close-confirm", "Close tab", t, () => confirmClose({ tab: this.tab }, this.deps))));
  }
}
