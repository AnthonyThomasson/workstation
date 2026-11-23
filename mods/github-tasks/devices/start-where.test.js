import test from "node:test";
import assert from "node:assert/strict";
import { startNote, startTip, startWhere, startsOnText } from "./start-where.js";
import { cheapHealth, healthOf, normalizeBinding } from "./test-device.js";

const REPO = "AnthonyThomasson/workstation";
const NOW = Date.parse("2026-11-22T12:00:00Z");
const binding = (extra = {}) => normalizeBinding({ machine: "desktop", os: "windows", home: "C:/Users/me", repoRoots: { [REPO]: "C:/src/workstation" }, startHere: { [REPO]: true }, ...extra });
const connected = [{ name: "desktop", state: "connected" }];
const here = { cwd: "/Users/me/work/workstation", on: undefined };
const light = (b, machines = connected) => cheapHealth(b, machines, NOW);
const green = () => binding({ health: healthOf([{ id: "git", level: "green", message: "ok" }], NOW) });

test("toggle on, a space on this computer, a green light: where is the repo folder on the machine", () => {
  const b = green();
  assert.deepEqual(startWhere({ binding: b, repo: REPO, where: here, light: light(b) }), { where: { cwd: "C:/src/workstation", on: "desktop" }, on: "desktop" });
});

test("a yellow light (not checked yet, or a yellow check) still starts on the machine", () => {
  const b = binding();
  assert.equal(light(b).level, "yellow");
  assert.equal(startWhere({ binding: b, repo: REPO, where: here, light: light(b) }).on, "desktop");
});

test("a red light refuses with the reason and never falls back to this computer", () => {
  const b = green();
  for (const machines of [[], [{ name: "desktop", state: "disconnected" }]]) {
    const plan = startWhere({ binding: b, repo: REPO, where: here, light: light(b, machines) });
    assert.equal(plan.on, null);
    assert.deepEqual(plan.where, here); // untouched, but the refusal is what the caller acts on
    assert.match(plan.refusal, /^Can't start on desktop: /);
    assert.match(plan.refusal, /Task settings/);
  }
  assert.match(startWhere({ binding: green(), repo: REPO, where: here, light: light(green(), []) }).refusal, /isn't a Herdr machine any more/);
  assert.match(startWhere({ binding: green(), repo: REPO, where: here, light: light(green(), [{ name: "desktop", state: "disconnected" }]) }).refusal, /isn't connected/);
});

test("a red deep check (no repo folder, say) refuses too, with its message", () => {
  const b = binding({ health: healthOf([{ id: "repo-folder", level: "red", message: "C:/src/x doesn't exist.", fix: "Clone it." }], NOW) });
  const plan = startWhere({ binding: b, repo: REPO, where: here, light: light(b) });
  assert.match(plan.refusal, /C:\/src\/x doesn't exist\. Clone it\./);
});

test("an unknown light (the machine list couldn't be read) refuses", () => {
  assert.match(startWhere({ binding: green(), repo: REPO, where: here, light: null }).refusal, /Couldn't tell whether `desktop` is connected/);
});

test("toggle off: where is unchanged, even with a red light", () => {
  const b = binding({ startHere: {} });
  for (const l of [light(b), light(b, []), null]) assert.deepEqual(startWhere({ binding: b, repo: REPO, where: here, light: l }), { where: here, on: null });
});

test("unbound, another repo, or no repo folder: where is unchanged", () => {
  assert.deepEqual(startWhere({ binding: null, repo: REPO, where: here, light: null }), { where: here, on: null });
  const b = green();
  assert.deepEqual(startWhere({ binding: b, repo: "other/repo", where: here, light: light(b) }), { where: here, on: null });
  const noFolder = binding({ repoRoots: {}, startHere: { [REPO]: true } }); // the normalizer drops a toggle with no folder; startsHere is false
  assert.deepEqual(startWhere({ binding: noFolder, repo: REPO, where: here, light: light(noFolder) }), { where: here, on: null });
});

test("a space on another machine is left alone (it already starts there)", () => {
  const remote = { cwd: "/home/x/repo", on: "laptop" };
  const b = green();
  assert.deepEqual(startWhere({ binding: b, repo: REPO, where: remote, light: light(b, []) }), { where: remote, on: null });
});

test("a space with no folder is left alone, so Start's own refusal says so", () => {
  const b = green();
  assert.deepEqual(startWhere({ binding: b, repo: REPO, where: { cwd: null }, light: light(b) }), { where: { cwd: null }, on: null });
});

test("the tooltip and the dialog line say where, or why not; with nothing changed they say nothing new", () => {
  const b = green();
  const on = startWhere({ binding: b, repo: REPO, where: here, light: light(b) });
  assert.equal(startTip(on), "Starts on desktop");
  assert.equal(startNote(on), "Starts on desktop");
  assert.equal(startsOnText("desktop"), "Starts on desktop");
  const red = startWhere({ binding: b, repo: REPO, where: here, light: light(b, []) });
  assert.equal(startTip(red), red.refusal);
  assert.equal(startNote(red), red.refusal);
  const off = startWhere({ binding: null, repo: REPO, where: here, light: null });
  assert.equal(startTip(off), "Start");
  assert.equal(startNote(off), null);
  assert.equal(startTip(undefined), "Start");
});
