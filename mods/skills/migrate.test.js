import test from "node:test";
import assert from "node:assert/strict";
import { migrateKeys, LEGACY } from "./migrate.js";

const make = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { m, get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
};

test("an empty new key takes the old value, and the old value is kept", () => {
  const { m, get, set } = make({ "old.a": ["x/y"] });
  migrateKeys(get, set, [["new.a", "old.a"]]);
  assert.deepEqual(m.get("new.a"), ["x/y"]);
  assert.deepEqual(m.get("old.a"), ["x/y"]);
});

test("a null new key counts as empty", () => {
  const { m, get, set } = make({ "new.a": null, "old.a": 1 });
  migrateKeys(get, set, [["new.a", "old.a"]]);
  assert.equal(m.get("new.a"), 1);
});

test("a false old value is a saved choice and is copied", () => {
  const { m, get, set } = make({ "old.a": false });
  migrateKeys(get, set, [["new.a", "old.a"]]);
  assert.equal(m.get("new.a"), false);
});

test("a set new key is never overwritten, even with false or []", () => {
  const { m, get, set } = make({ "new.a": false, "old.a": true, "new.b": [], "old.b": ["z"] });
  migrateKeys(get, set, [["new.a", "old.a"], ["new.b", "old.b"]]);
  assert.equal(m.get("new.a"), false);
  assert.deepEqual(m.get("new.b"), []);
});

test("nothing is written when the old key is empty too", () => {
  const writes = [];
  migrateKeys(() => undefined, (k, v) => writes.push([k, v]), [["new.a", "old.a"]]);
  assert.deepEqual(writes, []);
});

test("running twice writes once", () => {
  const writes = [];
  const { get, set } = make({ "old.a": 5 });
  const spy = (k, v) => { writes.push(k); set(k, v); };
  migrateKeys(get, spy, [["new.a", "old.a"]]);
  migrateKeys(get, spy, [["new.a", "old.a"]]);
  assert.deepEqual(writes, ["new.a"]);
});

test("the default pairs move the three saved choices to skills.*", () => {
  const { m, get, set } = make({
    "skillshare.recent.v1": ["a/b"], "skillshare.hideDisabled.v1": false, "skillshare.doctorIgnored.v1": ["g|n|m"],
  });
  migrateKeys(get, set);
  assert.deepEqual(m.get("skills.recent.v1"), ["a/b"]);
  assert.equal(m.get("skills.hideDisabled.v1"), false);
  assert.deepEqual(m.get("skills.doctorIgnored.v1"), ["g|n|m"]);
  assert.equal(LEGACY.length, 3);
});
