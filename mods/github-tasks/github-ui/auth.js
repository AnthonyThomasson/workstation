// Signing gh in with the scopes Tasks needs, in the background: gh runs detached so its one-time code
// can be read while it waits for the browser. Used by the panel and by the editor.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, settings } from "herdr";
import { signInFrom, preparedFrom, usesDeviceFlow, REFRESH, LOGIN, SIGN_IN, SIGN_IN_CLEANUP, SIGN_IN_DEVICE, SIGN_IN_PREPARE, DEVICE_URL, DEVICE_TIMEOUT_MS, signInSeconds } from "../lib/index.js";
import { shOn } from "../runs/index.js";
import { S, note, action } from "../widgets/index.js";

// The sign-in's scripts (lib/gh-sign-in.js) run as the machine runs sh: plain sh here and on Unix, Git Bash on Windows, which has
// no sh on its PATH (shOn asks the machine what it runs, once).
const sh = (on, script, args, opts) => shOn({ exec }, on, script, args, opts);

export { REFRESH, LOGIN };

export class Auth {
  constructor() { this.state = null; } // a sign-in in progress, or the last one's failure

  get busy() { return this.state?.phase === "starting" || Boolean(this.state?.dir); }

  // args: REFRESH or LOGIN. onDone runs once gh has signed in.
  start(cx, args, on, onDone) {
    if (this.busy) return;
    const pending = { phase: "starting", code: null, url: null, dir: null };
    this.state = pending;
    cx.notify();
    cx.spawn(async (cx) => {
      const failed = (e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) });
      const fail = (r) => { this.state = { phase: "failed", message: r.stderr.trim().split("\n")[0] || "Could not start gh." }; cx.notify(); };
      const prepared = await sh(on, SIGN_IN_PREPARE, []).catch(failed);
      const { dir, kernel } = preparedFrom(prepared.stdout);
      if (this.state !== pending) return;
      if (prepared.code !== 0 || !dir) return fail(prepared);
      // On another machine or a non-Mac: the device flow, its exec held open until gh ends (ended, once it has).
      const device = usesDeviceFlow(on, kernel);
      let ended = null;
      if (device) sh(on, SIGN_IN_DEVICE, [dir, ...args], { timeout: DEVICE_TIMEOUT_MS }).catch(failed).then((r) => { ended = r; });
      else {
        const started = await sh(on, SIGN_IN, [dir, ...args]).catch(failed);
        if (this.state !== pending) return;
        if (started.code !== 0) return fail(started);
      }
      this.state = { ...pending, phase: "waiting", dir, device };
      cx.notify();
      const mine = () => this.state?.dir === dir;
      for (let i = 0; i < signInSeconds(device); i++) {
        await cx.sleep(1000);
        if (!mine()) return;
        const over = ended; // read before the files: gh's code file is written before its exec ends
        const err = (await readTextFile(`${dir}/err`, { on }).catch(() => null)) ?? "";
        const done = ((await readTextFile(`${dir}/code`, { on }).catch(() => null)) ?? "").trim();
        const { code, url } = signInFrom(err);
        if (code !== this.state.code || url !== this.state.url) { this.state = { ...this.state, code, url }; cx.notify(); }
        if (!done && over) {
          sh(on, SIGN_IN_CLEANUP, [dir]).catch(() => {});
          const why = `${over.stderr}\n${err}`.trim().split("\n").filter(Boolean);
          this.state = { phase: "failed", message: why[why.length - 1] ?? "gh stopped before signing in." };
          return cx.notify();
        }
        if (!done) continue;
        sh(on, SIGN_IN_CLEANUP, [dir]).catch(() => {});
        if (done === "0") {
          this.state = null;
          onDone(cx);
        } else {
          const lines = err.trim().split("\n").filter(Boolean);
          this.state = { phase: "failed", message: lines[lines.length - 1] ?? "Sign-in didn't finish." };
        }
        return cx.notify();
      }
      if (mine()) { this.state = { phase: "failed", message: "Sign-in timed out. Try again." }; cx.notify(); }
    });
  }

  // The sign-in in progress: gh's code to enter on GitHub, or what went wrong.
  render(t, retry) {
    const a = this.state;
    if (a.phase === "failed") return v_flex().gap(8)
      .child(div().text_size(S().secondary).text_color(t.ansi1).child(a.message))
      .child(action("github-sign-in-retry", "Try again", t, retry));
    if (!a.code) return note(t, "Starting sign-in with GitHub…");
    return v_flex().gap(8)
      .child(note(t, a.device
        ? `On this computer, open ${(a.url ?? DEVICE_URL).replace(/^https:\/\//, "")}, enter this code, then approve gh:`
        : "Enter this code on GitHub, then approve gh:"))
      .child(div().id("github-sign-in-code").px(10).py(8).rounded(6).border_1().border_color(t.border).bg(t.chrome)
        .font_family(settings().font_family || "Menlo").text_size(S().body).font_semibold().text_color(t.foreground).child(a.code))
      .child(h_flex().gap(6)
        .child(action("github-sign-in-open", "Open GitHub", t, (_e, cx) => cx.open_url(a.url ?? DEVICE_URL)))
        .child(action("github-sign-in-copy", "Copy code", t, (_e, cx) => cx.write_to_clipboard(a.code), true)))
      .child(note(t, "Waiting for you to approve in the browser…"));
  }
}
