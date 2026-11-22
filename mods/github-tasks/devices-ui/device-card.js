// The Test device card at the top of Task settings: pick a Herdr machine to bind (or Add a machine), then its name, OS and light, the
// repo's folder on it, Check, Unbind, and what is failing with one line of fix each. What it shows is devices/card-model.js's; the
// light is the cheap one (hc machine ls only), and a deep check runs only from the buttons here. No timer: the machine list is
// asked again when the page is built, or drawn after a while (Machines.stale), and after each button.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run } from "herdr";
import { cardView, tooltipOf, withRepoRoot } from "../devices/index.js";
import { Auth } from "../github-ui/index.js";
import { S, stop, note, action } from "../widgets/index.js";
import { Machines } from "./machines.js";
import { bindDevice, checkDevice, readBinding, saveBinding, deviceExec } from "./device-env.js";
import { shOn } from "../runs/index.js";

export class TestDeviceCard {
  // props: { repo, where } as Task settings has them ("" repo until one is known).
  constructor(props, cx) {
    this.repo = props?.repo ?? "";
    this.cwd = props?.where?.cwd ?? null;
    this.machines = new Machines();
    this.busy = null; // "binding" | "checking" while a probe or deep check is running
    this.error = null; // why the last bind or check could not run
    this.token = 0; // changes on unbind and bind, so an answer that arrives late is dropped
    this.auth = new Auth((on, script, args, opts) => shOn({ exec: deviceExec }, on, script, args, opts));
    const saved = this.repo && readBinding()?.repoRoots?.[this.repo];
    this.folder = InputState.new({ value: saved || "", placeholder: "Folder of the repo's main checkout" });
    this.folder.on("change", (_e, cx2) => { this.saveFolder(this.folder.value().trim()); cx2.notify(); });
    this.machines.load(cx);
  }

  saveFolder(folder) {
    const binding = readBinding();
    if (!binding || !this.repo || (binding.repoRoots[this.repo] ?? "") === folder) return;
    saveBinding(withRepoRoot(binding, this.repo, folder));
  }

  // The folder box follows what is saved (a prefill from a space of the machine lands there).
  syncFolder() {
    const saved = (this.repo && readBinding()?.repoRoots?.[this.repo]) || "";
    if (saved && this.folder.value().trim() !== saved) this.folder.set_value(saved);
  }

  async guard(cx, kind, work) {
    const token = ++this.token;
    this.busy = kind;
    this.error = null;
    cx.notify();
    try {
      await work();
    } catch (e) {
      if (token === this.token) this.error = String(e?.message ?? e).split("\n")[0];
    } finally {
      if (token === this.token) { this.busy = null; this.syncFolder(); await this.machines.load(cx); }
      cx.notify();
    }
  }

  bind(machine, cx) {
    if (this.busy) return;
    this.guard(cx, "binding", () => bindDevice(machine, { repo: this.repo, cwd: this.cwd }));
  }

  check(cx) {
    if (this.busy || !readBinding()) return;
    this.guard(cx, "checking", () => checkDevice({ repo: this.repo, cwd: this.cwd }));
  }

  // Clears the key. Nothing on the device is touched, and a check still running for it is dropped.
  unbind(cx) {
    this.token++;
    this.busy = null;
    this.error = null;
    saveBinding(null);
    this.folder.set_value("");
    cx.notify();
  }

  // The existing machine-add mod. run() returns at once, not when it closes: the list is asked again by render, when herdr's own
  // machines() shows a machine that hc machine ls hasn't listed (Machines.ensure).
  addMachine() { run("mod.open", { name: "machine-add" }); }

