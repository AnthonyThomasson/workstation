import test from "node:test";
import assert from "node:assert/strict";
import {
  kindOf, parseStat, sortRows, recent, filterRows, age, size, htmlTitle, encodeProject, worktreeRepo,
  matchProject, runMatches, splitHome, parseRuns, parseScratchPath, scan, scanFolders,
  TMPDIR_FILES, SCRATCH_FILES, TMP_FILES, RUN_LIST,
} from "./model.js";

const HOME = "/Users/a";
const NOW = 1_800_000_000_000;
const sec = (msAgo) => Math.floor((NOW - msAgo) / 1000);
const H = 3600 * 1000, D = 24 * H;

test("only HTML, HTM and Markdown files are reports", () => {
  assert.equal(kindOf("a.html"), "html");
  assert.equal(kindOf("A.HTM"), "html");
  assert.equal(kindOf("notes.md"), "md");
  assert.equal(kindOf("notes.md.bak"), null);
  assert.equal(kindOf("a.txt"), null);
});

test("stat lines: mtime, size and the rest as the path (spaces allowed); junk and repeats are dropped", () => {
  const out = parseStat("100 5 /tmp/a b.md\n200 7 /tmp/x.html\nnot a line\n300 1 /tmp/x.txt\n200 7 /tmp/x.html\n10 2 /tmp//y.md\n");
  assert.deepEqual(out.map((r) => [r.path, r.name, r.kind, r.mtime, r.size]), [
    ["/tmp/a b.md", "a b.md", "md", 100000, 5],
    ["/tmp/x.html", "x.html", "html", 200000, 7],
    ["/tmp/y.md", "y.md", "md", 10000, 2],
  ]);
  assert.deepEqual(parseStat(null), []);
});

test("rows sort newest first, then by name, without changing the input", () => {
  const rows = [{ name: "b", mtime: 1 }, { name: "z", mtime: 5 }, { name: "a", mtime: 5 }];
  assert.deepEqual(sortRows(rows).map((r) => r.name), ["a", "z", "b"]);
  assert.equal(rows[0].name, "b");
});

test("only the last seven days are kept", () => {
  const rows = [{ name: "new", mtime: NOW - D }, { name: "edge", mtime: NOW - 7 * D }, { name: "old", mtime: NOW - 8 * D }];
  assert.deepEqual(recent(rows, NOW).map((r) => r.name), ["new"]);
});

test("the filter needs every word in the name or where the file came from, in any case", () => {
  const rows = [{ name: "report.md", context: "workstation · 4aafae90" }, { name: "plan.md", context: "$TMPDIR" }];
  assert.equal(filterRows(rows, "").length, 2);
  assert.deepEqual(filterRows(rows, "REPORT").map((r) => r.name), ["report.md"]);
  assert.deepEqual(filterRows(rows, "workstation 4aaf").map((r) => r.name), ["report.md"]);
  assert.deepEqual(filterRows(rows, "tmpdir plan").map((r) => r.name), ["plan.md"]);
  assert.deepEqual(filterRows(rows, "report tmpdir"), []);
});

test("ages and sizes", () => {
  assert.equal(age(NOW - 5000, NOW), "now");
  assert.equal(age(NOW - 5 * 60000, NOW), "5m");
  assert.equal(age(NOW - 3 * H, NOW), "3h");
  assert.equal(age(NOW - 2 * D, NOW), "2d");
  assert.equal(age(NOW + 5000, NOW), "now");
  assert.equal(size(10), "10 B");
  assert.equal(size(2048), "2 KB");
  assert.equal(size(3 * 1024 * 1024), "3.0 MB");
});

test("an HTML report's title", () => {
  assert.equal(htmlTitle("<html><head><title>Architecture review for workstation</title></head>"), "Architecture review for workstation");
  assert.equal(htmlTitle("<TITLE lang=en>\n  A &amp; B\n  &lt;c&gt; </TITLE>"), "A & B <c>");
  assert.equal(htmlTitle("<p>no title</p>"), "");
  assert.equal(htmlTitle(null), "");
  assert.equal(htmlTitle(`<title>${"x".repeat(300)}</title>`).length, 120);
});

