// The dim around the agent popup's panel (props.role "agent-backdrop", props { overlay }). The popup is a full-window
// overlay, and Herdr's window never closes on a click beside it and drags on any press its mod doesn't stop, so these blocks
// are ours: a press of any button closes the popup and is stopped, so it drags nothing and reaches nothing under it. The
// look is the ticket editor popup's. Not a View of its own: main.js builds one in init and draws it from render.
import { div } from "gpui-kit";
import { closeOverlay } from "herdr";
import { BACKDROP, PRESS_BUTTONS } from "../lib/index.js";

export class AgentBackdrop {
  constructor(props) { this.props = props ?? {}; }

  close() { if (this.props.overlay) closeOverlay(this.props.overlay); }

  render() {
    return PRESS_BUTTONS.reduce((el, b) => el.on_mouse_down(b, (_e, cx) => { this.close(); cx.stop_propagation(); }),
      div().id("agent-backdrop").size_full().bg(BACKDROP));
  }
}