  render(t, cx) {
    this.machines.ensure(cx); // the list is asked again on a render when it is due (a machine appeared or went, or it is old), never on a timer
    const v = cardView({ binding: readBinding(), machines: this.machines.list, repo: this.repo });
    return v_flex().id("settings-test-device").flex_none().gap(10).p(14).rounded(10).border_1().border_color(t.border).bg(t.chrome)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(S().title).font_semibold().child("Test device"))
        .when(v.bound, (el) => el.child(div().id("test-device-light").size(10).flex_none().rounded_full().bg(v.color ? t[v.color] : t.muted)
          .tooltip(v.loading ? "Looking for the machine…" : tooltipOf(v.machine, v.level, v.failing)))))
      .child(v.bound ? this.bound(t, v, cx) : this.unbound(t, v, cx))
      .when(Boolean(this.error), (el) => el.child(note(t, this.error, t.ansi1)));
  }

  unbound(t, v, cx) {
    const chip = (name) => h_flex().id(`test-device-pick-${name}`).h(28).px(10).items_center().rounded(6).cursor_pointer()
      .border_1().border_color(t.border).bg(t.background).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .when(Boolean(this.busy), (el) => el.opacity(0.4))
      .on_mouse_down("left", stop).on_click((_e, cx2) => this.bind(name, cx2)).child(name);
    return v_flex().gap(8)
      .child(note(t, "A Herdr machine to build and test tickets on."))
      .when(Boolean(this.busy), (el) => el.child(note(t, "Binding: looking at the machine, then checking it…")))
      .when(v.loading && !this.busy, (el) => el.child(note(t, "Looking for Herdr machines…")))
      .when(v.noneConnected, (el) => el.child(note(t, "No Herdr machine is connected. Connect one, or add another.")))
      .when(!v.loading && v.pick.length > 0, (el) => el.child(h_flex().flex_wrap().gap(4).children(v.pick.map(chip))))
      .when(v.addMachine || v.noneConnected, (el) => el.child(v_flex().gap(8)
        .when(v.addMachine, (e) => e.child(note(t, "No Herdr machines yet.")))
        .child(h_flex().child(action("test-device-add-machine", "Add a machine", t, () => this.addMachine())))));
  }

  bound(t, v, cx) {
    const binding = readBinding();
    return v_flex().gap(10)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(v.title))
        .child(action("test-device-check", this.busy ? "Checking…" : "Check", t, (_e, cx2) => this.check(cx2), true, Boolean(this.busy)))
        .child(action("test-device-unbind", "Unbind", t, (_e, cx2) => this.unbind(cx2), true)))
      .child(v_flex().gap(4)
        .child(div().text_size(S().secondary).font_semibold().child(v.folderLabel))
        .when(v.canSetFolder, (el) => el.child(div().id("test-device-folder-field").h(34).flex_none().px(10).flex().items_center().rounded(8).border_1().border_color(t.input).on_mouse_down("left", stop)
          .child(Input.new(this.folder).h_full().w_full().text_size(S().body).text_color(t.foreground))))
        .when(!v.canSetFolder, (el) => el.child(note(t, "Open a space in a GitHub repo to set its folder."))))
      .when(this.busy === "checking", (el) => el.child(note(t, `Checking ${binding.machine}…`)))
      .child(v_flex().gap(6).children(v.failing.map((c, i) => this.failure(t, c, i, binding.machine, cx))))
      .when(Boolean(v.checkedAgo), (el) => el.child(note(t, `Last checked ${v.checkedAgo}`)))
      .when(Boolean(this.auth.state), (el) => el.child(this.auth.render(t, () => { this.auth.state = null; cx.notify(); })));
  }

  // One failing check: its message, its one-line fix and, for gh's scope or sign-in, the existing device-flow sign-in on the machine.
  failure(t, c, i, machine, cx) {
    const dot = c.level === "red" ? t.ansi1 : t.ansi3;
    return v_flex().id(`test-device-check-${c.id}-${i}`).flex_none().gap(2)
      .child(h_flex().gap(6).items_start()
        .child(div().size(7).mt(5).flex_none().rounded_full().bg(dot))
        .child(div().flex_1().min_w(0).child(c.message)))
      .when(Boolean(c.fix), (el) => el.child(div().pl(13).child(note(t, c.fix))))
      .when(Boolean(c.signIn) && !this.auth.state, (el) => el.child(h_flex().pl(13).pt(2)
        .child(action(`test-device-sign-in-${c.id}`, c.signIn.label, t, (_e, cx2) => this.auth.start(cx2, c.signIn.args, machine, (cx3) => this.check(cx3))))));
  }
}
