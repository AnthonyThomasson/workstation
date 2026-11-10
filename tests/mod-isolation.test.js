// Checks that no mod depends on another: every .js file under mods/ is parsed (with the vendored, pinned acorn in
// tests/vendor/acorn/) and any link from one mod to another is reported with file:line and the rule it breaks.
// Run from anywhere with: node tests/mod-isolation.test.js [mods-folder]   (default: the repo's mods/)
// The fixtures test, tests/mod-isolation.fixtures.test.js, runs this check on tests/fixtures/mods/.
// No npm install; the same code always gives the same result (sorted walk, sorted output). Exit 1 on any failure.
//
// The rules (what counts as a link):
//   import     a relative import (also export-from and import()) that resolves into another mod's folder.
//   file-path  a "mods/<name>/..." string or template literal, where <name> is not this mod.
//   overlay    openOverlay({ mod: <name> }) where <name> is not this mod.
//   shared-key a key given to shared() / setShared() (imported from "herdr") must start with "<mod>.". The check
//              follows the key through consts, small functions, imports, re-exports and loop constants of the same mod.
//              shared/setShared handed on as a value ({ get: shared }, f(shared), or (k) => shared(k) given to a
//              function of the same mod) are followed into that function; what can't be followed fails.
//   parse      the file is not valid JavaScript.
//   symlink    a symlinked folder, broken link or .js file under mods/ (not followed: it could lead into another mod).
// Also scanned: dot-folders (not node_modules or .git). Failing as "can't follow": shared/setShared/openOverlay reached through a
// re-export, a destructured or computed use of the herdr object or import("herdr"); a mods/ path built at run time; an absolute or
// file: import. openOverlay is followed through aliases; a parameter is what each call passes (a test's own calls don't count).
// Lines: a file-path is reported on the line the matched text is on, shared-key and overlay on the offending argument or property.
// In mod code (every .js file that is not a *.test.js) a name must be this mod or on the allowlists below. In *.test.js files only the names of other
// real mods (folders under the scanned root) fail: fake names used as sample data are fine.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "./vendor/acorn/acorn.mjs";

