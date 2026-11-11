// Checks the folder layout of mods/github-tasks: every .js file under the mod (tests included) is parsed (with the vendored,
// pinned acorn in tests/vendor/acorn/) and every relative import is judged against the layout below. Each failure is
// reported with file:line and the rule it breaks.
// Run from anywhere with: node tests/github-tasks-layout.test.js [mod-folder]   (default: the repo's mods/github-tasks)
// The fixtures test, tests/github-tasks-layout.fixtures.test.js, runs this check on small trees under tests/fixtures/github-tasks-layout/.
// No npm install; the same code always gives the same result (sorted walk, sorted output). Exit 1 on any failure.
//
// The layout is the LAYOUT constant below: the mod's top level holds only the top files (main.js, prompts-page.js) and data folders
// (icons/, starters/: no code). Everything else lives in a folder, and each folder's index.js is its public interface. Folders stack
// in tiers, and an import may only point down the stack (a folder never imports a folder of its own tier, or a higher one). The
// rules below are generic over that table: to add, move or merge a folder, edit LAYOUT and nothing else.
//
// The rules (what counts as a failure):
//   deep-import    an import from outside a folder into anything in it but its index.js (code and tests alike).
//   self-index     a file inside a folder importing that folder's own index.js (siblings are imported directly).
//   direction      a folder importing a folder of a higher tier, or a folder importing a top file.
//   sibling        a folder importing another folder of its own tier (editor and doctor may not import each other).
//   imports-main   any file importing the entry (main.js: nothing does; it wires everything).
//   cycle          folders that import each other round in a circle, whatever the tiers say (reported once per cycle).
//   no-index       a folder with no index.js.
//   top-level-file a .js file at the top level other than main.js and prompts-page.js.
//   unknown-folder a folder with .js files that is not in the table (and not a data folder).
//   pure-import    a folder marked pure in the table importing herdr, gpui-kit or gpui-base (directly; tests in it too).
//   dynamic-import an import() whose path is not a plain string, so the check can't follow it.
//   parse          the file is not valid JavaScript.
// Apart from pure-import, only relative imports are judged: "herdr", "gpui-kit", "node:fs" and the like are not part of the layout. Files and folders
// that are symlinks are not followed. A folder that is in the table but absent is fine (a small tree needs not have them all).

import { lstatSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "./vendor/acorn/acorn.mjs";

// THE TABLE: edit here. Everything else is generic over it.
//   top     .js files allowed at the top level; they sit above every folder.
//   entry   the one top file nothing may import.
//   data    folders that hold data, not code (their paths are Herdr-root based, so they stay at the top level): no index.js needed.
//   tiers   folders, from the top of the stack to the bottom: a folder may import (through index.js) folders of later tiers only.
//   pure    folders that may not import herdr, gpui-kit or gpui-base.
export const LAYOUT = {
  top: ["main.js", "prompts-page.js"],
  entry: "main.js",
  data: ["icons", "starters"],
  tiers: [
    ["settings"],
    ["editor", "doctor"],
    ["investigations"],
    ["runs"],
    ["workflow"],
    ["github"],
    ["lib"],
  ],
  pure: [],
};
// What a pure folder may not import.
const HOST_MODULES = ["herdr", "gpui-kit", "gpui-base"];

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const posix = (p) => p.split(path.sep).join("/");


// Every .js file under dir (sorted, as posix paths relative to dir) and every folder (relative path); symlinks are not followed.
function walk(root) {
  const files = [];
  const dirs = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        dirs.push(posix(path.relative(root, full)));
        visit(full);
      } else if (st.isFile() && name.endsWith(".js")) files.push(posix(path.relative(root, full)));
    }
  };
  visit(root);
  return { files, dirs };
}

// Every import, export-from and import() in a parsed file: { spec, line } (spec is null for an import() that isn't a plain string).
function importsOf(ast) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if ((node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") && node.source) {
      found.push({ spec: node.source.value, line: node.source.loc.start.line });
    } else if (node.type === "ImportExpression") {
      const s = node.source;
      const spec = s.type === "Literal" && typeof s.value === "string" ? s.value
        : s.type === "TemplateLiteral" && s.expressions.length === 0 ? s.quasis[0].value.cooked : null;
      found.push({ spec, line: s.loc.start.line });
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === "string") visit(v);
    }
  };
  visit(ast);
  return found;
}

// A path relative to the mod -> the folder it is in ("" for the top level) and the rest of the path inside it.
function place(rel) {
  const parts = rel.split("/");
  return parts.length === 1 ? { folder: "", rest: parts[0] } : { folder: parts[0], rest: parts.slice(1).join("/") };
}

const TIER_NAME = (n) => (n === 0 ? "top level" : `tier ${n}`);

