import { join } from "node:path";
import path from "node:path";
export const a = join("mods", "beta", "x.js");
export const b = path.join("mods", "ghost");
export const c = path.posix.join("mods", "beta");
export const d = join("mods", "alpha", "x.js");
export const e = (name) => join("mods", name, "x.js");
export const f = join("mods", "pane");
