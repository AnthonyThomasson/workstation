// The small part of YAML a workflow file uses: maps, lists of strings, strings (long ones as `|` blocks),
// numbers, booleans and null. Pure, and written here because a mod has no packages to import.
// parse() also reads what a person writes by hand: comments, 'single' and "double" quotes, `>` folded
// blocks, `[a, b]` lists, and a list at the same indent as its key.

const RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i;
const PLAIN = /^[A-Za-z][^\n#:]*$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/; // a task's createdAt: plain, and read back as the same string
const plainKey = /^[A-Za-z_][\w-]*$/;

function scalar(v) {
  if (typeof v === "string") return (PLAIN.test(v) || TIMESTAMP.test(v)) && !/\s$/.test(v) && !RESERVED.test(v) ? v : JSON.stringify(v);
  if (v == null) return "null";
  return String(v);
}

function block(text, indent) {
  const body = text.replace(/\n+$/, ""), k = text.length - body.length;
  const lead = /^[\s]/.test(body) ? "2" : ""; // a first line that starts blank needs its indent said outright
  const header = `|${lead}${k === 0 ? "-" : k === 1 ? "" : "+"}`;
  const pad = " ".repeat(indent + 2);
  const lines = body.split("\n").map((l) => (l ? pad + l : ""));
  return [header, ...lines, ...Array(Math.max(0, k - 1)).fill("")];
}

// Strings that can only be written quoted: nothing but whitespace, or characters a block cannot hold.
const needsQuotes = (s) => !s.replace(/\n/g, "").trim() || /[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) || s.includes("\u2028") || s.includes("\u2029");

function emit(value, indent, top) {
  const pad = " ".repeat(indent), out = [];
  let first = true;
  for (const [key, v] of Object.entries(value)) {
    const k = plainKey.test(key) ? key : JSON.stringify(key);
    if (Array.isArray(v)) {
      if (!v.length) out.push(`${pad}${k}: []`);
      else { out.push(`${pad}${k}:`); for (const item of v) out.push(`${pad}  - ${scalar(item)}`); }
    } else if (v && typeof v === "object") {
      if (top && !first) out.push("");
      const inner = emit(v, indent + 2, false);
      if (inner.length) out.push(`${pad}${k}:`, ...inner); else out.push(`${pad}${k}: {}`);
    } else if (typeof v === "string" && v.includes("\n") && !needsQuotes(v)) {
      const [header, ...rest] = block(v, indent);
      out.push(`${pad}${k}: ${header}`, ...rest);
    } else out.push(`${pad}${k}: ${scalar(v)}`);
    first = false;
  }
  return out;
}

export const stringify = (value) => `${emit(value, 0, true).join("\n")}\n`;

// ---- reading ----

const fail = (n, message) => { throw new Error(`line ${n + 1}: ${message}`); };

function quoted(raw, n) {
  if (raw[0] === '"') {
    const m = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(raw);
    if (!m) fail(n, "a quoted string is not closed");
    try { return JSON.parse(`"${m[1]}"`); } catch { return fail(n, "a quoted string has a bad escape"); }
  }
  const m = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(raw);
  if (!m) fail(n, "a quoted string is not closed");
  return m[1].replace(/''/g, "'");
}

function plain(raw) {
  const v = raw.replace(/\s+#.*$/, "").trim();
  if (v === "" || v === "~" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function value(raw, n) {
  if (raw[0] === '"' || raw[0] === "'") return quoted(raw, n);
  if (raw.startsWith("[")) {
    const m = /^\[(.*)\]\s*(#.*)?$/.exec(raw);
    if (!m) fail(n, "a [list] is not closed");
    return m[1].trim() ? m[1].split(",").map((p) => value(p.trim(), n)) : [];
  }
  if (raw.startsWith("{")) {
    if (/^\{\s*\}\s*(#.*)?$/.test(raw)) return {};
    fail(n, "write a map on lines below its key, not in { }");
  }
  return plain(raw);
}

export function parse(source) {
  const lines = String(source).replace(/^﻿/, "").split("\n").map((l) => l.replace(/\r$/, ""));
  let i = 0;
  const blank = (l) => !l.trim() || l.trim().startsWith("#");
  const indentOf = (l) => l.length - l.trimStart().length;
  const skip = () => { while (i < lines.length && blank(lines[i])) i++; };

  function blockScalar(header, parent, n) {
    const m = /^([|>])(?:([+-])(\d)?|(\d)([+-])?)?\s*(#.*)?$/.exec(header);
    if (!m) fail(n, "bad block header");
    const folded = m[1] === ">", chomp = m[2] || m[5] || "", explicit = Number(m[3] || m[4] || 0);
    const got = [];
    while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > parent)) got.push(lines[i++]);
    const width = explicit ? parent + explicit : Math.min(...got.filter((l) => l.trim()).map(indentOf), Infinity);
    let rows = got.map((l) => (l.trim() ? l.slice(width) : ""));
    let trailing = 0;
    while (rows.length && rows[rows.length - 1] === "") { rows.pop(); trailing++; }
    if (!rows.length) return chomp === "+" ? "\n".repeat(trailing) : "";
    let text;
    if (folded) {
      text = rows.reduce((acc, row, k) => (k === 0 ? row : row === "" ? `${acc}\n` : rows[k - 1] === "" ? `${acc}${row}` : `${acc} ${row}`), "");
    } else text = rows.join("\n");
    return chomp === "-" ? text : chomp === "+" ? `${text}\n`.concat("\n".repeat(trailing)) : `${text}\n`;
  }

  function node(minIndent) {
    skip();
    if (i >= lines.length) return null;
    const line = lines[i], ind = indentOf(line);
    if (ind < minIndent) return null;
    if (/^\t/.test(line)) fail(i, "indent with spaces, not tabs");
    return /^-(\s|$)/.test(line.trimStart()) ? list(ind) : map(ind);
  }

  function list(ind) {
    const out = [];
    for (skip(); i < lines.length && indentOf(lines[i]) === ind && /^-(\s|$)/.test(lines[i].trimStart()); skip()) {
      const n = i, rest = lines[i++].trimStart().slice(1).trim();
      if (!rest || rest.startsWith("#")) out.push(node(ind + 1));
      else if (/^[^\s"'\[{][^:]*:(\s|$)/.test(rest)) fail(n, "a list of maps is not supported here");
      else out.push(value(rest, n));
    }
    return out;
  }

  function map(ind) {
    const out = {};
    for (skip(); i < lines.length; skip()) {
      const line = lines[i], n = i;
      if (indentOf(line) < ind) break;
      if (indentOf(line) > ind) fail(n, "this line is indented too far");
      const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#"'][^:]*?)\s*:(?:\s+(.*))?$/.exec(line.trim());
      if (!m) fail(n, "expected `key: value`");
      i++;
      const key = m[1][0] === '"' || m[1][0] === "'" ? quoted(m[1], n) : m[1];
      const rest = (m[2] ?? "").trim();
      if (Object.hasOwn(out, key)) fail(n, `"${key}" is written twice`);
      if (/^[|>]/.test(rest)) out[key] = blockScalar(rest, ind, n);
      else if (rest && !rest.startsWith("#")) out[key] = value(rest, n);
      else {
        skip();
        const next = i < lines.length ? lines[i] : "";
        const sameList = next && indentOf(next) === ind && /^-(\s|$)/.test(next.trimStart());
        out[key] = sameList ? list(ind) : node(ind + 1);
      }
    }
    return out;
  }

  const doc = node(0);
  skip();
  if (i < lines.length) fail(i, "unexpected text");
  return doc;
}
