// What the Targets section knows, with no Herdr and no I/O: the scripts that read skillshare, how
// their JSON becomes rows (with the "missing" and "sync" states), and the sync/diff commands. Ported
// from the skills mod's old sync code (git show 7bcf58e). The tests (targets.test.js) run under node.

// The CLI flag for a scope.
export const flag = (scope) => (scope === "project" ? "-p" : "-g");

export function parseJSON(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

export const stripAnsi = (text) => String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "");

// The last useful line of a command's output, for a notice.
export function lastLine(text) {
  return stripAnsi(text).trim().split("\n").filter((l) => l.trim()).pop()?.trim() ?? "";
}

// An error JSON ({"error": "..."}) or the last line of stderr.
export function failure(r, what) {
  const j = parseJSON(r?.stdout ?? "");
  return j?.error || lastLine(r?.stderr) || lastLine(r?.stdout) || `${what} exited with ${r?.code}`;
}

// sh -c PROJECT <name> <folder>: prints the folder only when it has a real per-project config
// (.skillshare/config.yaml). A bare skillshare/config.yaml is the global config, not a project.
export const PROJECT = '[ -f "$1/.skillshare/config.yaml" ] && printf "%s" "$1"';

// sh -c FIND_PROJECT <name> <folders...>: the first folder that is a skillshare project.
export const FIND_PROJECT = `for d in "$@"; do [ -n "$d" ] || continue; ${PROJECT.replace(/\$1/g, "$d")} && exit 0; done; true`;

// sh -c SNAPSHOT <name> <dir> <-p|-g>, run as a job (jobs.js, script mode: its args are <dir> <flag>):
// every read for one scope in one trip, each section headed "@@<name> <seconds>" so a slow command shows.
export const SNAPSHOT = `cd "$1" 2>/dev/null || cd; f=$2
run() { n=$1; shift; s=$(date +%s); out=$(skillshare "$@" "$f" 2>/dev/null); printf '@@%s %s\\n%s\\n' "$n" "$(( $(date +%s) - s ))" "$out"; }
run list list --all --json
run diff diff --json
run mcp mcp list --json
run plugins plugin list --json
run hooks hooks list --json`;

// Sections of SNAPSHOT's output, parsed, plus how long each took.
export function parseSnapshot(text) {
  const out = { took: {} };
  for (const part of String(text ?? "").split(/^@@/m).slice(1)) {
    const nl = part.indexOf("\n");
    const [name, secs] = part.slice(0, nl).split(" ");
    out[name] = parseJSON(part.slice(nl + 1));
    out.took[name] = Number(secs);
  }
  return out;
}

