import test from "node:test";
import assert from "node:assert/strict";
import { agoText, cardView, headerDot, lightColor, machineNames, machinesChanged, parseMachineList, signInFor, spaceFolders, startToggle, tooltipOf } from "./card-model.js";
import { normalizeBinding, healthOf } from "./test-device.js";
import { LOGIN, REFRESH } from "../lib/index.js";

const REPO = "AnthonyThomasson/workstation";
const NOW = Date.parse("2026-11-22T12:00:00Z");
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const connected = [{ name: "desktop", state: "connected", host: "desktop-8d2jtto", target: "athom@desktop-8d2jtto" }];
const bound = (extra = {}) => normalizeBinding({ machine: "desktop", os: "windows", home: "C:/Users/me", repoRoots: { [REPO]: "C:/src/workstation" }, ...extra });
const checks = [
  { id: "git", level: "green", message: "git is installed." },
  { id: "gh-scope", level: "yellow", message: "On `desktop`: gh's token has no project scope.", fix: "Sign in on desktop again to add the project scope." },
  { id: "repo-folder", level: "red", message: "C:/src/x doesn't exist.", fix: "Clone it." },
];

test("agoText: just now, minutes, hours, days", () => {
  assert.equal(agoText(NOW - 20 * 1000, NOW), "just now");
  assert.equal(agoText(NOW - 5 * MIN, NOW), "5 min ago");
  assert.equal(agoText(NOW - 3 * HOUR, NOW), "3 h ago");
  assert.equal(agoText(NOW - 2 * DAY, NOW), "2 days ago");
  assert.equal(agoText(NOW - 1 * DAY, NOW), "1 day ago");
  assert.equal(agoText(null, NOW), null);
  assert.equal(agoText(NOW + 5000, NOW), "just now");
});

test("the light's colour is the theme's green, yellow or red", () => {
  assert.deepEqual(["green", "yellow", "red"].map(lightColor), ["ansi2", "ansi3", "ansi1"]);
  assert.equal(lightColor("nonsense"), "ansi1");
});

test("machineNames lists hc machine ls --json machines by name, from the object or a bare list", () => {
  assert.deepEqual(machineNames({ machines: [{ name: "desktop" }, { name: "" }, { host: "x" }, { name: "laptop" }] }), ["desktop", "laptop"]);
  assert.deepEqual(machineNames([{ name: "a" }]), ["a"]);
  assert.deepEqual(machineNames(null), []);
});

test("an unbound card offers the machines to pick, or Add a machine when there are none", () => {
  const some = cardView({ binding: null, machines: connected, repo: REPO, now: NOW });
  assert.equal(some.bound, false);
  assert.deepEqual(some.pick, ["desktop"]);
  assert.equal(some.addMachine, false);
  assert.equal(some.light, null);
  const none = cardView({ binding: null, machines: { machines: [] }, repo: REPO, now: NOW });
  assert.deepEqual(none.pick, []);
  assert.equal(none.addMachine, true);
  // before hc machine ls has answered nothing is offered: no Add a machine for a list that is only not loaded yet
  const loading = cardView({ binding: null, machines: null, repo: REPO, now: NOW });
  assert.equal(loading.loading, true);
  assert.equal(loading.addMachine, false);
});

test("a bound card whose machine list hasn't loaded yet shows no light and no failing checks", () => {
  const v = cardView({ binding: bound(), machines: null, repo: REPO, now: NOW });
  assert.equal(v.bound, true);
  assert.equal(v.loading, true);
  assert.equal(v.level, null);
  assert.deepEqual(v.failing, []);
  assert.equal(headerDot(bound(), null, NOW), null);
});

test("a bound card: name · os, the light, the repo folder, and Check/Unbind (no machines list)", () => {
  const b = bound({ health: healthOf(checks, NOW - 5 * MIN) });
  const v = cardView({ binding: b, machines: connected, repo: REPO, now: NOW });
  assert.equal(v.bound, true);
  assert.equal(v.title, "desktop · windows");
  assert.equal(v.level, "red");
  assert.equal(v.repoFolder, "C:/src/workstation");
  assert.equal(v.folderLabel, "Repo folder on desktop");
  assert.equal(v.checkedAgo, "5 min ago");
  assert.deepEqual(v.failing.map((c) => c.id), ["repo-folder", "gh-scope"]); // reds first, greens left out
});

