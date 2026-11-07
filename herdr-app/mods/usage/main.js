// Usage under the Agents panel, one line per provider: the session (S) and weekly (W) share used.
// Claude's numbers come from the status-line feed Claude Code writes as it runs
// (~/.cache/herdr-usage/claude-status.json, kept by ~/.claude/statusline-usage.sh). Kimi's come from
// the Kimi Code login: the refresh button trades the stored refresh token for a new login (the CLI's
// own refresh grant), writes it back in the CLI's format, then reads the usage. Kimi is never
// refreshed on its own. A window that is not reported shows no figure.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, home, readTextFile, writeTextFile, exec, nextCommand } from "herdr";

const REFRESH = 30000; // Claude's reading is a local file, so half a minute costs nothing
const PAD = 12; // the block's horizontal padding
const STALE = 60 * 60 * 1000; // a reading older than this shows dimmed
const KIMI_CLIENT = "17e5f671-d194-4dfb-9706-5516cb48c098"; // the Kimi Code CLI's public OAuth client
const KIMI_OAUTH = "https://auth.kimi.ai";
const KIMI_USAGE = "https://api.kimi.ai/coding/v1/usages";
const SAVED = "kimi.reading.v1"; // the last Kimi reading, kept for the next start
const LOGO = { claude: "mods/usage/icons/claude.svg", kimi: "mods/usage/icons/kimi.svg" };
const REFRESH_ICON = "mods/usage/icons/refresh.svg";

const stop = (_e, cx) => cx.stop_propagation();

// Reset times come as epoch seconds or milliseconds; both become milliseconds.
const epochMs = (v) => (v == null ? null : Number(v) > 1e12 ? Number(v) : Number(v) * 1000);

// "Session resets in 3h 12m", for the hover over a figure.
const resetLine = (name, at) => {
  if (!Number.isFinite(at)) return `${name} reset time isn't reported`;
  const mins = Math.round((at - Date.now()) / 60000);
  if (mins <= 0) return `${name} resets now`;
  const h = Math.floor(mins / 60), d = Math.floor(h / 24);
  const left = d >= 1 ? `${d}d ${h % 24}h` : h >= 1 ? `${h}h ${mins % 60}m` : `${mins}m`;
  return `${name} resets in ${left}`;
};

// Claude: the status-line feed. Null when there is no feed or it carries no limits.
async function claudeReading() {
  const path = `${home()}/.cache/herdr-usage/claude-status.json`;
  const text = await readTextFile(path);
  const limits = text ? JSON.parse(text).rate_limits : null;
  if (!limits) return null;
  // The file's age, from stat (macOS and GNU forms).
  const stat = await exec("sh", ["-c", 'stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"', "stat", path]);
  const limit = (w) => (w ? { used: Number(w.used_percentage), resetsAt: epochMs(w.resets_at) } : null);
  return { session: limit(limits.five_hour), weekly: limit(limits.seven_day), at: Number(stat.stdout.trim()) * 1000 || null };
}

// Kimi: refresh the CLI's login, write it back, then read the usage. Throws with a reason:
// "no-login" (never signed in), "sign-in" (the refresh was refused), or nothing (anything else).
const fail = (reason, message) => Object.assign(new Error(message), { reason });
async function kimiReading(cx) {
  const found = await exec("sh", ["-c", 'ls -t "$HOME"/.kimi-code/credentials/kimi-code-env-*.json 2>/dev/null | head -1']);
  const path = found.stdout.trim();
  const before = path ? await readTextFile(path) : null;
  if (!before) throw fail("no-login", "no kimi-code login on this computer");
  const login = JSON.parse(before);
  const timeout = (p) => Promise.race([p, cx.sleep(10000).then(() => { throw new Error("timed out"); })]);

  const res = await timeout(fetch(`${KIMI_OAUTH}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${KIMI_CLIENT}&grant_type=refresh_token&refresh_token=${encodeURIComponent(login.refresh_token)}`,
  }));
  if ([400, 401, 403].includes(res.status)) throw fail("sign-in", "the kimi-code login was refused");
  const data = res.ok ? JSON.parse(await res.text()) : {};
  if (!res.ok || typeof data.access_token !== "string") throw new Error(`token refresh failed: ${res.status}`);

  const expiresIn = Number(data.expires_in) || 900;
  const next = {
    ...login,
    access_token: data.access_token,
    refresh_token: data.refresh_token || login.refresh_token,
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    scope: data.scope ?? login.scope,
    token_type: data.token_type ?? login.token_type,
  };
  // Written only if the CLI has not changed the file since it was read; the mode stays owner-only.
  await writeTextFile(path, `${JSON.stringify(next, null, 2)}\n`, before);
  await exec("chmod", ["600", path]);

  const usage = await timeout(fetch(KIMI_USAGE, { headers: { Authorization: `Bearer ${next.access_token}` } }));
  if (!usage.ok) throw new Error(`usage failed: ${usage.status}`);
  const usages = JSON.parse(await usage.text()).usages;
  // used_ratio is a fraction of the window's allowance. A window without one is not reported.
  const limit = (w) => {
    const ratio = Number(w?.used_ratio);
    if (!w || !Number.isFinite(ratio)) return null;
    const ends = Date.parse(w.reset_time);
    return { used: ratio * 100, resetsAt: Number.isFinite(ends) ? ends : null };
  };
  return { session: limit(usages?.limit_5h), weekly: limit(usages?.limit_7d), at: Date.now() };
}

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED) || "null"); } catch (_e) { return null; }
}
function remember(reading) {
  try { localStorage.setItem(SAVED, JSON.stringify(reading)); } catch (_e) { /* kept for this run only */ }
}