test("Claude names a project folder after its path with / and . written as -", () => {
  assert.equal(encodeProject("/Users/a/.herdr/worktrees/ws"), "-Users-a--herdr-worktrees-ws");
});

test("a Herdr worktree names its repo", () => {
  assert.equal(worktreeRepo(`${HOME}/.herdr/worktrees/ws/wf-1--job`, HOME), "ws");
  assert.equal(worktreeRepo(`${HOME}/.herdr/worktrees/ws`, HOME), "ws");
  assert.equal(worktreeRepo(`${HOME}/code/ws`, HOME), null);
  assert.equal(worktreeRepo(`/Users/ab/.herdr/worktrees/ws/x`, HOME), null);
});

test("project folders: the folder, what is inside it, its worktrees and the project around it", () => {
  const dir = (p) => encodeProject(p);
  const main = `${HOME}/code/ws`, wt = `${HOME}/.herdr/worktrees/ws/wf-1`;
  // the folder itself, and a folder inside it
  assert.equal(matchProject(dir(main), [main], HOME), "ws");
  assert.equal(matchProject(dir(`${main}/mods`), [main], HOME), "mods");
  // a worktree of the repo: found from the main checkout, and from a sibling worktree
  assert.equal(matchProject(dir(wt), [main], HOME), "wf-1");
  assert.equal(matchProject(dir(`${HOME}/.herdr/worktrees/ws/wf-2`), [wt], HOME), "wf-2");
  assert.equal(matchProject(dir(wt), [wt], HOME), "wf-1");
  // the project around a subfolder
  assert.equal(matchProject(dir(main), [`${main}/src/lib`], HOME), "ws");
  // other projects, the home folder and what is above it do not match
  assert.equal(matchProject(dir(`${HOME}/code/other`), [main], HOME), null);
  assert.equal(matchProject(dir(HOME), [`${main}/mods`], HOME), null);
  assert.equal(matchProject("-Users", [main], HOME), null);
  assert.equal(matchProject(dir(`${HOME}/.herdr/worktrees/other/x`), [main], HOME), null);
  // no folder, or one that is not absolute
  assert.equal(matchProject(dir(main), [], HOME), null);
  assert.equal(matchProject(dir(main), ["", "ws"], HOME), null);
});

test("a run belongs to the project of its worktree, its repo or a sibling worktree", () => {
  const run = { folder: `${HOME}/.herdr/worktrees/ws/wf-80`, repoRoot: `${HOME}/code/ws` };
  assert.equal(runMatches(run, [`${HOME}/code/ws`], HOME), true); // the main checkout
  assert.equal(runMatches(run, [`${HOME}/code/ws/src/lib`], HOME), true); // inside it
  assert.equal(runMatches(run, [`${HOME}/.herdr/worktrees/ws/wf-80`], HOME), true); // the run's worktree
  assert.equal(runMatches(run, [`${HOME}/.herdr/worktrees/ws/wf-80--job`], HOME), true); // a sibling worktree
  assert.equal(runMatches(run, [`${HOME}/.herdr/worktrees/ws/wf-80/mods`], HOME), true);
  assert.equal(runMatches(run, [`${HOME}/code/other`], HOME), false);
  assert.equal(runMatches(run, [`${HOME}/.herdr/worktrees/other/x`], HOME), false);
  assert.equal(runMatches(run, [], HOME), false);
  assert.equal(runMatches({}, [`${HOME}/code/ws`], HOME), false);
  assert.equal(runMatches(null, [`${HOME}/code/ws`], HOME), false);
  assert.equal(runMatches({ folder: 3 }, [`${HOME}/code/ws`], HOME), false);
});