test("the card uses only the cheap light: a missing or disconnected machine is red with no deep checks shown", () => {
  const b = bound({ health: healthOf([{ id: "git", level: "green", message: "ok" }], NOW) });
  const gone = cardView({ binding: b, machines: [], repo: REPO, now: NOW });
  assert.equal(gone.level, "red");
  assert.match(gone.failing[0].message, /isn't a Herdr machine any more/);
  const off = cardView({ binding: b, machines: [{ name: "desktop", state: "disconnected" }], repo: REPO, now: NOW });
  assert.equal(off.level, "red");
  assert.match(off.failing[0].message, /isn't connected/);
  // not checked yet: yellow with the Check hint
  const fresh = cardView({ binding: bound(), machines: connected, repo: REPO, now: NOW });
  assert.equal(fresh.level, "yellow");
  assert.equal(fresh.failing[0].message, "Not checked yet");
  assert.equal(fresh.checkedAgo, null);
});

test("no folder set for the repo shows an empty field; another repo's folder isn't shown", () => {
  assert.equal(cardView({ binding: bound(), machines: connected, repo: "other/repo", now: NOW }).repoFolder, "");
  assert.equal(cardView({ binding: bound(), machines: connected, repo: "", now: NOW }).repoFolder, "");
  assert.equal(cardView({ binding: bound(), machines: connected, repo: "", now: NOW }).canSetFolder, false);
  assert.equal(cardView({ binding: bound(), machines: connected, repo: REPO, now: NOW }).canSetFolder, true);
});

test("the gh-scope and gh-auth checks get a Sign in on <machine> button; other checks don't", () => {
  assert.deepEqual(signInFor({ id: "gh-scope" }, "desktop"), { label: "Sign in on desktop", args: REFRESH });
  assert.deepEqual(signInFor({ id: "gh-auth" }, "desktop"), { label: "Sign in on desktop", args: LOGIN });
  for (const id of ["gh", "git", "disk", "repo-folder", "mods", "checked", "machine", "connected"]) assert.equal(signInFor({ id }, "desktop"), null, id);
  const v = cardView({ binding: bound({ health: healthOf(checks, NOW) }), machines: connected, repo: REPO, now: NOW });
  assert.equal(v.failing.find((c) => c.id === "gh-scope").signIn.label, "Sign in on desktop");
  assert.equal(v.failing.find((c) => c.id === "repo-folder").signIn, null);
});

test("sign-in is not offered while the machine is unreachable", () => {
  const b = bound({ health: healthOf(checks, NOW) });
  const v = cardView({ binding: b, machines: [], repo: REPO, now: NOW });
  assert.ok(v.failing.every((c) => c.signIn === null));
});

test("headerDot: nothing when unbound; else the cheap light with a tooltip listing failing checks and fixes", () => {
  assert.equal(headerDot(null, connected, NOW), null);
  const dot = headerDot(bound({ health: healthOf(checks, NOW) }), connected, NOW);
  assert.equal(dot.level, "red");
  assert.equal(dot.color, "ansi1");
  assert.match(dot.tip, /^Test device desktop: red/);
  assert.match(dot.tip, /C:\/src\/x doesn't exist\. Clone it\./);
  assert.match(dot.tip, /project scope\. Sign in on desktop again/);
  assert.doesNotMatch(dot.tip, /git is installed/);
  const green = headerDot(bound({ health: healthOf([{ id: "git", level: "green", message: "ok" }], NOW) }), connected, NOW);
  assert.equal(green.level, "green");
  assert.equal(green.tip, "Test device desktop: green");
});

test("tooltipOf lists each failing check on its own line with its fix", () => {
  const tip = tooltipOf("desktop", "yellow", [{ id: "a", level: "yellow", message: "A broke.", fix: "Fix A." }, { id: "b", level: "yellow", message: "B broke." }]);
  assert.equal(tip, "Test device desktop: yellow\n• A broke. Fix A.\n• B broke.");
});

test("spaceFolders: the folders of the spaces on a machine, each once", () => {
  const spaces = [
    { machine: "desktop", folder: "C:/a" }, { machine: "desktop", folder: "C:/a" }, { machine: "desktop", folder: "C:/b/" },
    { machine: "other", folder: "C:/c" }, { folder: "/here" }, { machine: "desktop" }, { machine: "desktop", folder: "  " },
  ];
  assert.deepEqual(spaceFolders(spaces, "desktop"), ["C:/a", "C:/b"]);
  assert.deepEqual(spaceFolders(null, "desktop"), []);
});

test("parseMachineList reads hc machine ls --json; anything unreadable is null, never an empty list", () => {
  assert.deepEqual(parseMachineList('{"machines":[{"name":"desktop","state":"connected"}]}'), [{ name: "desktop", state: "connected" }]);
  assert.deepEqual(parseMachineList('{"machines":[]}'), []);
  assert.deepEqual(parseMachineList("[{\"name\":\"a\"}]"), [{ name: "a" }]);
  for (const bad of ["", "not json", "{}", "null", '{"machines":"x"}', undefined]) assert.equal(parseMachineList(bad), null, String(bad));
});

test("the picker lists only connected machines; a list of only disconnected ones says so instead of offering Add a machine", () => {
  const list = [{ name: "desktop", state: "connected" }, { name: "old", state: "disconnected" }, { name: "away", state: "connecting" }];
  const v = cardView({ binding: null, machines: list, repo: REPO, now: NOW });
  assert.deepEqual(v.pick, ["desktop"]);
  assert.equal(v.addMachine, false);
  assert.equal(v.noneConnected, false);
  const off = cardView({ binding: null, machines: [{ name: "old", state: "disconnected" }], repo: REPO, now: NOW });
  assert.deepEqual(off.pick, []);
  assert.equal(off.addMachine, false);
  assert.equal(off.noneConnected, true);
  assert.equal(cardView({ binding: null, machines: [], repo: REPO, now: NOW }).noneConnected, false);
});

test("machinesChanged: herdr's live machine names against the last hc machine ls list (order and null names don't matter)", () => {
  const list = [{ name: "desktop" }, { name: "laptop" }];
  assert.equal(machinesChanged([{ name: "laptop" }, { name: "desktop" }], list), false);
  assert.equal(machinesChanged([{ name: "desktop" }, { name: null }, { name: "laptop" }], list), false);
  assert.equal(machinesChanged([{ name: "desktop" }], list), true);
  assert.equal(machinesChanged([{ name: "desktop" }, { name: "laptop" }, { name: "new" }], list), true);
  assert.equal(machinesChanged([], []), false);
  assert.equal(machinesChanged([{ name: "a" }], null), false, "nothing loaded yet: the first load is already on its way");
  assert.equal(machinesChanged(undefined, list), true);
});

test("temporary machines (hc machine ls lists them, herdr's machines() doesn't) are left out of machinesChanged and of the picker", () => {
  const list = [{ name: "desktop", state: "connected" }, { name: "tmp", temporary: true, state: "connected" }];
  assert.equal(machinesChanged([{ name: "desktop" }], list), false);
  assert.equal(machinesChanged([{ name: "desktop" }, { name: "new" }], list), true);
  const v = cardView({ binding: null, machines: list, repo: REPO, now: NOW });
  assert.deepEqual(v.pick, ["desktop"]);
  const only = cardView({ binding: null, machines: [{ name: "tmp", temporary: true, state: "connected" }], repo: REPO, now: NOW });
  assert.equal(only.addMachine, true, "a sandbox alone is no machine to bind");
  assert.deepEqual(only.pick, []);
});

test("the Start toggle is offered only with a repo folder, off by default, and says which machine", () => {
  assert.deepEqual(startToggle(bound(), REPO), { offered: true, on: false, label: "Start this repo's tickets on desktop" });
  assert.equal(startToggle(bound({ startHere: { [REPO]: true } }), REPO).on, true);
  assert.equal(startToggle(bound({ repoRoots: {} }), REPO).offered, false); // no folder: nothing to put the worktree in
  assert.equal(startToggle(bound(), "other/repo").offered, false);
  assert.equal(startToggle(bound(), "").offered, false);
  assert.equal(startToggle(null, REPO).offered, false);
  const v = cardView({ binding: bound({ startHere: { [REPO]: true } }), machines: connected, repo: REPO, now: NOW });
  assert.equal(v.startToggle.on, true);
  assert.equal(cardView({ binding: bound(), machines: null, repo: REPO, now: NOW }).startToggle.offered, true); // still loading: the same
});
