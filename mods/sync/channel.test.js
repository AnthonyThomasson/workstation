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
  ch.request({ op: "pull", key: "" });
  const r = next();
  assert.equal(r.op, "pull");
  assert.equal(next(), null);
  t.now++; ch.request({ op: "push", key: "" });
  assert.equal(next().op, "push");
});

test("one lock per machine; a stale lock is dropped", () => {
  const { ch, t } = make();
  assert.equal(ch.claim(null, "Pulling…"), true);
  assert.equal(ch.claim(null, "Pushing…"), false);
  assert.equal(ch.claim("vps", "Pushing…"), true);
  assert.equal(ch.busyAt(null), true);
  ch.release(null);
  assert.equal(ch.busyAt(null), false);
  t.now += 61 * 1000;
  assert.equal(ch.busyAt("vps"), false);
});
