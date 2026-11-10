import { join } from "node:path";
export const a = (name) => "mods/" + name + "/x.js";
export const b = `${"mods"}/beta/x.js`;
export const c = "mods" + "/beta/x.js";
export const d = (name) => join("mods", name, "x.js");
export const e = `${"mods"}/alpha/x.js`;