// ---- Allowlists: what Herdr itself provides. Nothing else may be named from mod code. ----
const BUILTIN_MODS = ["pane", "files", "changes", "workspace-chrome", "menu", "new-menu"]; // Herdr's own mods (menu and new-menu: tabs-icons opens them as overlays)
const BUILTIN_KEYS = ["workspace.panels"]; // Herdr's own shared keys
// Old shared keys a mod may still read to carry saved choices over to its new key. Keep this small; drop an entry
// when its migration is removed.
const LEGACY_KEYS = {
  skills: ["skillshare.recent.v1", "skillshare.hideDisabled.v1", "skillshare.doctorIgnored.v1"],
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const SHARED_FNS = new Set(["shared", "setShared"]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const ABSOLUTE_SPEC = /^(\/|file:|[A-Za-z]:[\\/])/;
const PATH_NAME = /(?<![A-Za-z0-9_.-])mods\/([A-Za-z0-9_.-]+)/g;

// Thrown when the check can't follow a value; node (optional) is where the trail was lost, for the line number.
class Unfollow extends Error { constructor(message, node) { super(message); this.node = node; } }
const unfollow = (message, node) => { throw new Unfollow(message, node); };

const isFn = (n) => n && (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression");
const posix = (p) => p.split(path.sep).join("/");
const keyName = (prop) => (prop.computed ? null : prop.key.type === "Identifier" ? prop.key.name : typeof prop.key.value === "string" ? prop.key.value : null);

class Scope {
  constructor(parent) { this.parent = parent; this.vars = new Map(); }
  lookup(name) { for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name); return null; }
}

export function checkMods(root) {
  root = path.resolve(root);
  const failures = [];
  const cache = new Map();
  const sinks = new Set(); // calls whose first argument is a shared key
  const overlaySinks = new Set(); // calls whose first argument is an openOverlay spec
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  // A symlink to a folder (or a broken one) is not followed: it is reported, because it could lead into another mod.
  const symlinkTarget = (full) => { try { return statSync(full).isDirectory() ? "folder" : "file"; } catch { return "broken"; } };
  const realMods = new Set(readdirSync(root, { withFileTypes: true }).filter((d) => !SKIP_DIRS.has(d.name) && (d.isDirectory() || (d.isSymbolicLink() && symlinkTarget(path.join(root, d.name)) === "folder"))).map((d) => d.name));

  // ---- Reading a file: AST, scopes, bindings and the lists the rules look at ----
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const rel = posix(path.relative(root, file));
    const info = { file, rel, mod: rel.includes("/") ? rel.split("/")[0] : "", isTest: file.endsWith(".test.js"), exports: new Map(), stars: [], calls: [], strings: [], specs: [], thisMembers: [], composed: [], top: null, ast: null, error: null };
    cache.set(file, info);
    try {
      info.ast = acorn.parse(readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
    } catch (e) {
      info.error = e;
      return info;
    }
    info.top = new Scope(null);
    info.ast.info = info;
    visit(info, info.ast, null, info.top);
    return info;
  }

  const bind = (info, scope, name, binding) => { scope.vars.set(name, { info, refs: [], name, ...binding }); };

  function declarePattern(info, scope, pattern, make) {
    if (!pattern) return;
    if (pattern.type === "Identifier") bind(info, scope, pattern.name, make(pattern));
    else if (pattern.type === "ObjectPattern") for (const p of pattern.properties) declarePattern(info, scope, p.type === "RestElement" ? p.argument : p.value, () => ({ kind: "unknown" }));
    else if (pattern.type === "ArrayPattern") for (const e of pattern.elements) declarePattern(info, scope, e, () => ({ kind: "unknown" }));
    else if (pattern.type === "AssignmentPattern") declarePattern(info, scope, pattern.left, () => ({ kind: "unknown" }));
    else if (pattern.type === "RestElement") declarePattern(info, scope, pattern.argument, () => ({ kind: "unknown" }));
  }

  function declareVariables(info, scope, decl) {
    for (const d of decl.declarations) {
      if (d.id.type === "Identifier") bind(info, scope, d.id.name, decl.kind === "const" ? { kind: "const", init: d.init } : { kind: "mutable" });
      else declarePattern(info, scope, d.id, () => ({ kind: "unknown" }));
    }
  }

  function declareStatements(info, scope, body, top) {
    for (const s of body) {
      let d = s;
      if (top && (s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration")) {
        d = s.declaration;
        if (s.type === "ExportDefaultDeclaration") {
          const named = d && (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && d.id;
          const local = named ? d.id.name : "*default*";
          if (!named) bind(info, scope, local, { kind: "const", init: d });
          info.exports.set("default", { local });
        }
      }
      if (d) declareOne(info, scope, s, d, top);
      if (top && s.type === "ExportNamedDeclaration" && !s.declaration) {
        for (const sp of s.specifiers) {
          const exported = sp.exported.name ?? sp.exported.value;
          if (s.source) info.exports.set(exported, { from: s.source.value, name: sp.local.name ?? sp.local.value });
          else info.exports.set(exported, { local: sp.local.name });
        }
      }
      if (top && s.type === "ExportAllDeclaration" && !s.exported) info.stars.push(s.source.value);
    }
  }

  function declareOne(info, scope, s, d, top) {
    {
      if (d.type === "VariableDeclaration") {
        declareVariables(info, scope, d);
        if (top && s.type === "ExportNamedDeclaration") for (const dd of d.declarations) if (dd.id.type === "Identifier") info.exports.set(dd.id.name, { local: dd.id.name });
      } else if (d.type === "FunctionDeclaration" && d.id) {
        bind(info, scope, d.id.name, { kind: "function", node: d });
        if (top && s.type === "ExportNamedDeclaration") info.exports.set(d.id.name, { local: d.id.name });
      } else if (d.type === "ClassDeclaration" && d.id) {
        bind(info, scope, d.id.name, { kind: "class", node: d });
        if (top && s.type === "ExportNamedDeclaration") info.exports.set(d.id.name, { local: d.id.name });
      } else if (d.type === "ImportDeclaration") {
        for (const sp of d.specifiers) {
          const imported = sp.type === "ImportDefaultSpecifier" ? "default" : sp.type === "ImportNamespaceSpecifier" ? "*" : sp.imported.name ?? sp.imported.value;
          bind(info, scope, sp.local.name, { kind: "import", source: d.source.value, imported });
        }
      }
    }
  }

  const isTarget = (n) => {
    let c = n, p = n.parent;
    while (p) {
      if (p.type === "Property" && p.value === c && p.parent?.type === "ObjectPattern") c = p.parent;
      else if (p.type === "ArrayPattern" || p.type === "RestElement" || (p.type === "AssignmentPattern" && p.left === c)) c = p;
      else break;
      p = c.parent;
    }
    if (!p) return false;
    if (c !== n) return true;
    return (p.type === "VariableDeclarator" && p.id === c) || (isFn(p) && (p.id === c || p.params.includes(c))) || ((p.type === "ClassDeclaration" || p.type === "ClassExpression") && p.id === c) ||
      (p.type === "CatchClause" && p.param === c) || p.type.startsWith("Import") || p.type.startsWith("Export") && p.exported === c ||
      ((p.type === "ForInStatement" || p.type === "ForOfStatement") && p.left === c) || (p.type === "AssignmentExpression" && p.left === c);
  };
  const isReference = (n) => {
    const p = n.parent;
    if (!p) return false;
    if (p.type === "MemberExpression" && p.property === n && !p.computed) return false;
    if (p.type === "Property" && p.key === n && !p.computed && !(p.shorthand && p.value === n && p.parent.type === "ObjectExpression")) return false;
    if ((p.type === "MethodDefinition" || p.type === "PropertyDefinition") && p.key === n && !p.computed) return false;
    if (p.type === "LabeledStatement" || p.type === "BreakStatement" || p.type === "ContinueStatement") return false;
    if (p.type === "ExportSpecifier") return p.local === n && !p.parent.source;
    return !isTarget(n);
  };

  function visit(info, node, parent, scope) {
    if (node._seen) return;
    node._seen = true;
    node.parent = parent;
    node._scope = scope;
    let inner = scope;
    switch (node.type) {
      case "Program": declareStatements(info, scope, node.body, true); break;
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression":
        inner = new Scope(scope);
        node._inner = inner;
        if (node.type === "FunctionExpression" && node.id) bind(info, inner, node.id.name, { kind: "unknown" });
        node.params.forEach((p, index) => {
          if (p.type === "Identifier") bind(info, inner, p.name, { kind: "param", fn: node, index, def: null });
          else if (p.type === "AssignmentPattern" && p.left.type === "Identifier") bind(info, inner, p.left.name, { kind: "param", fn: node, index, def: p.right });
          else declarePattern(info, inner, p, () => ({ kind: "unknown" }));
        });
        break;
      case "BlockStatement":
        if (isFn(parent)) declareStatements(info, scope, node.body);
        else { inner = new Scope(scope); declareStatements(info, inner, node.body); }
        break;
      case "SwitchStatement": inner = new Scope(scope); for (const c of node.cases) declareStatements(info, inner, c.consequent); break;
      case "ForStatement": case "ForInStatement": case "ForOfStatement": {
        inner = new Scope(scope);
        const decl = node.type === "ForStatement" ? node.init : node.left;
        if (decl?.type === "VariableDeclaration") {
          if (node.type === "ForOfStatement" && decl.kind === "const") {
            const id = decl.declarations[0].id;
            if (id.type === "Identifier") bind(info, inner, id.name, { kind: "iter", iterable: node.right, path: [] });
            else if (id.type === "ArrayPattern") id.elements.forEach((e, i) => { if (e?.type === "Identifier") bind(info, inner, e.name, { kind: "iter", iterable: node.right, path: [i] }); else declarePattern(info, inner, e, () => ({ kind: "unknown" })); });
            else declarePattern(info, inner, id, () => ({ kind: "unknown" }));
          } else declareVariables(info, inner, decl);
        }
        break;
      }
      case "CatchClause": inner = new Scope(scope); declarePattern(info, inner, node.param, () => ({ kind: "unknown" })); break;
      case "Identifier":
        if (isReference(node)) {
          const b = scope.lookup(node.name);
          if (b) { b.refs.push(node); node._binding = b; }
        }
        break;
      case "CallExpression": case "NewExpression": info.calls.push(node); break;
      case "MemberExpression": if (node.object.type === "ThisExpression" && !node.computed) info.thisMembers.push(node); break;
      case "Literal": if (typeof node.value === "string") info.strings.push({ node, text: node.value, whole: true }); break;
      case "TemplateLiteral": if (node.expressions.length) info.composed.push(node); node.quasis.forEach((q, i) => info.strings.push({ node: q, text: q.value.cooked ?? q.value.raw, whole: i === node.quasis.length - 1, dynamicNext: i < node.quasis.length - 1 })); break;
      case "BinaryExpression": if (node.operator === "+") info.composed.push(node); break;
      case "ImportDeclaration": case "ExportAllDeclaration": info.specs.push({ node, spec: node.source.value }); break;
      case "ExportNamedDeclaration": if (node.source) info.specs.push({ node, spec: node.source.value }); break;
      case "ImportExpression": info.specs.push({ node, spec: node.source.type === "Literal" && typeof node.source.value === "string" ? node.source.value : null }); break;
      default:
    }
    for (const k of Object.keys(node)) {
      if (k === "parent" || k === "_scope" || k === "_inner" || k === "_binding" || k === "loc") continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") visit(info, c, node, inner); }
      else if (v && typeof v.type === "string") visit(info, v, node, inner);
    }
  }

  const infoOf = (node) => { let n = node; while (n.parent) n = n.parent; return n.info; };
  const lineOf = (node) => node.loc.start.line;
  const snippet = (info, node) => { const t = readSource(info).slice(node.start, node.end).replace(/\s+/g, " "); return t.length > 40 ? `${t.slice(0, 37)}...` : t; };
  const sources = new Map();
  const readSource = (info) => { if (!sources.has(info.file)) sources.set(info.file, readFileSync(info.file, "utf8")); return sources.get(info.file); };

  const fail = (info, node, rule, name, message, line = lineOf(node)) => failures.push({ file: info.rel, line, col: node.loc.start.column, rule, name, message });
  // A name the check can't pin down fails in mod code; in tests only a certain link counts.
  const failUnfollowed = (info, node, rule, name, message, line) => { if (!info.isTest) fail(info, node, rule, name, message, line); };

  // ---- Names ----
  // null when the name is fine, else why not.
  function judgeName(info, name) {
    if (name === info.mod) return null;
    if (info.isTest) return realMods.has(name) ? `names another mod, "${name}"` : null;
    if (BUILTIN_MODS.includes(name)) return null;
    return realMods.has(name) ? `names another mod, "${name}"` : `"${name}" is not this mod ("${info.mod}") or a Herdr built-in`;
  }

  // ---- Modules, bindings and values ----
  function resolveFile(info, spec) {
    if (!spec.startsWith("./") && !spec.startsWith("../")) unfollow(`"${spec}" is not a relative import`);
    const base = path.resolve(path.dirname(info.file), spec);
    const own = path.join(root, info.mod) + path.sep;
    for (const f of [base, `${base}.js`, path.join(base, "index.js")]) {
      if (!f.startsWith(own)) unfollow(`"${spec}" is outside this mod`);
      try { readdirSync(path.dirname(f)).includes(path.basename(f)) && readFileSync(f); return f; } catch { /* try the next spelling */ }
    }
    return unfollow(`"${spec}" was not found`);
  }

  function exported(info, name, seen = new Set()) {
    if (seen.has(info.file + "|" + name)) unfollow(`export "${name}" loops`);
    seen.add(info.file + "|" + name);
    if (info.error) unfollow("the file does not parse");
    const e = info.exports.get(name);
    if (e?.local) return info.top.vars.get(e.local) ?? unfollow(`"${e.local}" is not declared`);
    if (e?.from) return exported(load(resolveFile(info, e.from)), e.name, seen);
    for (const s of info.stars) { try { return exported(load(resolveFile(info, s)), name, seen); } catch (err) { if (!(err instanceof Unfollow)) throw err; } }
    return unfollow(`"${name}" is not exported from ${info.rel}`);
  }

  // Follows imports (and re-exports) until the binding is declared in a file. A namespace import stays a namespace.
  function resolveBinding(b) {
    for (let i = 0; i < 30; i++) {
      if (b.kind !== "import") return b;
      if (b.source === "herdr") unfollow(`"${b.name}" comes from "herdr"`);
      const target = load(resolveFile(b.info, b.source));
      if (b.imported === "*") return { kind: "namespace", info: target };
      b = exported(target, b.imported);
    }
    return unfollow("imports loop");
  }

  const bindingOf = (id) => id._binding ?? unfollow(`"${id.name}" is not declared in this file`);

  function valueOfMember(m) {
    if (m.object.type !== "Identifier" || m.computed) unfollow(`${m.object.type === "Identifier" ? "computed" : "nested"} member access`);
    const ns = resolveBinding(bindingOf(m.object));
    if (ns.kind !== "namespace") unfollow(`"${m.object.name}.${m.property.name}" is not an import of this mod`);
    return exported(ns.info, m.property.name);
  }

  // The function (or class constructor) a call goes to, when it's declared in this mod.
  function targetFn(callee) {
    let b;
    if (callee.type === "Identifier") b = resolveBinding(bindingOf(callee));
    else if (callee.type === "MemberExpression") b = valueOfMember(callee);
    else return unfollow(`the called function is ${callee.type}`);
    if (b.kind === "function") return b.node;
    if (b.kind === "const" && b.init && (b.init.type === "ArrowFunctionExpression" || b.init.type === "FunctionExpression")) return b.init;
    if (b.kind === "class") {
      const ctor = b.node.body.body.find((m) => m.type === "MethodDefinition" && m.kind === "constructor");
      return ctor ? ctor.value : unfollow("the class has no constructor");
    }
    return unfollow(`"${b.name}" is not a function declared in this mod`);
  }

  const returnsOf = (fn) => {
    if (fn.body.type !== "BlockStatement") return [fn.body];
    const out = [];
    const walk = (n) => { if (n.type === "ReturnStatement" && n.argument) out.push(n.argument); if (isFn(n) && n !== fn) return; for (const k of Object.keys(n)) { if (k === "parent" || k === "_scope" || k === "_inner" || k === "_binding" || k === "loc") continue; const v = n[k]; if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c)); else if (v && typeof v.type === "string") walk(v); } };
    walk(fn.body);
    return out;
  };

  // Every string an expression can be: [{ text, partial }]; partial means only the fixed start is known.
  function keyOf(expr, depth = 0) {
    if (depth > 40) unfollow("too deep");
    const again = (e) => keyOf(e, depth + 1);
    switch (expr.type) {
      case "Literal": return typeof expr.value === "string" ? [{ text: expr.value, partial: false }] : unfollow("not a string");
      case "TemplateLiteral": {
        let alts = [{ text: "", partial: false }];
        for (let i = 0; i < expr.quasis.length; i++) {
          alts = alts.map((a) => (a.partial ? a : { text: a.text + (expr.quasis[i].value.cooked ?? ""), partial: false }));
          if (i < expr.expressions.length) {
            let next;
            try { next = again(expr.expressions[i]); } catch (e) { if (!(e instanceof Unfollow)) throw e; next = null; }
            alts = alts.flatMap((a) => (a.partial ? [a] : next ? next.map((n) => ({ text: a.text + n.text, partial: n.partial })) : [{ text: a.text, partial: true }]));
          }
        }
        return alts;
      }
      case "BinaryExpression": {
        if (expr.operator !== "+") return unfollow("not a string");
        return again(expr.left).flatMap((l) => {
          if (l.partial) return [l];
          try { return again(expr.right).map((r) => ({ text: l.text + r.text, partial: r.partial })); } catch (e) { if (!(e instanceof Unfollow)) throw e; return [{ text: l.text, partial: true }]; }
        });
      }
      case "ConditionalExpression": return [...again(expr.consequent), ...again(expr.alternate)];
      case "LogicalExpression": return expr.operator === "&&" ? unfollow("&& is not a string") : [...again(expr.left), ...again(expr.right)];
      case "SequenceExpression": return again(expr.expressions.at(-1));
      case "Identifier": case "MemberExpression": {
        const b = expr.type === "Identifier" ? resolveBinding(bindingOf(expr)) : valueOfMember(expr);
        return valueOfBinding(b, depth + 1);
      }
      case "CallExpression": {
        const fn = targetFn(expr.callee);
        const rets = returnsOf(fn);
        if (!rets.length) unfollow(`${fn.id?.name ?? "the function"} returns nothing`);
        return rets.flatMap(again);
      }
      default: return unfollow(`${expr.type} is not a string`);
    }
  }

  function valueOfBinding(b, depth) {
    b = resolveBinding(b);
    if (b.kind === "const") return b.init ? keyOf(b.init, depth) : unfollow(`"${b.name}" has no value`);
    if (b.kind === "iter") {
      const outers = arrayLiterals(b.iterable, depth + 1);
      return outers.flatMap((arr) => arr.elements.flatMap((el) => {
        if (!el || el.type === "SpreadElement") return unfollow("a list item can't be followed");
        if (b.path.length === 0) return keyOf(el, depth + 1);
        if (el.type !== "ArrayExpression") return unfollow("a list item is not a pair");
        const part = el.elements[b.path[0]];
        return part && part.type !== "SpreadElement" ? keyOf(part, depth + 1) : unfollow("a pair is missing a part");
      }));
    }
    return unfollow(`"${b.name}" is ${b.kind === "param" ? "a parameter" : b.kind === "mutable" ? "a let/var, which can change" : b.kind === "unknown" ? "destructured or a loop variable" : `a ${b.kind}`}`);
  }

  // The list literal(s) an expression is. A parameter is whatever each call passes for it (its default when a call
  // passes nothing); a call that passes something the check can't read as a list fails.
  function arrayLiterals(expr, depth) {
    if (depth > 40) unfollow("too deep");
    if (expr.type === "ArrayExpression") return [expr];
    if (expr.type === "Identifier") {
      const b = resolveBinding(bindingOf(expr));
      if (b.kind === "const" && b.init) return arrayLiterals(b.init, depth + 1);
      if (b.kind === "param") {
        const sites = callSitesOf(b.fn);
        if (!sites.length && b.def) return arrayLiterals(b.def, depth + 1);
        return sites.flatMap((site) => {
          if (site.arguments.slice(0, b.index + 1).some((a) => a.type === "SpreadElement")) return unfollow("a call spreads its arguments");
          const given = site.arguments[b.index];
          if (given) return arrayLiterals(given, depth + 1);
          return b.def ? arrayLiterals(b.def, depth + 1) : unfollow("a call passes nothing for the list");
        });
      }
    }
    return unfollow("a list that is not written out");
  }

  // Every call of a function declared in this mod (a function declaration or a const arrow/function), also from other
  // files of the mod when it is exported (not from tests). A function used as a plain value has callers the check can't see.
  function callSitesOf(fn) {
    const name = fn.type === "FunctionDeclaration" ? fn.id?.name : fn.parent?.type === "VariableDeclarator" ? fn.parent.id.name : "the function";
    return usesOf(fn).map((ref) => (ref.parent.type === "CallExpression" || ref.parent.type === "NewExpression") && ref.parent.callee === ref ? ref.parent : unfollow(`"${name}" is used as a value, so its callers are unknown`));
  }

  // Every place a function declared in this mod is named: the references in its file, and when it is exported the
  // references in the importing files (a namespace import's `ns.fn` counts as one). Tests are left out.
  function usesOf(fn) {
    const info = infoOf(fn);
    const name = fn.type === "FunctionDeclaration" ? fn.id?.name : fn.parent?.type === "VariableDeclarator" && fn.parent.init === fn && fn.parent.id.type === "Identifier" ? fn.parent.id.name : null;
    if (!name) unfollow("the function has no name, so its callers are unknown");
    const b = fn._scope.lookup(name);
    if (!b) unfollow(`"${name}" is not declared`);
    const refs = [];
    for (const ref of b.refs) {
      if (ref.parent.type === "ExportSpecifier") continue; // exports are followed through the importing files below
      if (ref.parent.type === "ExportDefaultDeclaration") unfollow("the function is a default export");
      refs.push(ref);
    }
    if (info.top.vars.get(name) === b && [...info.exports.values()].some((e) => e.local === name)) {
      for (const other of cache.values()) {
        if (other === info || other.error || !other.top || (other.isTest && !info.isTest)) continue; // a test calls it with its own sample data
        for (const v of other.top.vars.values()) {
          if (v.kind !== "import" || !v.source.startsWith(".")) continue;
          let target;
          try { target = resolveBinding(v); } catch (e) { if (!(e instanceof Unfollow)) throw e; continue; }
          if (target === b) refs.push(...v.refs);
          else if (target.kind === "namespace" && target.info === info) {
            for (const ref of v.refs) {
              const m = ref.parent;
              if (m.type !== "MemberExpression" || m.object !== ref || m.computed) unfollow("a namespace import is used as a value");
              let hit = false;
              try { hit = exported(info, m.property.name) === b; } catch (e) { if (!(e instanceof Unfollow)) throw e; }
              if (hit) refs.push(m);
            }
          }
        }
      }
    }
    return refs;
  }

  // ---- Following shared/setShared (and functions that pass a key on) to where the key is given ----
  // R is a node whose value is the thing being followed; path says where inside it the function is
  // (["get"] means R.get). Every call found on the way is added to sinks. Throws Unfollow when the trail is lost.
  const followed = new WeakMap();
  function followRef(R, path, kind = "shared") {
    const id = `${kind}:${path.join(".")}`;
    if (!followed.has(R)) followed.set(R, new Set());
    if (followed.get(R).has(id)) return;
    followed.get(R).add(id);
    const info = infoOf(R);
    if (R.type === "FunctionDeclaration") {
      if (path.length) unfollow("a function with properties");
      for (const ref of usesOf(R)) followRef(ref, path, kind);
      return;
    }
    const p = R.parent;
    const refsOf = (b) => { for (const ref of b.refs) followRef(ref, path, kind); };
    switch (p?.type) {
      case "CallExpression": case "NewExpression": {
        if (p.callee === R) { if (path.length) unfollow("called, but it is an object"); (kind === "overlay" ? overlaySinks : sinks).add(p); return; }
        const j = p.arguments.indexOf(R);
        if (j < 0) unfollow("used in a way the check can't follow");
        const fn = targetFn(p.callee);
        if (infoOf(fn).mod !== info.mod) unfollow("handed to a function of another mod");
        bindParam(fn, fn.params[j], path, j, kind);
        return;
      }
      case "MemberExpression":
        if (p.object === R && !p.computed && path.length) { if (p.property.name === path[0]) followRef(p, path.slice(1), kind); return; } // another property is none of our business
        return unfollow("read in a way the check can't follow");
      case "SpreadElement":
        if (path.length && p.parent.type === "ObjectExpression") { followRef(p.parent, path, kind); return; } // { ...it } keeps its properties
        return unfollow("spread in a way the check can't follow");
      case "Property":
        if (p.value === R && p.parent.type === "ObjectExpression" && keyName(p)) { followRef(p.parent, [keyName(p), ...path], kind); return; }
        return unfollow("used in a way the check can't follow");
      case "AssignmentExpression": {
        const l = p.left;
        if (p.right === R && l.type === "MemberExpression" && l.object.type === "ThisExpression" && !l.computed) {
          let cls = p;
          while (cls && cls.type !== "ClassDeclaration" && cls.type !== "ClassExpression") cls = cls.parent;
          if (!cls) unfollow("stored in a field outside a class");
          for (const m of info.thisMembers) {
            if (m.property.name !== l.property.name || m === l) continue;
            let a = m; while (a && a !== cls) a = a.parent;
            if (a) followRef(m, path, kind);
          }
          return;
        }
        return unfollow("assigned in a way the check can't follow");
      }
      case "VariableDeclarator":
        if (p.init === R && p.id.type === "Identifier") {
          const b = R._scope.lookup(p.id.name);
          if (isFn(R) && b?.kind === "const") { for (const ref of usesOf(R)) followRef(ref, path, kind); return; } // exported or not, its users are followed
          if ([...info.exports.values()].some((e) => e.local === p.id.name)) unfollow("exported, so used by code the check doesn't see");
          if (b?.kind === "const") { refsOf(b); return; }
        }
        return unfollow("kept in a variable the check can't follow");
      default: return unfollow("used in a way the check can't follow");
    }
  }

  function bindParam(fn, param, path, index, kind) {
    if (!param) unfollow(`the function has no parameter ${index + 1}`);
    if (param.type === "AssignmentPattern") param = param.left;
    if (param.type === "Identifier") { for (const ref of fn._inner.vars.get(param.name)?.refs ?? []) followRef(ref, path, kind); return; }
    if (param.type === "ObjectPattern") {
      if (!path.length) unfollow("the function takes it apart");
      for (const prop of param.properties) {
        if (prop.type === "RestElement") unfollow("the function takes the rest of an object");
        if (keyName(prop) === path[0]) { bindParam(fn, prop.value, path.slice(1), index, kind); return; }
      }
      return;
    }
    return unfollow("the function takes the parameter apart");
  }

  function followFrom(info, node, name, kind = "shared") {
    try { followRef(node, [], kind); } catch (e) { if (!(e instanceof Unfollow)) throw e; failUnfollowed(info, node, kind === "overlay" ? "overlay" : "shared-key", name, `${name} is handed on and the check can't follow it: ${e.message}`); }
  }

  // ---- The rules, file by file ----
  function checkKey(info, call) {
    const arg = call.arguments[0];
    if (!arg || arg.type === "SpreadElement") return failUnfollowed(info, arg ?? call, "shared-key", "(no key)", "the key is missing or spread, so the check can't follow it");
    // A function that forwards its own first parameter as the key: follow who calls it.
    if (arg.type === "Identifier" && arg._binding?.kind === "param") {
      const b = arg._binding;
      if (b.index === 0 && isFn(b.fn) && b.fn.params[0].type === "Identifier") {
        const before = new Set(sinks);
        try { followRef(b.fn, []); return; } catch (e) { if (!(e instanceof Unfollow)) throw e; for (const s of [...sinks]) if (!before.has(s)) sinks.delete(s); return failUnfollowed(info, arg, "shared-key", arg.name, `key "${arg.name}" is a parameter whose callers the check can't follow: ${e.message}`); }
      }
    }
    let alts;
    try { alts = keyOf(arg); } catch (e) { if (!(e instanceof Unfollow)) throw e; return failUnfollowed(info, arg, "shared-key", snippet(info, arg), `the key \`${snippet(info, arg)}\` can't be followed to a string: ${e.message}`); }
    for (const a of alts) {
      const shown = a.partial ? (a.text ? `${a.text}...` : "(built at run time)") : a.text;
      if (info.isTest) {
        const first = a.text.includes(".") ? a.text.slice(0, a.text.indexOf(".")) : null;
        if (first && first !== info.mod && realMods.has(first)) fail(info, arg, "shared-key", shown, `key "${shown}" names another mod, "${first}"`);
      } else if (!(a.text.startsWith(`${info.mod}.`) || (!a.partial && (BUILTIN_KEYS.includes(a.text) || (LEGACY_KEYS[info.mod] ?? []).includes(a.text))))) {
        fail(info, arg, "shared-key", shown, `key "${shown}" must start with "${info.mod}."${a.partial ? " (only its start is known)" : ""}`);
      }
    }
  }

  function objectsOf(expr, depth = 0) {
    if (depth > 20) unfollow("too deep");
    switch (expr.type) {
      case "ObjectExpression": return [expr];
      case "ConditionalExpression": return [...objectsOf(expr.consequent, depth + 1), ...objectsOf(expr.alternate, depth + 1)];
      case "Identifier": { const b = resolveBinding(bindingOf(expr)); return b.kind === "const" && b.init ? objectsOf(b.init, depth + 1) : unfollow(`"${expr.name}" is not a const object`); }
      case "CallExpression": return returnsOf(targetFn(expr.callee)).flatMap((r) => objectsOf(r, depth + 1));
      default: return unfollow(`${expr.type} is not an object written out`);
    }
  }

  // The `mod` property of an object written out: a computed key counts when it is the string "mod"; one the check can't read
  // might be it, so it fails. null when there is none.
  function modProperty(obj) {
    let found = null;
    for (const p of obj.properties) {
      if (p.type !== "Property") continue;
      if (!p.computed) { if (keyName(p) === "mod") found = p; continue; }
      let names;
      try { names = keyOf(p.key); } catch (e) { if (!(e instanceof Unfollow)) throw e; unfollow("a computed key may be \"mod\" and can't be followed", p); }
      if (names.some((n) => n.partial)) unfollow("a computed key built at run time may be \"mod\"", p);
      if (names.some((n) => n.text === "mod")) { if (names.length > 1) unfollow("a computed key may be \"mod\"", p); found = p; }
    }
    return found;
  }

  function checkOverlay(info, call) {
    const arg = call.arguments[0];
    if (!arg) return;
    try {
      for (const obj of objectsOf(arg)) {
        const prop = modProperty(obj);
        if (!prop) { if (obj.properties.some((p) => p.type === "SpreadElement")) unfollow("the object is spread, so its mod is unknown"); continue; }
        const where = infoOf(prop) === info ? prop.value : arg;
        for (const a of keyOf(prop.value)) {
          if (a.partial) unfollow("the mod name is built at run time", where);
          const why = judgeName(info, a.text);
          if (why) fail(info, where, "overlay", a.text, `openOverlay ${why}`);
        }
      }
    } catch (e) { if (!(e instanceof Unfollow)) throw e; failUnfollowed(info, e.node && infoOf(e.node) === info ? e.node : arg, "overlay", snippet(info, arg), `openOverlay's mod can't be followed to a name: ${e.message}`); }
  }

  const raw = (info, node) => readSource(info).slice(node.start, node.end);
  const lineIn = (node, text, at) => node.loc.start.line + (text.slice(0, at).match(/\n/g)?.length ?? 0);

  // Judges the "mods/<name>" in a piece of text: [{ name, why, text }] for a name that fails, and { run: true, text } for a "mods/"
  // whose name is still to come. partial: more text is added at run time; trailing: a "mods/" at the very end counts as one.
  function pathHits(info, text, partial, trailing = false) {
    const hits = [];
    if ((partial || trailing) && /(?<![A-Za-z0-9_.-])mods\/$/.test(text)) hits.push({ run: true, text: "mods/", last: true });
    for (const m of text.matchAll(PATH_NAME)) {
      const end = m.index + m[0].length;
      if (end === text.length) { if (partial) { hits.push({ run: true, text: m[0] }); continue; } } else if (text[end] !== "/") continue;
      const why = judgeName(info, m[1]);
      if (why) hits.push({ name: m[1], why, text: m[0] });
    }
    return hits;
  }
  const RUN_TIME = "a mods/ path whose mod name is built at run time";

  function checkFile(info) {
    if (info.error) { failures.push({ file: info.rel, line: info.error.loc?.line ?? 1, col: info.error.loc?.column ?? 0, rule: "parse", name: info.rel, message: `not valid JavaScript: ${info.error.message}` }); return; }
    // imports
    for (const { node, spec } of info.specs) {
      if (spec === null) { failUnfollowed(info, node, "import", "import(...)", "a dynamic import the check can't follow"); continue; }
      if (spec === "herdr") {
        // shared/setShared/openOverlay reached through these can't be followed
        if (node.type === "ImportExpression") failUnfollowed(info, node, "shared-key", "herdr", 'import("herdr") hands out shared/setShared/openOverlay in a way the check can\'t follow');
        else if (node.type === "ExportAllDeclaration") failUnfollowed(info, node, "shared-key", "herdr", 'export * from "herdr" re-exports shared/setShared/openOverlay in a way the check can\'t follow');
        else if (node.type === "ExportNamedDeclaration") for (const sp of node.specifiers) { const n = sp.local.name ?? sp.local.value; if (SHARED_FNS.has(n) || n === "openOverlay") failUnfollowed(info, sp, "shared-key", n, `${n} is re-exported from "herdr", so the check can't follow what imports it`); }
        continue;
      }
      if (ABSOLUTE_SPEC.test(spec)) {
        // An absolute path works on one machine only, and can point into another mod.
        let target = null;
        try { target = spec.startsWith("file:") ? fileURLToPath(spec) : spec; } catch { /* not a path */ }
        const rel = target ? posix(path.relative(root, path.resolve(target))) : "..";
        const name = rel.startsWith("..") ? null : rel.split("/")[0];
        const why = name ? judgeName(info, name) : null;
        if (why) fail(info, node, "import", name, `import "${spec}" ${why}`);
        else failUnfollowed(info, node, "import", spec, `import "${spec}" is an absolute path or URL, which the check can't tie to this mod`);
        continue;
      }
      if (!spec.startsWith("./") && !spec.startsWith("../") && spec !== "." && spec !== "..") continue;
      const rel = posix(path.relative(root, path.resolve(path.dirname(info.file), spec)));
      if (rel.startsWith("../") || rel === "..") continue;
      const name = rel.split("/")[0];
      const why = judgeName(info, name);
      if (why) fail(info, node, "import", name, `import "${spec}" ${why}`);
    }
    // file paths: each string piece on its own, then whole expressions that put pieces together ("mods" + "/beta")
    const pieceHits = [];
    for (const s of info.strings) {
      const text = raw(info, s.node);
      let from = 0;
      for (const h of pathHits(info, s.text, !!s.dynamicNext, true)) {
        const at = h.last ? text.lastIndexOf(h.text) : text.indexOf(h.text, from);
        if (at >= 0 && !h.last) from = at + 1;
        const line = at >= 0 ? lineIn(s.node, text, at) : undefined;
        const name = h.run ? "mods/${...}" : h.name;
        if (h.run) failUnfollowed(info, s.node, "file-path", name, RUN_TIME, line);
        else fail(info, s.node, "file-path", name, `path "mods/${name}/..." ${h.why}`, line);
        pieceHits.push({ node: s.node, name });
      }
    }
    for (const e of info.composed) {
      if ((e.parent.type === "BinaryExpression" && e.parent.operator === "+") || e.parent.type === "TemplateLiteral") continue; // the outer one covers it
      let alts;
      try { alts = keyOf(e); } catch (err) { if (!(err instanceof Unfollow)) throw err; continue; }
      const covered = new Set(pieceHits.filter((h) => h.node.start >= e.start && h.node.end <= e.end).map((h) => h.name));
      for (const a of alts) {
        for (const h of pathHits(info, a.text, a.partial)) {
          const name = h.run ? "mods/${...}" : h.name;
          if (covered.has(name)) continue;
          covered.add(name);
          if (h.run) failUnfollowed(info, e, "file-path", name, RUN_TIME);
          else fail(info, e, "file-path", name, `path "mods/${name}/..." ${h.why}`);
        }
      }
    }
    // ["mods", "beta", "x.js"].join("/")
    for (const call of info.calls) {
      const c = call.callee;
      if (call.type !== "CallExpression" || c.type !== "MemberExpression" || c.computed || c.property.name !== "join" || c.object.type !== "ArrayExpression") continue;
      const sep = call.arguments[0];
      if (!sep || sep.type !== "Literal" || sep.value !== "/") continue;
      let alts = [{ text: "", partial: false }];
      c.object.elements.forEach((el, i) => {
        let next = null;
        if (el && el.type !== "SpreadElement") { try { next = keyOf(el); } catch (err) { if (!(err instanceof Unfollow)) throw err; } }
        alts = alts.flatMap((a) => (a.partial ? [a] : next ? next.map((n) => ({ text: a.text + (i ? "/" : "") + n.text, partial: n.partial })) : [{ text: a.text + (i ? "/" : ""), partial: true }]));
      });
      const covered = new Set(pieceHits.filter((h) => h.node.start >= call.start && h.node.end <= call.end).map((h) => h.name));
      for (const a of alts) {
        for (const h of pathHits(info, a.text, a.partial)) {
          const name = h.run ? "mods/${...}" : h.name;
          if (covered.has(name)) continue;
          covered.add(name);
          if (h.run) failUnfollowed(info, call, "file-path", name, RUN_TIME);
          else fail(info, call, "file-path", name, `path "mods/${name}/..." ${h.why}`);
        }
      }
    }
    // overlays and key sinks. openOverlay is found by name, and through whatever binds it to herdr's.
    for (const call of info.calls) {
      const c = call.callee;
      const name = c.type === "Identifier" ? c.name : c.type === "MemberExpression" && !c.computed ? c.property.name : null;
      if (call.type === "CallExpression" && name === "openOverlay") overlaySinks.add(call);
    }
    const herdrFn = (refs, name, kind) => {
      for (const ref of refs) {
        if (ref.parent.type === "CallExpression" && ref.parent.callee === ref) (kind === "overlay" ? overlaySinks : sinks).add(ref.parent);
        else followFrom(info, ref, name, kind);
      }
    };
    // The whole herdr object (namespace or default import): every use is a call of a member, or one we can follow.
    const herdrObject = (refs, seen = new Set()) => {
      for (const ref of refs) {
        const p = ref.parent;
        if (p.type === "MemberExpression" && p.object === ref) {
          const key = !p.computed ? p.property.name : p.property.type === "Literal" && typeof p.property.value === "string" ? p.property.value : null;
          if (key === null) { failUnfollowed(info, p, "shared-key", "herdr", "a computed property of herdr, so the check can't tell whether it is shared/setShared/openOverlay"); continue; }
          if (SHARED_FNS.has(key) || key === "openOverlay") {
            const kind = key === "openOverlay" ? "overlay" : "shared";
            if (p.parent.type === "CallExpression" && p.parent.callee === p) (kind === "overlay" ? overlaySinks : sinks).add(p.parent);
            else followFrom(info, p, key, kind);
          }
          continue;
        }
        if (p.type === "VariableDeclarator" && p.init === ref && p.id.type === "Identifier") {
          const alias = ref._scope.lookup(p.id.name);
          if (alias?.kind === "const" && !seen.has(alias) && ![...info.exports.values()].some((e) => e.local === p.id.name)) { seen.add(alias); herdrObject(alias.refs, seen); continue; }
        }
        failUnfollowed(info, ref, "shared-key", "herdr", `herdr is used as a value (${p.type}), so the check can't follow shared/setShared/openOverlay through it`);
      }
    };
    for (const b of info.top.vars.values()) {
      if (b.kind !== "import" || b.source !== "herdr") continue;
      if (SHARED_FNS.has(b.imported)) herdrFn(b.refs, b.imported, "shared");
      else if (b.imported === "openOverlay") herdrFn(b.refs, b.imported, "overlay");
      else if (b.imported === "*" || b.imported === "default") herdrObject(b.refs);
    }
  }

  // ---- Run ----
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        // Not followed (it could lead into another mod or loop): a link to a folder, a broken link or a .js link fails.
        if (e.name.endsWith(".js") || symlinkTarget(full) !== "file") failures.push({ file: posix(path.relative(root, full)), line: 1, col: 0, rule: "symlink", name: e.name, message: "a symlink: the check doesn't follow links, and one could lead into another mod. Use a real file or folder" });
      } else if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".js")) files.push(full);
    }
  })(root);
  for (const f of files) load(f);
  for (const f of files) checkFile(cache.get(f));
  for (const call of overlaySinks) checkOverlay(infoOf(call), call);
  // Keys last: following a bare shared may add sinks from other files.
  const done = new Set();
  for (let round = 0; round < 50; round++) {
    const todo = [...sinks].filter((s) => !done.has(s));
    if (!todo.length) break;
    for (const call of todo) { done.add(call); checkKey(infoOf(call), call); }
  }

  const seen = new Set();
  return failures
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.col - b.col || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
    .filter((f) => { const k = `${f.file}:${f.line}:${f.rule}:${f.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export const formatFailure = (f, prefix = "") => `${prefix}${f.file}:${f.line}  [${f.rule}]  ${f.name}  ${f.message}`;

function main() {
  const root = path.resolve(process.argv[2] ?? path.join(REPO, "mods"));
  const prefix = (() => { const r = posix(path.relative(REPO, root)); return r.startsWith("..") ? `${root}/` : r ? `${r}/` : ""; })();
  const failures = checkMods(root);
  for (const f of failures) console.log(formatFailure(f, prefix));
  if (failures.length) { console.log(`\n${failures.length} mod link${failures.length === 1 ? "" : "s"} found. Each mod must work on its own.`); process.exit(1); }
  console.log("ok: no mod depends on another");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