const shortSource = (s) => String(s ?? "").replace(/^https?:\/\//, "").replace(/\.git(\/|$)/, "$1").replace(/\/$/, "");

// Resource names the targets still need, per kind, from `diff --json`. Items a sync would not
// touch (is_sync false: local-only in a target) are left out.
export function driftFrom(diff) {
  const out = new Map();
  for (const t of diff?.targets ?? []) {
    for (const item of t.items ?? []) {
      if (!item.is_sync) continue;
      const kind = item.kind === "agent" ? "agents" : "skills";
      const key = `${kind}:${item.name.replace(/\.md$/, "")}`;
      const was = out.get(key);
      out.set(key, { action: was?.action === "modify" ? "modify" : item.action, reason: was?.reason ?? item.reason, targets: [...(was?.targets ?? []), t.name] });
    }
  }
  return out;
}

const HOOK_PENDING = ["add", "update", "remove", "adopt", "release"];

// One scope's rows for every kind. `raw` holds each command's parsed JSON (missing ones are null).
// state: "ok" | "off" | "missing" (not synced yet) | "sync" (changed since the last sync; reason says why)
// | "unknown" (a hook whose plan could not be read).
export function buildItems(scope, raw) {
  const items = [];
  const drift = driftFrom(raw.diff);

  for (const s of Array.isArray(raw.list) ? raw.list : []) {
    const kind = s.kind === "agent" ? "agents" : "skills";
    const flat = kind === "agents" ? s.name.replace(/\.md$/, "") : s.name;
    const rel = String(s.relPath ?? s.name).replace(/\.md$/, "");
    const d = drift.get(`${kind}:${flat}`);
    const item = {
      key: `${scope}:${kind}:${flat}`, kind, scope, name: flat, label: rel.split("/").pop(), rel,
      src: shortSource(s.source) || (s.repoName ? `tracked repo ${s.repoName}` : rel.includes("/") ? rel : "local"),
      disabled: Boolean(s.disabled), state: "ok",
    };
    if (item.disabled) item.state = "off";
    else if (d) { item.state = d.action === "add" ? "missing" : "sync"; item.reason = d.reason; item.targets = d.targets; }
    items.push(item);
  }

  const mcp = new Map();
  for (const c of raw.mcp?.changes ?? []) {
    const m = mcp.get(c.name) ?? { targets: [], pending: [] };
    m.targets.push(c.target);
    if (c.action && c.action !== "unchanged") m.pending.push(`${c.target}: ${c.action}`);
    mcp.set(c.name, m);
  }
  for (const [name, m] of mcp) {
    items.push({ key: `${scope}:mcp:${name}`, kind: "mcp", scope, name, label: name, src: "MCP server",
      state: m.pending.length ? "sync" : "ok", reason: m.pending.join(", "), targets: m.targets });
  }

  for (const [name, p] of Object.entries(raw.plugins?.packages ?? {})) {
    const bindings = Object.values(p.bindings ?? {});
    const pending = Object.entries(p.bindings ?? {}).filter(([, b]) => b.pending || b.sync === false).map(([t]) => t);
    items.push({ key: `${scope}:plugins:${name}`, kind: "plugins", scope, name, label: name,
      src: shortSource(p.source ?? bindings[0]?.id ?? "") || "plugin", version: p.version ?? bindings[0]?.version ?? null,
      state: pending.length ? "sync" : bindings.length ? "ok" : "missing", reason: pending.length ? `pending in ${pending.join(", ")}` : "", targets: Object.keys(p.bindings ?? {}) });
  }

  const hooks = new Map();
  const status = (id, root = "") => {
    const item = { key: `${scope}:hooks:status:${id}`, kind: "hooks", scope, root, name: "Hook status", label: "Hook status", targets: [], changes: [], declared: false, notice: true, pending: false };
    hooks.set(item.key, item);
    return item;
  };
  const hook = (root, name) => {
    const key = `${scope}:hooks:${root ? root + "/" : ""}${name}`;
    if (!hooks.has(key)) hooks.set(key, { key, kind: "hooks", scope, root, name, label: name, targets: [], changes: [], declared: false });
    return hooks.get(key);
  };
  for (const [root, source] of [["", raw.hooks?.source], ...Object.entries(raw.hooks?.source?.projects ?? {})]) {
    for (const [name, entry] of Object.entries(source?.entries ?? {})) {
      Object.assign(hook(root, name), { declared: true, disabled: entry.enabled === false, description: entry.description, targets: Object.keys(entry.bindings ?? {}) });
    }
  }
  for (const [index, c] of (raw.hooks?.plan?.changes ?? []).entries()) {
    const item = c.name ? hook(c.root ?? "", c.name) : status(index, c.root ?? "");
    if (c.target && !item.targets.includes(c.target)) item.targets.push(c.target);
    item.changes.push(c);
  }
  for (const c of raw.hooks?.plan?.changes ?? []) {
    if (!c.name && !c.target && c.action === "conflict") {
      for (const row of hooks.values()) if (!row.notice && row.root === (c.root ?? "")) row.changes.push(c);
    }
  }
  const error = raw.hooks?.error || raw.hooks?.previewError;
  if (error && Array.isArray(raw.list)) status("error");
  for (const [index, warning] of (raw.hooks?.plan?.warnings ?? []).entries()) status(`warning:${index}`).warnings = [warning];
  const changeLine = (c) => [[c.target, c.action].filter(Boolean).join(": "),
    ...new Set([c.message, c.inactiveReason].filter(Boolean))].join(" · ");
  for (const item of hooks.values()) {
    item.src = item.targets.join(", ") || "no agents";
    const pending = item.changes.filter((c) => !["unchanged", "inactive"].includes(c.action));
    item.lines = error ? (item.notice ? [error] : []) : [...item.changes.map(changeLine), ...(item.warnings ?? [])];
    item.diagnostic = Boolean(item.changes.some((c) => c.action === "inactive" || c.inactiveReason));
    const summary = pending.length ? item.changes.filter((c) => c.action !== "unchanged" || c.inactiveReason) : item.changes;
    item.reason = item.notice ? item.lines.join("; ") : summary.map(changeLine).join("; ");
    if (item.notice) {
      item.pending = item.changes.some((c) => HOOK_PENDING.includes(c.action));
      item.blocker = Boolean(error || item.changes.some((c) => c.action === "conflict"));
    }
    item.state = !raw.hooks?.plan ? "unknown" : pending.length ? "sync" : item.disabled ? "off" : "ok";
    items.push(item);
  }
  return items;
}

// The line under a row's name.
export function rowSub(item, showScope) {
  const pre = showScope ? `${item.scope} · ` : "";
  if (item.kind === "hooks") {
    const disabled = item.disabled ? "disabled · " : "";
    if (!item.notice && item.state === "unknown") return `${pre}${disabled}sync status unknown`;
    if (item.state === "sync" || item.notice || item.diagnostic) return `${pre}${disabled}${item.reason}`;
  }
  if (item.state === "missing") return `${pre}not synced yet`;
  // MCP and plugin reasons name targets; rows leave targets out, so those show in the open row only.
  if (item.state === "sync") return `${pre}${(item.kind === "skills" || item.kind === "agents" || item.kind === "hooks") && item.reason ? item.reason : "changed since last sync"}`;
  if (item.state === "off") return `${pre}disabled`;
  return `${pre}${item.src}${item.version && item.kind === "plugins" ? ` · ${item.version}` : ""}`;
}

// What an open row says beyond its subline.
export function detailLines(item) {
  const lines = [];
  if (item.rel && item.rel !== item.label) lines.push(item.rel);
  if (item.state === "missing") lines.push("Not synced yet. The next sync gives it to every target your config names.");
  if (item.state === "sync" && item.kind !== "hooks") lines.push(`Changed since the last sync${item.reason ? ` (${item.reason})` : ""}. The next sync updates your targets.`);
  if (item.state === "off" || (item.kind === "hooks" && item.disabled)) lines.push("Disabled: targets don't get it.");
  if (item.kind === "hooks") lines.push(`Agents: ${item.src}`, ...(item.description ? [item.description] : []), ...(item.root ? [`Root: ${item.root}`] : []), ...(item.lines ?? []));
  if (item.kind === "plugins") lines.push(`Source: ${item.src}`, ...(item.version ? [`Version: ${item.version}`] : []));
  if (item.kind === "plugins" || item.kind === "mcp") lines.push(item.targets?.length ? `Targets: ${item.targets.join(", ")}` : "No targets yet.");
  return lines;
}

// Only skills and agents have a per-item Diff.
export const hasDiff = (item) => (item.kind === "skills" || item.kind === "agents") && (item.state === "sync" || item.state === "missing");

// The argument list of `skillshare diff` for one item's scope.
export const diffArgs = (item) => ["diff", ...(item.kind === "agents" ? ["agents"] : []), "--stat", "--no-tui", flag(item.scope)];

// Rows by state: notices (hook status), unknown, needs sync (sync, missing), and the rest.
export function groupItems(items) {
  const by = (s) => items.filter((i) => !i.notice && s.includes(i.state)).sort((a, b) => a.label.localeCompare(b.label));
  return {
    notices: items.filter((i) => i.notice), unknown: by(["unknown"]),
    sync: by(["sync", "missing"]), ok: by(["ok", "off"]),
    pendingNotices: items.filter((i) => i.notice && i.pending),
  };
}

// What needs a sync: changed or missing rows, plus native hook files that need one.
export function needsSync(items) {
  const g = groupItems(items);
  return g.sync.length + g.pendingNotices.length;
}

// The scopes a Sync should run: those with pending work, or both when there is none to name.
export function scopesToSync(items, project) {
  const pending = [...new Set(items.filter((i) => i.state === "sync" || i.state === "missing" || i.pending).map((i) => i.scope))];
  return pending.length ? pending : project ? ["project", "global"] : ["global"];
}

// The message under a hook-status notice: its text, and for a blocker that Sync validates again.
export const noticeText = (i) => `${i.scope}${i.root ? ` · ${i.root}` : ""}: ${i.reason}${i.blocker ? " Resolve with the CLI or dashboard; Sync validates again before applying changes." : ""}`;

// The commands one scope's sync runs, in order: skillshare sync --all, then sync plugins.
export const syncCommands = (scope, plugins = true) => [
  ["sync", "--all", "--json", flag(scope)],
  ...(plugins ? [["sync", "plugins", "--json", flag(scope)]] : []),
];

export const syncDone = (scopes) => (scopes.length > 1 ? "Synced project and global" : `Synced ${scopes[0]}`);