export default class Usage extends View {
  init(_props, cx) {
    this.claude = null; this.claudeError = null; this.claudeLoaded = false;
    this.kimi = loadSaved(); this.kimiError = null; this.kimiBusy = false;
    cx.timer.every(REFRESH, (cx) => this.refreshClaude(cx));
    this.refreshClaude(cx);
    // The mod's command: "usage.refresh-kimi" (herdr-app do usage.refresh-kimi) does what the button does.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh-kimi" || c === "usage.refresh-kimi") this.refreshKimi(cx);
        cx.notify();
      }
    });
  }

  refreshClaude(cx) {
    cx.spawn(async (cx) => {
      try {
        this.claude = await claudeReading();
        this.claudeError = null;
      } catch (e) {
        this.claude = null;
        this.claudeError = String(e?.message ?? e);
        console.log(`usage claude: ${this.claudeError}`);
      }
      this.claudeLoaded = true;
      cx.notify();
    });
  }

  refreshKimi(cx) {
    if (this.kimiBusy) return;
    this.kimiBusy = true; this.kimiError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.kimi = await kimiReading(cx);
        remember(this.kimi);
      } catch (e) {
        this.kimiError = e.reason === "sign-in" ? "sign in again" : e.reason === "no-login" ? "not signed in" : "unavailable";
        console.log(`usage kimi: ${e?.message ?? e}`);
      } finally {
        this.kimiBusy = false;
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    const busy = this.kimiBusy;
    // What a provider's line says in place of, or next to, its figures. Null when there is nothing to say.
    const claudeNote = this.claudeError ? "unavailable" : !this.claudeLoaded ? "checking…" : !this.claude ? "not connected" : null;
    const kimiNote = busy ? "refreshing…" : this.kimiError ? this.kimiError : !this.kimi ? "not connected" : null;
    const icon = svg(REFRESH_ICON).size(13).flex_none().text_color(busy ? t.muted : t.foreground);
    const button = div().id("usage-kimi-refresh").size(20).flex_none().flex().items_center().justify_center().rounded(4)
      .when(!busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => this.refreshKimi(cx)))
      .child(busy ? icon.spin(900) : icon);
    return v_flex().id("usage").size_full().min_h(0).px(PAD).py(10).gap(8).border_t(1).border_color(t.border)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child("Usage"))
      .child(this.row(t, { id: "claude", reading: this.claude, note: claudeNote }))
      .child(this.row(t, { id: "kimi", reading: this.kimi, note: kimiNote, button }));
  }

  // One provider on one line: logo, S and W percentages, a note, and an optional button at the right.
  row(t, c) {
    const stale = Boolean(c.reading?.at) && Date.now() - c.reading.at > STALE;
    const figure = (label, name, w) => {
      if (!w || !Number.isFinite(w.used)) return null; // not reported: no figure
      const used = Math.max(0, Math.min(100, Math.round(w.used)));
      // Yellow from 70% used, red from 90%; a reading that's gone stale stays muted.
      const color = stale ? t.muted : used >= 90 ? t.ansi1 : used >= 70 ? t.ansi3 : t.foreground;
      return div().flex_none().text_size(12).text_color(color).tooltip(resetLine(name, w.resetsAt)).child(`${label}: ${used}%`);
    };
    const figures = c.reading ? [figure("S", "Session", c.reading.session), figure("W", "Weekly", c.reading.weekly)].filter(Boolean) : [];
    return h_flex().id(`usage-${c.id}`).h(20).gap(10).items_center().min_w(0)
      .child(image(LOGO[c.id]).w(14).h(14).flex_none())
      .children(figures)
      .when(Boolean(c.note), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(c.note)))
      .child(div().flex_1())
      .when(Boolean(c.button), (el) => el.child(c.button));
  }
}
