// Pull conflicts: the pure merge and diff logic, then prepare/applyChoices against throwaway git repos
// (a bare remote and two clones). Nothing outside the scratch folder is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { world } from "./scratch-repos.js";
import { mergeMetadata, parseStages, parsePreview, diffSides, prepare, applyChoices, looksLikeConflict } from "./conflicts.js";

test("mergeMetadata takes the side that changed an entry, the later install on a tie, and keeps a delete", () => {
  const e = (at, v = "1") => ({ installed_at: at, version: v });
  const base = JSON.stringify({ entries: { keep: e("2026-01-01"), both: e("2026-01-01"), gone: e("2026-01-01") } });
  const ours = JSON.stringify({ entries: { keep: e("2026-01-01"), both: e("2026-03-01", "ours"), mine: e("2026-02-01") } });
  const theirs = JSON.stringify({ entries: { keep: e("2026-02-01", "theirs"), both: e("2026-02-01", "theirs"), gone: e("2026-01-01"), theirsNew: e("2026-02-01") } });
  const m = JSON.parse(mergeMetadata(base, ours, theirs)).entries;
  assert.equal(m.keep.version, "theirs"); // only the remote changed it
  assert.equal(m.both.version, "ours"); // both changed, ours is later
  assert.ok(m.mine && m.theirsNew); // each side's additions stay
  assert.equal(m.gone, undefined); // deleted here, untouched there
});

test("parseStages splits the three stages; parsePreview reads both sides and a deleted one", () => {
  assert.deepEqual(parseStages("@@stage 1\na\n@@stage 2\nb\n@@stage 3\n"), ["a\n", "b\n", "\n"]);
  const p = parsePreview("@@local x.md\none\ntwo\n@@remote x.md\n@@gone\n");
  assert.deepEqual(p["x.md"], { local: "one\ntwo", remote: null });
});

test("diffSides marks the lines the other side lacks and folds unchanged runs", () => {
  const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].join("\n"), b = a.replace("9", "nine");
  const d = diffSides(a, b, 1);
  assert.equal(d.differ, 1);
  assert.deepEqual(d.local.filter((l) => l.mark).map((l) => l.text), ["9"]);
  assert.deepEqual(d.remote.filter((l) => l.mark).map((l) => l.text), ["nine"]);
  assert.ok(d.local.some((l) => l.gap));
  assert.equal(diffSides(null, "x").local, null);
});

test("looksLikeConflict reads skillshare's wording", () => {
  assert.ok(looksLikeConflict({ stdout: "", stderr: "Both changed the same files. The merge was undone" }));
  assert.ok(!looksLikeConflict({ stdout: "", stderr: "could not resolve host" }));
});

// A (here) and B both changed x and y and added different metadata entries; B pushed first.
const diverge = () => {
  const w = world();
  w.put(w.b, "skills/x/SKILL.md", "line1\nB says two\nline3\n");
  w.put(w.b, "skills/y/SKILL.md", "y1\nB y2\n");
  w.put(w.b, ".metadata.json", JSON.stringify({ entries: { alpha: { installed_at: "2026-01-01T00:00:00Z", v: 1 }, fromB: { installed_at: "2026-02-01T00:00:00Z" } } }, null, 2));
  w.commit(w.b, "B edits"); w.git(w.b, "push", "-q");
  w.put(w.a, "skills/x/SKILL.md", "line1\nA says two\nline3\n");
  w.put(w.a, "skills/y/SKILL.md", "y1\nA y2\n");
  w.put(w.a, ".metadata.json", JSON.stringify({ entries: { alpha: { installed_at: "2026-01-01T00:00:00Z", v: 1 }, fromA: { installed_at: "2026-02-02T00:00:00Z" } } }, null, 2));
  w.commit(w.a, "A edits"); w.git(w.a, "fetch", "-q");
  return w;
};

test("prepare lists the conflicting files with both sides, merges nothing and leaves the repo as it was", async () => {
  const w = diverge();
  const before = w.git(w.a, "rev-parse", "HEAD");
  const r = await prepare(w.io, { repo: w.a });
  assert.equal(r.kind, "stopped");
  assert.deepEqual(r.stopped.files.sort(), ["skills/x/SKILL.md", "skills/y/SKILL.md"]); // .metadata.json is merged, not asked about
  const x = r.stopped.previews["skills/x/SKILL.md"];
  assert.ok(x.local.lines.some((l) => l.text === "A says two" && l.mark));
  assert.ok(x.remote.lines.some((l) => l.text === "B says two" && l.mark));
  assert.equal(w.git(w.a, "rev-parse", "HEAD").trim(), before.trim());
  assert.equal(w.git(w.a, "status", "--porcelain").trim(), ""); // merge undone, tree clean
  assert.equal(existsSync(join(w.a, ".git/MERGE_HEAD")), false);
  assert.equal(r.stopped.shown, 2, "how many files have a preview");
});

