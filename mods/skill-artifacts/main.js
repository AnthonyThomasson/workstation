// The HTML and Markdown reports agents write, in one list: the project's Claude Code scratchpads, the top level of
// $TMPDIR, /tmp, and the project's Herdr workflow runs. Newest first, last seven days.
// Roles (props.role): the panel (default); "toggle", the tab-bar button that opens or closes the layout's shared
// side panel on this panel; dialogs: "reader" (a Markdown report) and "delete" (the confirmation).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { exec, run, spaces, agents, focused, shared, setShared, theme, settings, layout, openOverlay, closeOverlay, readTextFile, props as blockProps } from "herdr";
import { TABS, scan, scanFolders, filterRows, age, size } from "./model.js";

// The side panel is the layout's shared "panel" column, whose "panel-body" stack holds Files, Changes and this
// panel (child "skill-artifacts"). It is open only while the column is shown on it.
const PANEL = "panel", STACK = "panel-body", SHOWN = "skill-artifacts";
const TAB_KEY = "skill-artifacts.tab.v1"; // the selected tab
const REFRESH_KEY = "skill-artifacts.refresh.v1"; // a dialog bumps it after a delete, so the panel rescans
const POLL = 20000, NOTICE_MS = 4000;
const PATHS = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH';

const find = (node, id) => {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
};
const shownHere = () => {
  const root = layout(), panel = find(root, PANEL), body = find(root, STACK);
  return Boolean(panel && !panel.hidden && body?.active === SHOWN);
};
const showPanel = () => { run("layout.select", { stack: STACK, child: SHOWN }); run("layout.show", { id: PANEL }); };

const activeSpace = () => spaces().find((s) => s.active) ?? null;
const later = (cx, fn) => cx.spawn(async (cx) => { await cx.sleep(0); return fn(cx); });
const stop = (_e, cx) => cx.stop_propagation();
const lastLine = (s) => String(s ?? "").trim().split("\n").pop() ?? "";

function S() {
  const b = Number(settings().ui_font_size) || 13;
  return { dialog: b + 2, title: b + 1, body: b + 0.5, button: b - 0.5, secondary: b - 0.5, label: b - 1 };
}
const icon = (name, size, color) => svg(`mods/skill-artifacts/icons/${name}.svg`).size(size).flex_none().text_color(color);

function secondary(id, label, t, onClick, opts = {}) {
  const color = opts.color ?? t.foreground;
  return h_flex().id(id).h(opts.h ?? 26).px(opts.px ?? 10).gap(6).flex_none().items_center().rounded(6)
    .border_1().border_color(t.border).text_size(S().label).text_color(color).cursor_pointer().hover((s) => s.bg(t.hover))
    .on_mouse_down("left", stop).on_click(onClick)
    .when(Boolean(opts.icon), (el) => el.child(icon(opts.icon, 13, color))).child(label);
}

function segmented(id, options, value, t, onPick) {
  return h_flex().id(id).w_full().p(2).gap(2).rounded(8).bg(t.chrome).border_1().border_color(t.border).children(options.map(([key, label, count]) => {
    const on = key === value;
    return h_flex().id(`${id}-${key}`).flex_1().min_w(0).h(26).px(2).gap(4).justify_center().items_center().rounded(6)
      .bg(on ? t.raised : t.chrome).text_size(S().label).text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_semibold())
      .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click((_e, cx) => onPick(key, cx))
      .child(div().truncate().child(label))
      .when(count != null, (el) => el.child(div().flex_none().text_color(t.muted).child(String(count))));
  }));
}

// ---- The tab-bar button ----

function toggle() {
  const t = theme(), on = shownHere();
  return h_flex().size_full().pr(8).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
    .child(h_flex().id("toggle-skill-artifacts").tooltip("Skill Artifacts").h(30).w(34).justify_center().flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => {
        if (on) run("layout.hide", { id: PANEL });
        else showPanel();
      })
      .child(svg("mods/skill-artifacts/icons/skill-artifacts.svg").size(16)));
}

