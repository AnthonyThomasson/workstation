// Herdr's side of the cheap light: `hc machine ls --json`, which is answered by herdr-core on this computer and spawns nothing on any
// machine. It is asked again only from a page's own render or refresh (ensure): when herdr's live machine names (the reactive
// machines()) no longer match the list, or the list is 20 seconds old, or the person pressed Refresh. There is no timer here. The one
// reason this is all the light asks: the earlier poller (exec with { on } on an interval) made herdr-core spike the CPU.
import { machines as liveMachines } from "herdr";
import { machinesChanged } from "../devices/index.js";
import { later } from "../widgets/index.js";
import { listMachines } from "./device-env.js";

const FRESH_MS = 20000; // a list younger than this is not asked for again just because a page redrew
const MIN_GAP_MS = 2000; // and a changed set of names is not chased faster than this, so a name machines() and machine ls never agree on can't loop

export class Machines {
  constructor() { this.list = null; this.at = 0; this.loading = false; } // list: null until the first answer

  stale(now = Date.now()) { return !this.loading && now - this.at > FRESH_MS; }

  // Whether the list should be asked again now: never while a load is running; otherwise when it is stale, or herdr's machines differ from it.
  due(now = Date.now(), live = liveMachines()) {
    if (this.loading) return false;
    return this.stale(now) || (now - this.at > MIN_GAP_MS && machinesChanged(live, this.list));
  }

  // Called from a render or a refresh: asks hc machine ls (after the render, since cx.notify can't run during one) when it is due, or fresh.
  ensure(cx, { fresh = false } = {}) {
    if (fresh ? !this.loading : this.due()) later(cx, (cx2) => this.load(cx2));
  }

  // Asks `hc machine ls --json`. A call that fails or answers something else keeps the last list (empty if there was none).
  async load(cx) {
    if (this.loading) return;
    this.loading = true;
    this.at = Date.now();
    try {
      this.list = await listMachines();
    } catch {
      if (!this.list) this.list = [];
    } finally {
      this.loading = false;
      cx?.notify();
    }
  }
}
