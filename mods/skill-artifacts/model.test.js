import test from "node:test";
import assert from "node:assert/strict";
import {
  isHtml, parseStat, sortRows, recent, filterRows, age, size, htmlTitle, encodeProject, worktreeRepo,
  matchProject, splitHome, parseScratchPath, parseMarkers, skipReport, NOISE_DIR, scan, scanFolders,
  TMPDIR_FILES, SCRATCH_FILES, TMP_FILES,
} from "./model.js";

const HOME = "/Users/a";
const NOW = 1_800_000_000_000;
const sec = (msAgo) => Math.floor((NOW - msAgo) / 1000);
const H = 3600 * 1000, D = 24 * H;

test("only HTML and HTM files are reports; Markdown is not", () => {
  assert.equal(isHtml("a.html"), true);
  assert.equal(isHtml("A.HTM"), true);
  assert.equal(isHtml("notes.md"), false);
  assert.equal(isHtml("a.html.bak"), false);
  assert.equal(isHtml("a.txt"), false);
});

test("stat lines: mtime, size and the rest as the path (spaces allowed); junk, Markdown and repeats are dropped", () => {
  const out = parseStat("100 5 /tmp/a b.html\n200 7 /tmp/x.htm\nnot a line\n300 1 /tmp/x.txt\n150 1 /tmp/notes.md\n200 7 /tmp/x.htm\n10 2 /tmp//y.html\nM /tmp/a/.git\n");
  assert.deepEqual(out.map((r) => [r.path, r.name, r.mtime, r.size]), [
    ["/tmp/a b.html", "a b.html", 100000, 5],
    ["/tmp/x.htm", "x.htm", 200000, 7],
    ["/tmp/y.html", "y.html", 10000, 2],
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

test("the filter needs every word in the title, the name or where the file came from, in any case", () => {
  const rows = [{ name: "report.html", title: "Architecture review", context: "workstation · 4aafae90" }, { name: "plan.html", context: "$TMPDIR" }];
  assert.equal(filterRows(rows, "").length, 2);
  assert.deepEqual(filterRows(rows, "REPORT").map((r) => r.name), ["report.html"]);
  assert.deepEqual(filterRows(rows, "architecture").map((r) => r.name), ["report.html"]);
  assert.deepEqual(filterRows(rows, "workstation 4aaf").map((r) => r.name), ["report.html"]);
  assert.deepEqual(filterRows(rows, "tmpdir plan").map((r) => r.name), ["plan.html"]);
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

test("script output: the home line, scratchpad paths, marker lines", () => {
  assert.deepEqual(splitHome("/Users/a\np1\np2\n"), { home: "/Users/a", lines: ["p1", "p2"] });
  assert.deepEqual(splitHome(""), { home: "", lines: [] });
  assert.deepEqual(parseScratchPath("/private/tmp/claude-501/-Users-a-ws/abcd1234-9/scratchpad/gallery/g.html"),
    { project: "-Users-a-ws", session: "abcd1234-9", rel: "gallery/g.html" });
  assert.equal(parseScratchPath("/private/tmp/other/x.html"), null);
  assert.deepEqual([...parseMarkers("1 2 /x.html\nM /private/tmp/repo/.git\nM /private/tmp/app/package.json\nM /private/tmp/app/node_modules\nM rel\n")].sort(),
    ["/private/tmp/app", "/private/tmp/repo"]);
});

test("HTML in a cloned repo or in test output is skipped; the top of a source never is", () => {
  const markers = new Set(["/private/tmp/clone", "/private/tmp/app"]);
  const skip = (path, rel) => skipReport(path, rel, markers);
  // a folder with .git, package.json or node_modules beside it
  assert.equal(skip("/private/tmp/clone/docs/a.html", "clone/docs/a.html"), true);
  assert.equal(skip("/private/tmp/clone/index.html", "clone/index.html"), true);
  assert.equal(skip("/private/tmp/app/x.html", "app/x.html"), true);
  // test and build output by name (GdUnit's report_<n>, test-report, coverage ...)
  for (const d of ["report_1", "report_12", "test-report", "test_results", "test-results", "coverage", "htmlcov", "playwright-report", "allure-report", "lcov-report", "build", "dist", "target", "node_modules", ".git", ".cache", "Report_3"]) {
    assert.equal(skip(`/private/tmp/${d}/index.html`, `${d}/index.html`), true, d);
  }
  // an ordinary folder of reports is listed, and so is a file at the top
  for (const d of ["architecture", "fe-perf-findings", "security-report", "reports", "reporting", "my-coverage-notes", "distance"]) {
    assert.equal(skip(`/private/tmp/${d}/index.html`, `${d}/index.html`), false, d);
  }
  assert.equal(skip("/private/tmp/clone.html", "clone.html"), false);
  assert.equal(skip("/private/tmp/report_1.html", "report_1.html"), false);
  assert.equal(NOISE_DIR.test("report"), false);
});

test("the scripts never walk or glob $TMPDIR, and prune what is noise", () => {
  assert.match(TMPDIR_FILES, /-maxdepth 1/);
  assert.doesNotMatch(TMPDIR_FILES, /\*\/|\/\*|-maxdepth [2-9]/);
  assert.match(SCRATCH_FILES, /-maxdepth 2/);
  assert.match(SCRATCH_FILES, /node_modules.*\.git|\.git.*node_modules/);
  assert.match(TMP_FILES, /-maxdepth 2/);
  assert.match(TMP_FILES, /claude-\$u/);
  for (const s of [TMPDIR_FILES, SCRATCH_FILES, TMP_FILES]) {
    assert.match(s, /-mtime -7/);
    assert.match(s, /-iname '\*\.html' -o -iname '\*\.htm'/);
    assert.doesNotMatch(s, /\.md/); // HTML only
  }
  for (const s of [SCRATCH_FILES, TMP_FILES]) assert.match(s, /-mindepth 2 -maxdepth 2/); // marker finds stay shallow
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
      const key = script === TMPDIR_FILES ? "tmpdir" : script === TMP_FILES ? "tmp" : script === SCRATCH_FILES ? "scratch-files" : "scratch-projects";
      calls.push([key, args]);
      if (fail[key]) return { code: 1, stdout: "", stderr: "boom\nbad thing" };
      return { code: 0, stdout: files[key] ?? "", stderr: "" };
    },
    read: async (path) => texts[path] ?? null,
  };
}

const WS = encodeProject(`${HOME}/code/ws`), OTHER = encodeProject(`${HOME}/code/other`);
const SP = (project, session = "sess0001-aaaa") => `/private/tmp/claude-501/${project}/${session}/scratchpad`;

test("one list merges scratchpads, $TMPDIR and /tmp newest first, with titles, contexts and no Markdown", async () => {
  const io = fakeIO({
    files: {
      "scratch-projects": `${HOME}\n${WS}\n${OTHER}\n`,
      "scratch-files": [
        `${sec(5 * H)} 10 ${SP(WS)}/report.html`,
        `${sec(2 * H)} 20 ${SP(WS)}/gallery/g.html`,
        `${sec(2 * H)} 20 ${SP(WS)}/notes.md`,
        `${sec(9 * D)} 20 ${SP(WS)}/old.html`,
        `${sec(H)} 5 ${SP(OTHER, "sess0002-bbbb")}/leak.html`,
      ].join("\n"),
      tmpdir: `${sec(3 * H)} 10 /var/T/plain.html\n${sec(H / 2)} 10 /var/T/architecture-review-1.html\n${sec(D * 8)} 1 /var/T/ancient.html`,
      tmp: `${sec(4 * H)} 1 /private/tmp/a.html\n${sec(6 * H)} 1 /private/tmp/fe/b.html`,
    },
    texts: {
      [`${SP(WS)}/gallery/g.html`]: "<title>Gallery</title>",
      "/var/T/architecture-review-1.html": "<title>Architecture review for workstation</title>",
    },
  });
  const { rows, error } = await scan(io, { folders: [`${HOME}/code/ws`], now: NOW });
  assert.equal(error, null);
  assert.deepEqual(rows.map((r) => [r.title, r.name, r.context]), [
    ["Architecture review for workstation", "architecture-review-1.html", "$TMPDIR"],
    ["Gallery", "gallery/g.html", "ws · sess0001"],
    ["", "plain.html", "$TMPDIR"],
    ["", "a.html", "/tmp"],
    ["", "report.html", "ws · sess0001"],
    ["", "b.html", "/tmp/fe"],
  ]);
  assert.deepEqual(io.calls.find((c) => c[0] === "scratch-files"), ["scratch-files", [WS]]); // only the matching project is searched
});

test("the same file seen as /tmp and /private/tmp is listed once", async () => {
  const io = fakeIO({ files: { tmpdir: `${sec(H)} 1 /tmp/x.html`, tmp: `${sec(H)} 1 /private/tmp/x.html` } });
  assert.equal((await scan(io, { now: NOW })).rows.length, 1);
});

test("scratchpads: cloned sources and test output are skipped, plain folders are kept", async () => {
  const io = fakeIO({
    files: {
      "scratch-projects": `${HOME}\n${WS}\n`,
      "scratch-files": [
        `${sec(H)} 1 ${SP(WS)}/top.html`,
        `${sec(H)} 1 ${SP(WS)}/gallery/g.html`,
        `${sec(H)} 1 ${SP(WS)}/clone/docs.html`,
        `${sec(H)} 1 ${SP(WS)}/report_3/index.html`,
        `M ${SP(WS)}/clone/.git`,
      ].join("\n"),
    },
  });
  const { rows } = await scan(io, { folders: [`${HOME}/code/ws`], now: NOW });
  assert.deepEqual(rows.map((r) => r.name).sort(), ["gallery/g.html", "top.html"]);
});

test("/tmp: the folder a file sits in is its context; checkouts and test output are skipped", async () => {
  const io = fakeIO({ files: { tmp: [
    `${sec(H)} 1 /private/tmp/a.html`, `${sec(H)} 1 /private/tmp/fe/b.html`, `${sec(H)} 1 /private/tmp/repo/c.html`, "M /private/tmp/repo/.git",
    `${sec(H)} 1 /private/tmp/gdunit/d.html`, `${sec(H)} 1 /private/tmp/test-report/index.html`, "M /private/tmp/gdunit/package.json",
  ].join("\n") } });
  const { rows } = await scan(io, { now: NOW });
  assert.deepEqual(rows.map((r) => [r.name, r.context]).sort(), [["a.html", "/tmp"], ["b.html", "/tmp/fe"]]);
});

test("a failing source reports an error and the others still list", async () => {
  const io = fakeIO({ files: { tmp: `${sec(H)} 1 /private/tmp/a.html` }, fail: { tmpdir: true, "scratch-projects": true } });
  const a = await scan(io, { folders: ["/a"], now: NOW });
  assert.deepEqual(a.rows.map((r) => r.name), ["a.html"]);
  assert.equal(a.error, "Listing scratchpads failed: bad thing; Reading $TMPDIR failed: bad thing");
  const b = await scan(fakeIO({ fail: { tmpdir: true } }), { now: NOW });
  assert.deepEqual(b.rows, []);
  assert.equal(b.error, "Reading $TMPDIR failed: bad thing");
});

test("scratchpads: nothing to search when no project folder matches, or no folder is known", async () => {
  const io = fakeIO({ files: { "scratch-projects": `${HOME}\n${OTHER}\n` } });
  assert.deepEqual(await scan(io, { folders: [`${HOME}/code/ws`], now: NOW }), { rows: [], error: null });
  assert.equal(io.calls.filter((c) => c[0] === "scratch-files").length, 0);
  assert.deepEqual(await scan(io, { folders: [], now: NOW }), { rows: [], error: null });
});

test("an HTML title is read once per file version, and again when the file changes", async () => {
  const reads = [];
  const line = (m) => `${sec(m)} 10 /var/T/cache-test.html`;
  const io = (stdout) => ({ sh: async () => ({ code: 0, stdout, stderr: "" }), read: async (p) => { reads.push(p); return "<title>T</title>"; } });
  await scan(io(line(H)), { now: NOW });
  await scan(io(line(H)), { now: NOW });
  assert.equal(reads.length, 1);
  const { rows } = await scan(io(line(H)), { now: NOW });
  assert.equal(rows[0].title, "T");
  await scan(io(line(2 * H)), { now: NOW }); // a different mtime
  assert.equal(reads.length, 2);
});

test("an unreadable HTML file gets no title and is tried again next scan", async () => {
  let n = 0;
  const io = { sh: async () => ({ code: 0, stdout: `${sec(H)} 10 /var/T/unreadable.html`, stderr: "" }), read: async () => { n++; return null; } };
  assert.equal((await scan(io, { now: NOW })).rows[0].title, "");
  await scan(io, { now: NOW });
  assert.equal(n, 2);
});

test("stat tries GNU's format first, then BSD's", () => {
  assert.ok(TMPDIR_FILES.indexOf("stat -c") < TMPDIR_FILES.indexOf("stat -f"));
});