test("script output: the home line, run lines, scratchpad paths", () => {
  assert.deepEqual(splitHome("/Users/a\np1\np2\n"), { home: "/Users/a", lines: ["p1", "p2"] });
  assert.deepEqual(splitHome(""), { home: "", lines: [] });
  const runs = parseRuns(['/r/1-x\t{"folder":"/f","repoRoot":"/g","title":"T"}', "/r/2-y\tnot json", "no tab", '/r/3-z\t[1]']);
  assert.deepEqual(runs, [{ dir: "/r/1-x", id: "1-x", folder: "/f", repoRoot: "/g", title: "T" }]);
  assert.deepEqual(parseScratchPath("/private/tmp/claude-501/-Users-a-ws/abcd1234-9/scratchpad/gallery/g.html"),
    { project: "-Users-a-ws", session: "abcd1234-9", rel: "gallery/g.html" });
  assert.equal(parseScratchPath("/private/tmp/other/x.md"), null);
});

test("the scripts never walk or glob $TMPDIR, and prune what is noise", () => {
  assert.match(TMPDIR_FILES, /-maxdepth 1/);
  assert.doesNotMatch(TMPDIR_FILES, /\*\/|\/\*|-maxdepth [2-9]/);
  assert.match(SCRATCH_FILES, /-maxdepth 2/);
  assert.match(SCRATCH_FILES, /node_modules.*\.git|\.git.*node_modules/);
  assert.match(TMP_FILES, /-maxdepth 2/);
  assert.match(TMP_FILES, /claude-\$u/);
  assert.match(RUN_LIST, /workflow-runs/);
  for (const s of [TMPDIR_FILES, SCRATCH_FILES, TMP_FILES]) assert.match(s, /-mtime -7/);
});

test("the folders a scan is matched against", () => {
  assert.deepEqual(scanFolders("/a/b", "/a"), ["/a/b", "/a"]);
  assert.deepEqual(scanFolders("/a", "/a/"), ["/a"]);
  assert.deepEqual(scanFolders(null, "/a"), ["/a"]);
  assert.deepEqual(scanFolders("rel", ""), []);
});

// A fake machine: answers by which script it is given.
function fakeIO({ files = {}, texts = {}, fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    sh: async (script, args) => {
      const key = script === TMPDIR_FILES ? "tmpdir" : script === TMP_FILES ? "tmp" : script === SCRATCH_FILES ? "scratch-files"
        : script.startsWith("printf '%s\\n' \"$HOME\"; u=") ? "scratch-projects" : script === RUN_LIST ? "run-list" : "run-files";
      calls.push([key, args]);
      if (fail[key]) return { code: 1, stdout: "", stderr: "boom\nbad thing" };
      return { code: 0, stdout: files[key] ?? "", stderr: "" };
    },
    read: async (path) => texts[path] ?? null,
  };
}

test("scratchpads: only the active project's, labelled by project and session, with HTML titles", async () => {
  const ws = encodeProject(`${HOME}/code/ws`), other = encodeProject(`${HOME}/code/other`);
  const io = fakeIO({
    files: {
      "scratch-projects": `${HOME}\n${ws}\n${other}\n`,
      "scratch-files": [
        `${sec(H)} 10 /private/tmp/claude-501/${ws}/sess0001-aaaa/scratchpad/report.md`,
        `${sec(2 * H)} 20 /private/tmp/claude-501/${ws}/sess0001-aaaa/scratchpad/gallery/g.html`,
        `${sec(9 * D)} 20 /private/tmp/claude-501/${ws}/sess0001-aaaa/scratchpad/old.md`,
        `${sec(H)} 5 /private/tmp/claude-501/${other}/sess0002-bbbb/scratchpad/leak.md`,
      ].join("\n"),
    },
    texts: { [`/private/tmp/claude-501/${ws}/sess0001-aaaa/scratchpad/gallery/g.html`]: "<title>Gallery</title>" },
  });
  const { rows, error } = await scan(io, "scratch", { folders: [`${HOME}/code/ws`], now: NOW });
  assert.equal(error, null);
  assert.deepEqual(rows.map((r) => [r.name, r.kind, r.context, r.subtitle ?? null]), [
    ["report.md", "md", "ws · sess0001", null],
    ["gallery/g.html", "html", "ws · sess0001", "Gallery"],
  ]);
  assert.deepEqual(io.calls[1], ["scratch-files", [ws]]); // only the matching project is searched
});

