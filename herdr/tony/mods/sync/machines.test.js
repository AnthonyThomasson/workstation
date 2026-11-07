// The Machines section: cards read from a fake machine, version comparison, what "Pull and sync" does
// and the CLI upgrade. The JSON shapes follow real `skillshare doctor|status|diff --json`.
import test from "node:test";
import assert from "node:assert/strict";
import { world } from "./scratch-repos.js";
import { newerVersion, latestOf, updateTo, sourceText, pullPlan, loadMachine, upgradeCli, bareVersion } from "./machines.js";

test("newerVersion compares numerically, with or without a leading v", () => {
  assert.equal(newerVersion("v0.9.0", "0.10.0"), "0.10.0");
  assert.equal(newerVersion("0.29.1", "v0.29.0"), "0.29.1");
  assert.equal(bareVersion("v1.2.3"), "1.2.3");
});

test("a card says to update when the CLI says so, or another machine runs a newer one", () => {
  assert.equal(updateTo({ update: true, latest: "0.30.0", version: "0.29.1" }, "0.29.1"), "0.30.0");
  assert.equal(updateTo({ version: "0.28.0" }, "0.29.1"), "0.29.1");
  assert.equal(updateTo({ version: "0.29.1" }, "0.29.1"), null);
  assert.equal(latestOf([{ version: "0.28.0" }, { version: null }, { version: "0.29.1" }]), "0.29.1");
});

test("the source line: in the config repo, behind, uncommitted, up to date, no git", () => {
  assert.equal(sourceText({ repo: false }), "no git");
  assert.equal(sourceText(null), "no git");
  assert.equal(sourceText({ same: true }), "in the config repo");
  assert.equal(sourceText({ behind: [1, 2], uncommitted: [] }), "↓2 behind");
  assert.equal(sourceText({ behind: [], uncommitted: [{}] }), "1 uncommitted");
  assert.equal(sourceText({ behind: [], uncommitted: [] }), "up to date");
});

test("Pull and sync: the source's own repo is pulled with skillshare, else the config repo, else the targets are linked", () => {
  const own = { git: { path: "/s", same: false, repo: true } };
  assert.equal(pullPlan({ cfg: { repo: "/r" }, card: own }), "source");
  assert.equal(pullPlan({ cfg: { repo: "/r" }, card: { git: { path: "/s", same: true } } }), "repo");
  assert.equal(pullPlan({ cfg: { repo: "" }, card: { git: { path: "/s", same: true } } }), "targets");
  assert.equal(pullPlan({ cfg: { repo: "/r" }, card: { git: { path: "/s", repo: false } } }), "repo");
  assert.equal(pullPlan({ cfg: { repo: "" }, card: null }), "targets");
});

test("loadMachine reads version, doctor counts, targets, drift and the source's git state", async () => {
  const w = world();
  const json = {
    doctor: { summary: { errors: 1, warnings: 2 }, version: { current: "0.29.1", latest: "0.30.0", update_available: true } },
    status: { source: { path: w.a }, targets: [{ skills_enabled: true }, { skills_enabled: false }, {}] },
    diff: { targets: [{ name: "claude", items: [{ is_sync: true, kind: "skill", name: "a", action: "add" }, { is_sync: true, kind: "skill", name: "b", action: "modify" }] }] },
  };
  const io = {
    sh: (s, a, on) => (s === "hostname -s" ? Promise.resolve({ code: 0, stdout: "mac\n", stderr: "" }) : w.io.sh(s, a)),
    job: async (args) => ({ code: 0, stdout: JSON.stringify(json[args[0]]), stderr: "" }),
    run: async (args) => ({ code: 0, stdout: JSON.stringify(json[args[0]]), stderr: "" }),
  };
  const m = await loadMachine(io, null, { configRepo: "" });
  assert.deepEqual([m.label, m.here, m.version, m.latest, m.update, m.targets, m.drift], ["mac", true, "0.29.1", "0.30.0", true, 2, 2]);
  assert.deepEqual(m.doctor, { errors: 1, warnings: 2 });
  assert.equal(m.git.repo, true);
  assert.equal(m.git.same, false);
  assert.equal((await loadMachine(io, "pi", { configRepo: w.a })).git.same, true);
  assert.equal((await loadMachine(io, "pi")).label, "pi");
});

test("a machine without skillshare is marked missing", async () => {
  const io = { sh: async () => ({ stdout: "" }), job: async () => ({ code: 127, stdout: "", stderr: "skillshare: not found" }), run: async () => ({ code: 127, stdout: "", stderr: "skillshare: not found" }) };
  const m = await loadMachine(io, "pi");
  assert.equal(m.missing, true);
});

test("upgrade runs skillshare upgrade --cli --force on that machine", async () => {
  const calls = [];
  const ok = await upgradeCli({ job: async (args, o) => { calls.push([args.join(" "), o.on]); return { code: 0, stdout: "", stderr: "" }; } }, { on: "pi", label: "pi" });
  assert.deepEqual(calls, [["upgrade --cli --force", "pi"]]);
  assert.equal(ok.kind, "done");
  const bad = await upgradeCli({ job: async () => ({ code: 1, stdout: "", stderr: "no network" }) }, { label: "this computer" });
  assert.deepEqual([bad.kind, bad.text], ["error", "no network"]);
});
