import * as herdr from "herdr";
import { openOverlay, shared, setShared } from "herdr";
import { SAMPLE, BUILTIN, popup, KEY, keyFor } from "./helper.js";
import { createChannel, Panel } from "./channel.js";
const channel = createChannel({ get: (k) => shared(k), set: (k, v) => setShared(k, v) });
const deps = { shared, setShared, other: 1 };
export const panel = new Panel({ ...deps, extra: 2 });
export function init(id) {
  openOverlay({ mod: "clean" });
  openOverlay({ mod: "new-menu" });
  openOverlay(popup());
  setShared(KEY, shared(keyFor(id)) ?? shared("workspace.panels"));
  herdr.shared("clean.namespace");
  return [SAMPLE, BUILTIN, "mods/clean/main.js", channel];
}
