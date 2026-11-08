// The bar under the workspace: this computer or machine, the branch, and the agents that need you.
// Syncing the config repo lives in the sync mod.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme } from "herdr";

const label = (name, text) => h_flex().gap(6).items_center().child(svg(`mods/status-bar/icons/${name}.svg`).size(13)).child(text);

export default class StatusBar extends View {
  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents(), needs = list.filter((a) => a.status === "blocked").length;
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))));
  }
}