test("scratchpads: nothing to search when no project folder matches, or no folder is known", async () => {
  const io = fakeIO({ files: { "scratch-projects": `${HOME}\n${encodeProject(`${HOME}/code/other`)}\n` } });
  assert.deepEqual(await scan(io, "scratch", { folders: [`${HOME}/code/ws`], now: NOW }), { rows: [], error: null });
  assert.equal(io.calls.length, 1);
  assert.deepEqual(await scan(io, "scratch", { folders: [], now: NOW }), { rows: [], error: null });
});

test("$TMPDIR: its top-level files, newest first, with HTML titles", async () => {
  const io = fakeIO({
    files: { tmpdir: `${sec(3 * H)} 10 /var/T/old.md\n${sec(H)} 10 /var/T/architecture-review-1.html\n${sec(D * 8)} 1 /var/T/ancient.md` },
    texts: { "/var/T/architecture-review-1.html": "<title>Architecture review for workstation</title>" },
  });
  const { rows } = await scan(io, "tmpdir", { now: NOW });
  assert.deepEqual(rows.map((r) => [r.name, r.context, r.subtitle ?? null]), [
    ["architecture-review-1.html", "$TMPDIR", "Architecture review for workstation"],
    ["old.md", "$TMPDIR", null],
  ]);
});

test("/tmp: the folder a file sits in is its context", async () => {
  const io = fakeIO({ files: { tmp: `${sec(H)} 1 /private/tmp/a.md\n${sec(H)} 1 /private/tmp/fe/b.md` } });
  const { rows } = await scan(io, "tmp", { now: NOW });
  assert.deepEqual(rows.map((r) => [r.name, r.context]).sort(), [["a.md", "/tmp"], ["b.md", "/tmp/fe"]]);
});

test("runs: the matching runs' reports, not the briefs Herdr writes for its agents", async () => {
  const mine = `${HOME}/.herdr/workflow-runs/80-x`, theirs = `${HOME}/.herdr/workflow-runs/12-y`;
  const io = fakeIO({
    files: {
      "run-list": `${HOME}\n${mine}\t{"folder":"${HOME}/.herdr/worktrees/ws/wf-80","repoRoot":"${HOME}/code/ws","title":"#80 Skill Artifacts"}\n${theirs}\t{"folder":"${HOME}/.herdr/worktrees/zz/q","repoRoot":"${HOME}/code/zz"}\n`,
      "run-files": `${sec(H)} 9 ${mine}/plan.md\n${sec(H)} 9 ${mine}/worker.md\n${sec(2 * H)} 9 ${mine}/ticket.md`,
    },
  });
  const { rows } = await scan(io, "runs", { folders: [`${HOME}/code/ws`], now: NOW });
  assert.deepEqual(rows.map((r) => [r.name, r.context]), [["plan.md", "#80 Skill Artifacts"], ["ticket.md", "#80 Skill Artifacts"]]);
  assert.deepEqual(io.calls[1], ["run-files", [mine]]);
});

test("a failing script reports an error and keeps going with no rows", async () => {
  const io = fakeIO({ fail: { tmpdir: true, "scratch-projects": true } });
  const a = await scan(io, "tmpdir", { now: NOW });
  assert.deepEqual(a.rows, []);
  assert.equal(a.error, "Reading $TMPDIR failed: bad thing");
  const b = await scan(io, "scratch", { folders: ["/a"], now: NOW });
  assert.match(b.error, /^Listing scratchpads failed/);
  assert.deepEqual(await scan(io, "nope", { now: NOW }), { rows: [], error: null });
});
