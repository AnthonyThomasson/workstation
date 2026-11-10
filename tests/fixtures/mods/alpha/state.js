import { shared, setShared } from "herdr";
import { GOOD, BAD, slotKey, badSlot } from "./reexport.js";
import * as K from "./keys.js";
const LOCAL = "alpha.local";
const OTHER = "beta.local";
const pick = (id) => (id ? "alpha.a" : "alpha.b");
let moving = "alpha.moving";
export function run(id, dyn) {
  shared(LOCAL);
  shared(OTHER);
  shared(GOOD);
  shared(BAD);
  shared(K.GOOD);
  shared(K.BAD);
  shared(slotKey(id));
  shared(badSlot(id));
  shared(pick(id));
  shared("workspace.panels");
  shared("workspace.other");
  shared(dyn);
  shared(`${dyn}.x`);
  shared("alpha." + dyn);
  setShared("beta.k", 1);
  shared(moving);
  shared();
}