// A dialog's frame: title, Esc hint, body, buttons.
function dialogFrame(t, id, handle, title, body, buttons, onClose) {
  return v_flex().id(id).track_focus(handle)
    .on_key_down((e, cx) => { if (e.key === "escape") { onClose(); cx.stop_propagation(); } })
    .size_full().min_h(0).p(18).gap(14).bg(t.popover).text_size(S().body).text_color(t.foreground)
    .child(h_flex().flex_none().items_center().gap(8)
      .child(div().flex_1().min_w(0).truncate().text_size(S().dialog).font_semibold().child(title))
      .child(div().text_size(S().label).text_color(t.muted).child("Esc")))
    .child(v_flex().flex_1().min_h(0).gap(12).children(body.filter(Boolean)))
    .child(h_flex().flex_none().justify_end().items_center().gap(8).children(buttons.filter(Boolean)));
}

const dialogButton = (id, label, t, onClick, kind = "secondary") => {
  const solid = kind === "primary", danger = kind === "danger";
  return h_flex().id(id).h(32).px(14).flex_none().items_center().rounded(8).border_1()
    .border_color(solid ? t.solid : danger ? t.ansi1 : t.input).bg(solid ? t.solid : danger ? t.ansi1 : t.raised)
    .text_size(S().button).text_color(solid ? t.solid_foreground : danger ? t.background : t.foreground)
    .when(solid || danger, (el) => el.font_semibold())
    .cursor_pointer().hover((s) => s.opacity(0.88)).on_mouse_down("left", stop).on_click(onClick).child(label);
};
const note = (t, text, color) => div().flex_none().text_size(S().secondary).text_color(color ?? t.muted).child(text);

// One script run on the space's machine (a null machine is this computer).
const sh = (script, args, on) => exec("sh", ["-c", `${PATHS}\n${script}`, "skill-artifacts", ...args], on ? { on } : {})
  .catch((e) => ({ code: 127, stdout: "", stderr: String(e.message ?? e) }));

export default class SkillArtifacts extends View {
  init(_props, cx) {
    this.role = blockProps()?.role ?? "panel";
    if (this.role === "toggle") return;
    this.handle = cx.focus_handle();
    if (this.role !== "panel") { this.handle.focus(); return this.initDialog(cx); }

    this.data = {}; // tab -> { rows, error }
    this.query = ""; this.open = null; this.ctx = null; this.ctxKey = null; this.token = 0; this.loading = false; this.pending = false;
    this.lastAgent = null; this.notice = null; this.seenRefresh = shared(REFRESH_KEY) ?? 0; this.wasHidden = true;
    this.filter = InputState.new({ placeholder: "Filter by name or where" });
    this.filter.on("change", (_e, cx) => { this.query = this.filter.value(); cx.notify(); });
    // No scans while the panel is hidden; showing it again rescans (see render). $TMPDIR is only ever read at its top level.
    cx.timer.every(POLL, (cx) => { if (shownHere()) this.refresh(cx); });
    cx.timer.every(1000, (cx) => { if (this.notice && !this.fresh()) { this.notice = null; cx.notify(); } });
  }

  fresh() { return this.notice && Date.now() - this.notice.at < NOTICE_MS ? this.notice : null; }
  say(kind, text) { this.notice = { kind, text, at: Date.now() }; }

  // The shown space's machine, and the folders reports are matched to: the focused terminal's folder wins over the space's.
  context() {
    const space = activeSpace();
    if (!space) return null;
    const f = focused();
    const cwd = f?.space === space.id && f?.cwd ? f.cwd : null;
    return { on: space.machine ?? null, folders: scanFolders(cwd, space.folder), space: space.id };
  }