export function checkLayout(root, layout = LAYOUT) {
  root = path.resolve(root);
  const { top: TOP_FILES, entry: ENTRY, data: DATA_FOLDERS, pure: PURE } = layout;
  const TIER_OF = new Map();
  layout.tiers.forEach((names, i) => names.forEach((n) => TIER_OF.set(n, i + 1)));
  const failures = [];
  const fail = (file, line, rule, message) => failures.push({ file, line, rule, message });
  const { files, dirs } = walk(root);

  // Folder rules: each top-level folder with code in it must be known, and must have an index.js.
  const topDirs = dirs.filter((d) => !d.includes("/"));
  for (const d of topDirs) {
    if (DATA_FOLDERS.includes(d)) continue;
    const hasCode = files.some((f) => f.startsWith(`${d}/`));
    if (!TIER_OF.has(d)) {
      if (hasCode) fail(d, 0, "unknown-folder", `"${d}" is not a folder of the layout (add it to the table in tests/github-tasks-layout.test.js, or move the code)`);
      continue;
    }
    if (!existsSync(path.join(root, d, "index.js"))) fail(d, 0, "no-index", `"${d}/" has no index.js (its public interface)`);
  }

  // Top level: only main.js and prompts-page.js.
  for (const f of files) {
    if (!f.includes("/") && !TOP_FILES.includes(f)) fail(f, 1, "top-level-file", `${f} is at the top level; only ${TOP_FILES.join(" and ")} are (move it into a folder)`);
  }

  // Imports.
  const edges = []; // folder -> folder, with where it was written
  for (const f of files) {
    let ast;
    try {
      ast = acorn.parse(readFileSync(path.join(root, f), "utf8"), { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
    } catch (e) {
      fail(f, e.loc?.line ?? 1, "parse", `not valid JavaScript: ${e.message}`);
      continue;
    }
    const from = place(f);
    const fromTier = from.folder === "" ? 0 : TIER_OF.get(from.folder); // undefined for an unknown folder: judged by the other rules
    for (const { spec, line } of importsOf(ast)) {
      if (spec === null) { fail(f, line, "dynamic-import", "import() with a path that is not a plain string can't be followed"); continue; }
      if (!spec.startsWith(".")) {
        // herdr, gpui-kit, node:*: not part of the layout, except that a pure folder may not reach the host
        if (PURE.includes(from.folder) && HOST_MODULES.includes(spec)) fail(f, line, "pure-import", `${spec}: ${from.folder}/ is pure and may not import ${HOST_MODULES.join(", ")}`);
        continue;
      }
      let target = path.resolve(root, path.dirname(f), spec);
      const rel = posix(path.relative(root, target));
      if (rel === "" || rel.startsWith("..")) continue; // leaves the mod: mod-isolation's business
      try { if (statSync(target).isDirectory()) target = path.join(target, "index.js"); } catch { /* not there: judged by its path */ }
      const to = place(posix(path.relative(root, target)));

      if (to.folder === "" && to.rest === ENTRY) { fail(f, line, "imports-main", `${spec}: nothing imports ${ENTRY}`); continue; }
      if (to.folder === "") { // a top-level file (prompts-page.js)
        if (from.folder !== "") fail(f, line, "direction", `${spec}: ${from.folder}/ (${TIER_NAME(fromTier ?? 0)}) imports ${to.rest} (top level), which sits above it`);
        continue;
      }
      if (to.folder === from.folder) {
        if (to.rest === "index.js" && f !== `${to.folder}/index.js`) fail(f, line, "self-index", `${spec}: a file in ${to.folder}/ imports its own folder's index.js (import the sibling file directly)`);
        continue;
      }
      if (DATA_FOLDERS.includes(to.folder)) continue;
      if (to.rest !== "index.js") fail(f, line, "deep-import", `${spec}: import ${to.folder}/index.js, not what is inside ${to.folder}/`);
      const toTier = TIER_OF.get(to.folder);
      if (from.folder !== "" && fromTier !== undefined && toTier !== undefined) {
        edges.push({ from: from.folder, to: to.folder, file: f, line });
        if (toTier === fromTier) fail(f, line, "sibling", `${spec}: ${from.folder}/ imports ${to.folder}/, which is of the same tier (${TIER_NAME(fromTier)})`);
        else if (toTier < fromTier) fail(f, line, "direction", `${spec}: ${from.folder}/ (${TIER_NAME(fromTier)}) imports ${to.folder}/ (${TIER_NAME(toTier)}), which sits above it`);
      }
    }
  }

  // Cycles between folders: strongly connected groups of more than one folder (Tarjan), reported at their first edge.
  const graph = new Map();
  for (const e of edges) { if (!graph.has(e.from)) graph.set(e.from, new Set()); graph.get(e.from).add(e.to); }
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const groups = [];
  const connect = (v) => {
    index.set(v, counter); low.set(v, counter); counter++;
    stack.push(v); onStack.add(v);
    for (const w of [...(graph.get(v) ?? [])].sort()) {
      if (!index.has(w)) { connect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const group = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); group.push(w); } while (w !== v);
      if (group.length > 1) groups.push(group.sort());
    }
  };
  for (const v of [...graph.keys()].sort()) if (!index.has(v)) connect(v);
  for (const group of groups) {
    const inside = edges.filter((e) => group.includes(e.from) && group.includes(e.to))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    fail(inside[0].file, inside[0].line, "cycle", `folders import each other in a circle: ${group.join(", ")}`);
  }

  const seen = new Set();
  return failures
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.message < b.message ? -1 : a.message > b.message ? 1 : 0)))
    .filter((f) => { const k = `${f.file}:${f.line}:${f.rule}:${f.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export const formatFailure = (f, prefix = "") => `${prefix}${f.file}${f.line ? `:${f.line}` : ""}  [${f.rule}]  ${f.message}`;

function main() {
  const root = path.resolve(process.argv[2] ?? path.join(REPO, "mods", "github-tasks"));
  if (!existsSync(root)) { console.log(`no such folder: ${root}`); process.exit(1); }
  const prefix = (() => { const r = posix(path.relative(REPO, root)); return r.startsWith("..") ? `${root}/` : r ? `${r}/` : ""; })();
  const failures = checkLayout(root);
  for (const f of failures) console.log(formatFailure(f, prefix));
  if (failures.length) { console.log(`\n${failures.length} layout problem${failures.length === 1 ? "" : "s"} found. Folders are public through index.js and stack downward only.`); process.exit(1); }
  console.log("ok: the layout holds");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
