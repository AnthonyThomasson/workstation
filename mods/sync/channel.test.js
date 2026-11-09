import test from "node:test";
import assert from "node:assert/strict";
import { createChannel } from "./channel.js";

const make = (t = { now: 1000 }) => {
  const m = new Map();
  return { m, t, ch: createChannel({ get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), now: () => t.now }) };
};

test("a request reaches the listener once", () => {
  const { ch, t } = make();
  const next = ch.listen();
  assert.equal(next(), null);
  ch.request({ op: "force" });
  const r = next();
  assert.equal(r.op, "force");
  assert.equal(next(), null);
  t.now++; ch.request({ op: "pick", dir: "/r-wt" });
  const p = next();
  assert.equal(p.op, "pick");
  assert.equal(p.dir, "/r-wt");
});

test("a request made before listening is not replayed", () => {
  const { ch, t } = make();
  ch.request({ op: "force" });
  t.now++;
  const next = ch.listen();
  assert.equal(next(), null);
});