  refresh(cx) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.loading) { this.pending = true; return; } // rescan when this scan ends
    this.loading = true; this.pending = false;
    const token = this.token;
    const io = { sh: (script, args, on) => sh(script, args, on), // only the top of a report is needed for its <title>
      read: async (path, on) => { const r = await sh('head -c 8192 -- "$1"', [path], on); return r.code === 0 ? r.stdout : null; } };
    cx.spawn(async (cx) => {
      try {
        await Promise.all(TABS.map(async ([tab]) => {
          const res = await scan(io, tab, { on: ctx.on, folders: ctx.folders }).catch((e) => ({ rows: [], error: String(e?.message ?? e) }));
          if (token !== this.token) return;
          this.data[tab] = res; cx.notify();
        }));
      } finally {
        if (token === this.token) { this.loading = false; if (this.pending) this.refresh(cx); }
      }
    });
  }

  receiver() {
    const a = agents().find((x) => x.focused);
    if (a) { this.lastAgent = a.address; return a; }
    return agents().find((x) => x.address === this.lastAgent) ?? null;
  }

  // ---- Actions on a row ----

  openFile(row, cx) {
    const on = this.ctx?.on ?? null;
    if (row.kind === "md") {
      cx.spawn(async () => {
        const text = await readTextFile(row.path, on ? { on } : {}).catch(() => null);
        openOverlay({ mod: "skill-artifacts", kind: "dialog", width: 760, height: 620,
          props: { role: "reader", title: row.base ?? row.name, path: row.path, on, text,
            error: `Could not read ${row.path} (a file over 1 MiB is only opened externally)` } });
      });
      return;
    }
    this.local(cx, on, "Open an HTML report on this computer", async () => exec("open", [row.path]));
  }

  // Runs fn for a file on this computer; a remote space's files can't be opened or revealed here.
  local(cx, on, what, fn) {
    if (on) { this.say("warn", `${what}: this space is on ${on}`); cx.notify(); return; }
    cx.spawn(async (cx) => {
      const r = await fn().catch((e) => ({ code: 1, stderr: String(e.message ?? e) }));
      if (r.code !== 0) this.say("error", lastLine(r.stderr) || "That didn't work");
      cx.notify();
    });
  }

  reveal(row, cx) { this.local(cx, this.ctx?.on ?? null, "Reveal in Finder", () => exec("open", ["-R", row.path])); }

  copyPath(row, cx) {
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", row.path]).catch((e) => ({ code: 1, stderr: String(e.message ?? e) }));
      this.say(r.code === 0 ? "done" : "error", r.code === 0 ? "Path copied" : lastLine(r.stderr) || "Could not copy");
      cx.notify();
    });
  }

  // Pastes the path into the agent's terminal and leaves it for the person to send (no Enter).
  sendToAgent(row, cx) {
    const agent = this.receiver();
    const name = agent?.program?.name ?? "the agent";
    if (!agent) { this.say("warn", "No agent to send to. Focus an agent first."); cx.notify(); return; }
    if (agent.status === "blocked") { this.say("warn", `${name} is waiting on a question, so sending is off until it moves on.`); cx.notify(); return; }
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", row.path]).catch((e) => ({ code: 1, stderr: String(e.message ?? e) }));
      if (r.code !== 0) { this.say("error", lastLine(r.stderr) || "Could not copy the path"); cx.notify(); return; }
      run("agent.focus", { terminal: agent.address });
      await cx.sleep(250);
      run("terminal.paste", {});
      this.say("done", `Pasted the path into ${name}. Check it, then press Enter.`);
      cx.notify();
    });
  }

  askDelete(row) {
    openOverlay({ mod: "skill-artifacts", kind: "dialog", width: 460, height: 230,
      props: { role: "delete", path: row.path, name: row.name, on: this.ctx?.on ?? null } });
  }

  // ---- Panel ----

  render(cx) {
    if (this.role === "toggle") return toggle();
    if (this.role !== "panel") return this.renderDialog(cx);
    const t = theme();

    // Follow the shown space; a new place starts over.
    const shownNow = shownHere();
    const ctx = this.context(), key = ctx ? `${ctx.on}|${ctx.folders.join("|")}` : null;
    if (key !== this.ctxKey) {
      this.ctxKey = key; this.ctx = ctx; this.token++; this.loading = false; this.pending = false; this.data = {}; this.open = null;
      if (ctx && shownNow) later(cx, (cx) => this.refresh(cx)); // a hidden panel never scans; showing it does
    }
    const bumped = shared(REFRESH_KEY) ?? 0;
    if (bumped !== this.seenRefresh) { this.seenRefresh = bumped; if (shownNow) later(cx, (cx) => this.refresh(cx)); }
    this.receiver();
    if (shownNow && this.wasHidden && ctx) later(cx, (cx) => this.refresh(cx));
    this.wasHidden = !shownNow;

    const tabKey = TABS.some(([k]) => k === shared(TAB_KEY)) ? shared(TAB_KEY) : TABS[0][0];
    const node = find(layout(), PANEL);
    const options = TABS.map(([k, label]) => [k, label, this.data[k] ? this.data[k].rows.length : null]);
    const body = !ctx ? v_flex().flex_1().p(16).child(note(t, "Open a space to see its reports.")) : this.renderList(t, tabKey);
    const n = this.fresh();
    return v_flex().id("skill-artifacts").track_focus(this.handle).size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(S().body)
      .child(h_flex().h(42).flex_none().pl(14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(S().title).font_semibold().child("Skill Artifacts"))
        .when(Boolean(node), (el) => el.child(h_flex().id("close").size(24).justify_center().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_mouse_down("left", stop).on_click(() => run("layout.hide", { id: PANEL })).child(icon("close", 14, t.muted)))))
      .child(v_flex().flex_none().px(14).py(10).gap(8).border_b(1).border_color(t.border)
        .child(segmented("tab", options, tabKey, t, (k, cx) => { setShared(TAB_KEY, k); this.open = null; cx.notify(); }))
        .child(h_flex().h(30).px(10).gap(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.chrome)
          .child(icon("search", 14, t.muted))
          .child(Input.new(this.filter).flex_1().min_w(0).h_full().text_size(S().secondary).text_color(t.foreground))))
      .child(body)
      .when(Boolean(n), (el) => {
        const color = { done: t.ansi2, warn: t.blocked, error: t.ansi1 }[n.kind] ?? t.muted;
        return el.child(h_flex().id("notice").min_h(34).flex_none().px(14).py(6).gap(7).items_center().border_t(1).border_color(t.border).text_size(S().secondary).text_color(color)
          .child(icon(n.kind === "done" ? "check" : "alert", 13, color)).child(div().flex_1().min_w(0).child(n.text)));
      });
  }

  renderList(t, tabKey) {
    const d = this.data[tabKey];
    if (!d) return v_flex().flex_1().p(16).gap(10).children([0, 1, 2, 3].map((i) => div().h(40).rounded(8).bg(t.chrome).opacity(1 - i * 0.2)));
    const rows = filterRows(d.rows, this.query), now = Date.now();
    let list;
    if (d.error && !d.rows.length) {
      list = v_flex().p(16).gap(8).child(h_flex().gap(7).items_center().text_color(t.ansi1).child(icon("alert", 14, t.ansi1)).child("Could not read this place"))
        .child(note(t, d.error));
    } else if (!rows.length) {
      list = div().p(16).child(note(t, this.query ? "Nothing matches the filter." : EMPTY[tabKey]));
    } else {
      list = v_flex().pt(4).pb(16).children(rows.map((r) => this.row(t, r, now)));
    }
    return div().id("list").flex_1().min_h(0).overflow_y_scrollbar().child(list);
  }

  row(t, r, now) {
    const open = this.open === r.path;
    const head = h_flex().id(`row-${r.path}`).min_h(48).px(10).py(6).gap(10).items_center().rounded(8).cursor_pointer()
      .when(!open, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", stop).on_click((_e, cx) => { this.open = open ? null : r.path; cx.notify(); })
      .child(div().flex_none().w(34).text_size(S().label).font_semibold().text_color(r.kind === "html" ? t.accent : t.muted).child(r.kind === "html" ? "HTML" : "MD"))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(S().body).font_medium().child(r.name))
        .when(Boolean(r.subtitle), (el) => el.child(div().truncate().text_size(S().secondary).text_color(t.foreground).child(r.subtitle)))
        .child(div().truncate().text_size(S().secondary).text_color(t.muted).child(r.context)))
      .child(div().flex_none().text_size(S().label).text_color(t.muted).child(age(r.mtime, now)))
      .child(icon(open ? "chevron-down" : "chevron-right", 14, t.muted));
    if (!open) return div().mx(8).mb(3).child(head);
    const remote = Boolean(this.ctx?.on);
    return v_flex().mx(8).mb(3).rounded(8).bg(t.raised).child(head)
      .child(v_flex().px(12).pb(10).gap(8)
        .child(div().text_size(S().label).text_color(t.muted).child(`${r.path} · ${size(r.size)}`))
        .child(h_flex().gap(6).flex_wrap()
          .child(secondary("act-open", "Open", t, (_e, cx) => this.openFile(r, cx), { icon: "open" }))
          .when(!remote, (el) => el.child(secondary("act-reveal", "Reveal", t, (_e, cx) => this.reveal(r, cx), { icon: "folder" })))
          .child(secondary("act-copy", "Copy path", t, (_e, cx) => this.copyPath(r, cx), { icon: "copy" }))
          .child(secondary("act-send", "Send to agent", t, (_e, cx) => this.sendToAgent(r, cx), { icon: "send" }))
          .child(secondary("act-delete", "Delete", t, () => this.askDelete(r), { icon: "trash", color: t.ansi1 }))));
  }

  // ---- Dialogs ----

  initDialog(_cx) { this.p = blockProps() ?? {}; this.busy = false; this.error = null; }

  renderDialog(cx) {
    const t = theme(), p = this.p ?? {};
    const close = () => closeOverlay(blockProps()?.overlay);
    if (p.role === "reader") {
      const body = p.text != null ? TextView.markdown("report-md", p.text).selectable(true) : note(t, p.error ?? "Could not read this file.", t.ansi1);
      const external = () => { if (!p.on) exec("open", [p.path]).catch(() => null); };
      return dialogFrame(t, "reader", this.handle, p.title ?? "Report",
        [div().id("report-body").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(12).child(body)],
        [!p.on && dialogButton("external", "Open externally", t, external), dialogButton("close", "Close", t, close, "primary")], close);
    }
    if (p.role === "delete") {
      const go = (_e, cx) => {
        if (this.busy) return;
        this.busy = true; cx.notify();
        cx.spawn(async (cx) => {
          const r = await exec("rm", ["--", p.path], p.on ? { on: p.on } : {}).catch((e) => ({ code: 1, stderr: String(e.message ?? e) }));
          if (r.code === 0) { setShared(REFRESH_KEY, Date.now()); close(); return; }
          this.busy = false; this.error = lastLine(r.stderr) || "Could not delete the file"; cx.notify();
        });
      };
      return dialogFrame(t, "delete", this.handle, `Delete “${p.name}”?`,
        [note(t, "Removes this one file for good. It does not go to the Trash.", t.foreground), note(t, p.path), this.error && note(t, this.error, t.ansi1)],
        [dialogButton("cancel", "Cancel", t, close), dialogButton("go", this.busy ? "Deleting…" : "Delete", t, go, "danger")], close);
    }
    return div();
  }
}

const EMPTY = {
  scratch: "No reports in this project's scratchpads in the last 7 days.",
  tmpdir: "No reports at the top of $TMPDIR in the last 7 days.",
  tmp: "No reports in /tmp in the last 7 days.",
  runs: "No reports in this project's workflow runs in the last 7 days.",
};