test("applyChoices keeps the chosen side per file, merges .metadata.json per entry and commits", async () => {
  const w = diverge();
  const { stopped } = await prepare(w.io, { repo: w.a });
  const r = await applyChoices(w.io, { repo: w.a, choices: { "skills/x/SKILL.md": "remote", "skills/y/SKILL.md": "local" }, upHash: stopped.upHash });
  assert.equal(r.kind, "applied");
  assert.equal(readFileSync(join(w.a, "skills/x/SKILL.md"), "utf8"), "line1\nB says two\nline3\n");
  assert.equal(readFileSync(join(w.a, "skills/y/SKILL.md"), "utf8"), "y1\nA y2\n");
  const meta = JSON.parse(readFileSync(join(w.a, ".metadata.json"), "utf8")).entries;
  assert.ok(meta.fromA && meta.fromB && meta.alpha);
  assert.equal(w.git(w.a, "status", "--porcelain").trim(), "");
  assert.equal(w.git(w.a, "rev-list", "--count", "origin/main..HEAD").trim(), "2"); // our commit + the merge
  assert.equal(w.git(w.a, "rev-list", "--count", "HEAD..origin/main").trim(), "0");
});

test("only .metadata.json conflicting is merged without asking", async () => {
  const w = world();
  w.put(w.b, ".metadata.json", JSON.stringify({ entries: { alpha: { installed_at: "2026-01-01T00:00:00Z", v: 1 }, fromB: { installed_at: "2026-02-01T00:00:00Z" } } }));
  w.commit(w.b, "B meta"); w.git(w.b, "push", "-q");
  w.put(w.a, ".metadata.json", JSON.stringify({ entries: { alpha: { installed_at: "2026-01-01T00:00:00Z", v: 1 }, fromA: { installed_at: "2026-02-01T00:00:00Z" } } }));
  w.commit(w.a, "A meta"); w.git(w.a, "fetch", "-q");
  const r = await prepare(w.io, { repo: w.a });
  assert.equal(r.kind, "merged", r.text);
  const meta = JSON.parse(readFileSync(join(w.a, ".metadata.json"), "utf8")).entries;
  assert.ok(meta.fromA && meta.fromB);
  assert.equal(w.git(w.a, "rev-list", "--count", "HEAD..origin/main").trim(), "0");
});

test("when the remote moved since the person looked, nothing is applied and the question is asked again", async () => {
  const w = diverge();
  const { stopped } = await prepare(w.io, { repo: w.a });
  const head = w.git(w.a, "rev-parse", "HEAD").trim();
  // B changes x again and adds a new conflict on z, then pushes.
  w.put(w.b, "skills/z/SKILL.md", "z from B\n");
  w.commit(w.b, "B more"); w.git(w.b, "push", "-q");
  const r = await applyChoices(w.io, { repo: w.a, choices: { "skills/x/SKILL.md": "remote", "skills/y/SKILL.md": "remote" }, upHash: stopped.upHash });
  assert.equal(r.kind, "again");
  assert.deepEqual(r.stopped.files.sort(), ["skills/x/SKILL.md", "skills/y/SKILL.md"]);
  assert.notEqual(r.stopped.upHash, stopped.upHash);
  assert.equal(w.git(w.a, "rev-parse", "HEAD").trim(), head); // still nothing changed
  assert.equal(existsSync(join(w.a, ".git/MERGE_HEAD")), false);
});

test("a file with no choice stops the apply and nothing changes", async () => {
  const w = diverge();
  const { stopped } = await prepare(w.io, { repo: w.a });
  const head = w.git(w.a, "rev-parse", "HEAD").trim();
  const r = await applyChoices(w.io, { repo: w.a, choices: { "skills/x/SKILL.md": "local" }, upHash: stopped.upHash });
  assert.equal(r.kind, "again");
  assert.equal(w.git(w.a, "rev-parse", "HEAD").trim(), head);
});

test("nothing conflicting is reported as none", async () => {
  const w = world();
  w.put(w.b, "skills/new.md", "n\n"); w.commit(w.b, "B"); w.git(w.b, "push", "-q");
  w.put(w.a, "skills/other.md", "o\n"); w.commit(w.a, "A"); w.git(w.a, "fetch", "-q");
  // A clean merge leaves a merge in progress with no unmerged files: it is aborted and reported as none.
  assert.equal((await prepare(w.io, { repo: w.a })).kind, "none");
  assert.equal(existsSync(join(w.a, ".git/MERGE_HEAD")), false);
});
