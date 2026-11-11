// The gh and herdr-app runners, and work started from render.
import { exec } from "herdr";

// gh, as the loaders want it: a failure to start is an answer with a code, not a throw.
export const gh = (args, where) => exec("gh", args, where)
  .catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) }));

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
