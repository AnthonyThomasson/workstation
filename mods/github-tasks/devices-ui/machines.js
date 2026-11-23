// Herdr's side of the cheap light: `hc machine ls --json`, which is answered by herdr-core on this computer and spawns nothing on any
// machine. It is asked again only from a page's own render or refresh (ensure): when herdr's live machine names (the reactive
// machines()) no longer match the list, or the list is 20 seconds old, or the person pressed Refresh. There is no timer here. The one
// reason this is all the light asks: the earlier poller (exec with { on } on an interval) made herdr-core spike the CPU.
import { machines as liveMachines } from "herdr";
import { machinesDue, namesKey } from "../devices/index.js";
import { later } from "../widgets/index.js";
import { listMachines } from "./device-env.js";

const FRESH_MS = 20000; // a list younger than this is not asked for again just because a page redrew
const MIN_GAP_MS = 2000; // and a changed set of names is not chased faster than this, and only once per distinct set (machinesDue)

export class Machines {
  constructor() { this.list = null; this.at = 0; this.loading = false; this.askedFor = null; } // list: null until the first answer

  // Whether the list should be asked again now (devices/card-model.js machinesDue: stale, or a new set of live names once).
  due(now = Date.now(), live = liveMachines()) {
    return machinesDue({ now, at: this.at, loading: this.loading, live, list: this.list, askedFor: this.askedFor, freshMs: FRESH_MS, minGapMs: MIN_GAP_MS });
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
    this.askedFor = namesKey(liveMachines()); // the live names this ask is for: a change of them is chased once, not every 2s
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
