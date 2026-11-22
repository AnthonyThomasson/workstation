// Every named import of a relative module must be something that module exports. node --test only loads the files a test imports,
// and the files that import "herdr" are never loaded under node, so a wrong name (an import from the wrong index.js) would only fail
// when Herdr loads the mod. This reads every .js file of the mod with the vendored acorn and follows `export * from` and
// `export { … } from` re-exports, so index.js files are judged by what they really export. Nothing is run.
import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "../../../tests/vendor/acorn/acorn.mjs";

const MOD = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const posix = (p) => p.split(path.sep).join("/");

// Every .js file under dir (symlinks not followed), as posix paths relative to it.
function walk(dir, base = dir) {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === ".git") continue;
    const full = path.join(dir, name), st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) found.push(...walk(full, base));
    else if (name.endsWith(".js")) found.push(posix(path.relative(base, full)));
  }
  return found;
}

// The names a binding pattern declares ("export const { a, b: [c] } = x").
function patternNames(node, out = []) {
  if (!node) return out;
  if (node.type === "Identifier") out.push(node.name);
  else if (node.type === "ObjectPattern") for (const p of node.properties) patternNames(p.type === "RestElement" ? p.argument : p.value, out);
  else if (node.type === "ArrayPattern") for (const e of node.elements) patternNames(e, out);
  else if (node.type === "AssignmentPattern") patternNames(node.left, out);
  else if (node.type === "RestElement") patternNames(node.argument, out);
  return out;
}

const nameOf = (n) => n.name ?? String(n.value);
const resolve = (from, spec) => path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));

// files: { "<posix path>": source }. -> a list of problems ("file:line: …"): a named import, or a named re-export, of a relative
// module that doesn't export that name, or of a module that isn't in files. Only relative .js imports are judged.
export function importProblems(files) {
  const parsed = new Map();
  const ast = (file) => {
    if (!parsed.has(file)) parsed.set(file, acorn.parse(files[file], { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true }));
    return parsed.get(file);
  };
  const exportsOf = (file, seen = new Set()) => {
    const names = new Set();
    if (seen.has(file) || !(file in files)) return names;
    seen.add(file);
    for (const node of ast(file).body) {
      if (node.type === "ExportDefaultDeclaration") names.add("default");
      else if (node.type === "ExportAllDeclaration") {
        if (node.exported) names.add(nameOf(node.exported));
        else for (const n of exportsOf(resolve(file, node.source.value), seen)) if (n !== "default") names.add(n);
      } else if (node.type === "ExportNamedDeclaration") {
        const d = node.declaration;
        if (d?.id) names.add(d.id.name);
        for (const decl of d?.declarations ?? []) for (const n of patternNames(decl.id)) names.add(n);
        for (const s of node.specifiers) names.add(nameOf(s.exported));
      }
    }
    return names;
  };
  const problems = [];
  for (const file of Object.keys(files).sort()) {
    for (const node of ast(file).body) {
      const spec = node.source?.value;
      if ((node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration") || typeof spec !== "string" || !spec.startsWith(".") || !spec.endsWith(".js")) continue;
      const target = resolve(file, spec);
      const where = `${file}:${node.loc.start.line}`;
      if (!(target in files)) { problems.push(`${where}: ${spec} isn't a file of the mod`); continue; }
      const have = exportsOf(target);
      const wanted = node.type === "ImportDeclaration"
        ? node.specifiers.flatMap((s) => (s.type === "ImportSpecifier" ? [nameOf(s.imported)] : s.type === "ImportDefaultSpecifier" ? ["default"] : []))
        : node.specifiers.map((s) => nameOf(s.local));
      for (const name of wanted) if (!have.has(name)) problems.push(`${where}: ${name} is not exported by ${spec} (${target})`);
    }
  }
  return problems;
}

test("every named import of the mod's own files is exported by the file it names", () => {
  const files = Object.fromEntries(walk(MOD).map((f) => [f, readFileSync(path.join(MOD, f), "utf8")]));
  assert.ok(Object.keys(files).length > 100, "the mod's files were found");
  assert.deepEqual(importProblems(files), []);
});

test("self-test: a name from the wrong index.js, a missing file and a bad re-export are found; re-exports are followed", () => {
  const files = {
    "a/index.js": 'export * from "./one.js";\nexport { two, three as tres } from "./two.js";\nexport * as ns from "./one.js";\nexport { default as D } from "./def.js";',
    "a/one.js": "export const one = 1;\nexport function fn() {}\nexport class K {}\nexport const { p, q: [r] } = x;\nexport default 5;",
    "a/two.js": "const two = 1, three = 2;\nexport { two, three };",
    "a/def.js": "export default 1;",
    "b/ok.js": 'import { one, fn, K, p, r, two, tres, ns, D } from "../a/index.js";\nimport def from "../a/def.js";\nimport * as all from "../a/one.js";\nimport { readFile } from "node:fs";\nimport { x } from "herdr";',
    "b/bad.js": 'import { one, nope } from "../a/index.js";\nimport { gone } from "../c/index.js";\nexport { missing } from "../a/two.js";\nimport { default as d2 } from "../a/two.js";',
  };
  assert.deepEqual(importProblems(files), [
    "b/bad.js:1: nope is not exported by ../a/index.js (a/index.js)",
    "b/bad.js:2: ../c/index.js isn't a file of the mod",
    "b/bad.js:3: missing is not exported by ../a/two.js (a/two.js)",
    "b/bad.js:4: default is not exported by ../a/two.js (a/two.js)",
  ]);
});
