// Signing gh in with the scopes Tasks needs, in the background: gh runs detached so its one-time code
// can be read while it waits for the browser. Used by the panel and by the editor.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, settings } from "herdr";
import { signInFrom } from "./model.js";
import { S, note, action } from "./ui.js";

// gh's output goes to a new folder, which the script prints, and its exit code goes to code when it ends.
const SIGN_IN = 'd=$(mktemp -d) || exit 1; ( GH_PROMPT_DISABLED=1 gh "$@" </dev/null >"$d/out" 2>"$d/err"; echo $? > "$d/code" ) >/dev/null 2>&1 &\necho "$d"';
const SIGN_IN_SECONDS = 900; // GitHub's device codes last about 15 minutes

// "project" lets Tasks read Projects and edit them; it includes read:project.
const GRANT = ["-h", "github.com", "-s", "project"];
export const REFRESH = ["auth", "refresh", ...GRANT];
export const LOGIN = ["auth", "login", "-h", "github.com", "-p", "https", "-s", "project", "-w"];

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
      const started = await exec("sh", ["-c", SIGN_IN, "github-tasks-sign-in", ...args], { on })
        .catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
      const dir = started.stdout.trim();
      if (this.state !== pending) return;
      if (started.code !== 0 || !dir) { this.state = { phase: "failed", message: started.stderr.trim().split("\n")[0] || "Could not start gh." }; return cx.notify(); }
      this.state = { ...pending, phase: "waiting", dir };
      cx.notify();
      const mine = () => this.state?.dir === dir;
      for (let i = 0; i < SIGN_IN_SECONDS; i++) {
        await cx.sleep(1000);
        if (!mine()) return;
        const err = (await readTextFile(`${dir}/err`, { on }).catch(() => null)) ?? "";
        const done = ((await readTextFile(`${dir}/code`, { on }).catch(() => null)) ?? "").trim();
        const { code, url } = signInFrom(err);
        if (code !== this.state.code || url !== this.state.url) { this.state = { ...this.state, code, url }; cx.notify(); }
        if (!done) continue;
        exec("sh", ["-c", 'rm -rf "$1"', "github-tasks-sign-in", dir], { on }).catch(() => {});
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
      .child(note(t, "Enter this code on GitHub, then approve gh:"))
      .child(div().id("github-sign-in-code").px(10).py(8).rounded(6).border_1().border_color(t.border).bg(t.chrome)
        .font_family(settings().font_family || "Menlo").text_size(S().body).font_semibold().text_color(t.foreground).child(a.code))
      .child(h_flex().gap(6)
        .child(action("github-sign-in-open", "Open GitHub", t, (_e, cx) => cx.open_url(a.url ?? "https://github.com/login/device")))
        .child(action("github-sign-in-copy", "Copy code", t, (_e, cx) => cx.write_to_clipboard(a.code), true)))
      .child(note(t, "Waiting for you to approve in the browser…"));
  }
}
