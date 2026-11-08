// What the panel shows, built from the skillshare CLI's JSON.
// No Herdr imports, so `node --test herdr/tests` runs it.

export const KINDS = [["skills", "Skills"], ["agents", "Agents"], ["mcp", "MCP"], ["plugins", "Plugins"], ["hooks", "Hooks"]];
export const SCOPES = [["all", "All"], ["project", "Project"], ["global", "Global"]];

// Long work runs detached, its output kept in a temp folder (out, err, code, pid) that the
// panel polls. Herdr ends an exec's whole process group when the exec returns, so the job
// gets its own: setsid where it exists (Linux), or sh job control (macOS, whose sh is bash;
// dash turns job control off without a terminal, but Linux has setsid). Never both: a job
// that already leads its group makes setsid fork and exit. The job writes its own pid once
// detached, and the starter waits for it (up to 5 s) so it is not ended before then. Herdr also
// hangs up programs that carry the exec's HC_SCOPE once the exec returns (git and gh, which
// skillshare runs, died with exit 129), so the job drops it.
const DETACH = 'unset HC_SCOPE; if command -v setsid >/dev/null 2>&1; then bg() { exec setsid "$@"; }; else set -m; bg() { exec "$@"; }; fi';
// Named so SWEEP can tell the panel's job folders from anything else in the temp folder.
const TEMP = 'd=$(mktemp -d "${TMPDIR:-/tmp}/skillshare-panel.XXXXXX")';
const READY = 'i=0; while [ ! -s "$d/pid" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; printf %s "$d"';
// sh -c START <name> <dir> <args...>: runs skillshare <args> in <dir>; prints the temp folder.
export const START = `${DETACH}; ${TEMP}; dir=$1; shift
bg sh -c 'echo $$ >"$2/pid"; cd "$1" 2>/dev/null || cd; d=$2; shift 2; skillshare "$@" >"$d/out" 2>"$d/err" </dev/null; echo $? >"$d/code"' job "$dir" "$d" "$@" >/dev/null 2>&1 </dev/null &
${READY}`;
// The same for a script of ours: sh -c START_SCRIPT <name> <dir> <script> <args...>.
export const START_SCRIPT = `${DETACH}; ${TEMP}; dir=$1; script=$2; shift 2
bg sh -c 'echo $$ >"$1/pid"; d=$1; script=$2; shift 2; sh -c "$script" snapshot "$@" >"$d/out" 2>"$d/err" </dev/null; echo $? >"$d/code"' job "$d" "$script" "$dir" "$@" >/dev/null 2>&1 </dev/null &
${READY}`;
// sh -c ALIVE <name> <temp folder>: fails when the job stopped without writing its exit code.
// A killed job nobody reaps stays a zombie (a container without init) that kill -0 still finds,
// so a zombie counts as stopped. Where ps has no -p (busybox), only kill -0 decides.
export const ALIVE = '[ -s "$1/code" ] || { p=$(cat "$1/pid" 2>/dev/null); kill -0 "$p" 2>/dev/null && ! ps -o stat= -p "$p" 2>/dev/null | grep -q Z; } || [ -s "$1/code" ]';
// The longest the panel waits for one job (jobs.js), and so how old a job folder must be before
// SWEEP may remove it.
export const JOB_MINUTES = 15;
// sh -c SWEEP: removes job folders nobody will read: a panel that closed mid-job never collects
// its result. Keeps a job that still runs and any folder changed in the last JOB_MINUTES.
export const SWEEP = `for d in "\${TMPDIR:-/tmp}"/skillshare-panel.*; do
  [ -d "$d" ] && [ -n "$(find "$d" -prune -mmin +${JOB_MINUTES})" ] || continue
  [ ! -s "$d/code" ] && sh -c '${ALIVE}' alive "$d" && continue
  rm -rf "$d"
done; exit 0`;

// sh -c SNAPSHOT <name> <dir> <-p|-g>: every read for one scope in one trip, each section headed
// "@@<name> <seconds>" so a slow command shows.
export const SNAPSHOT = `cd "$1" 2>/dev/null || cd; f=$2
run() { n=$1; shift; s=$(date +%s); out=$(skillshare "$@" "$f" 2>/dev/null); printf '@@%s %s\\n%s\\n' "$n" "$(( $(date +%s) - s ))" "$out"; }
run list list --all --json
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

// sh -c PROJECT <name> <folder>: prints the folder only when it has a real per-project config (.skillshare/config.yaml). A bare skillshare/config.yaml is the global config in global format, so it is not a project; those folders use -g.
export const PROJECT = '[ -f "$1/.skillshare/config.yaml" ] && printf "%s" "$1"';

// sh -c DISCOVER <name> <git url> [branch]: "@dir <temp folder>" (the clone is kept in <temp>/r for the
// audit step; the caller removes it), then the skill folders, one per line ("." for a skill at
// the root). The CLI's install dry-run does not list them.
export const DISCOVER = `d=$(mktemp -d)
GIT_TERMINAL_PROMPT=0 git clone -q --depth 1 \${2:+-b "$2"} "$1" "$d/r" >/dev/null 2>"$d/err" || { tail -n 1 "$d/err" >&2; rm -rf "$d"; exit 1; }
echo "@dir $d"
cd "$d/r" || exit 1
find . -name SKILL.md -not -path './.git/*' -not -path '*/node_modules/*' | sed 's|/SKILL.md$||; s|^\\./||' | sort`;

// Through START_SCRIPT: AUDIT <cwd> <temp folder> <-g|-p> <skill folders...>. One
// "@@ <folder>" line, then that folder's `skillshare audit <path> --json`, per folder.
export const AUDIT = `cd "$1" 2>/dev/null || cd; dir=$2; fl=$3; shift 3
for p; do echo "@@ $p"; skillshare audit "$dir/r/$p" --json "$fl" 2>/dev/null; echo; done`;

// ---- Parsing ----

// The CLI flag for a scope.
export const flag = (scope) => (scope === "project" ? "-p" : "-g");

export function parseJSON(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// The last useful line of a command's output, for a notice.
export function lastLine(text) {
  return String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").filter((l) => l.trim()).pop()?.trim() ?? "";
}

// An error JSON ({"error": "..."}) or the last line of stderr.
export function failure(r, what) {
  const j = parseJSON(r?.stdout ?? "");
  return j?.error || lastLine(r?.stderr) || lastLine(r?.stdout) || `${what} exited with ${r?.code}`;
}

const shortSource = (s) => String(s ?? "").replace(/^https?:\/\//, "").replace(/\.git(\/|$)/, "$1").replace(/\/$/, "");

// One scope's rows for every kind. `raw` holds each command's parsed JSON (missing ones are null).
export function buildItems(scope, raw) {
  const items = [];
  const checks = new Map();
  for (const s of raw.check?.skills ?? []) checks.set(`skills:${s.name}`, s);
  for (const s of Array.isArray(raw.checkAgents) ? raw.checkAgents : []) checks.set(`agents:${s.name}`, s);
  const behind = new Map((raw.check?.tracked_repos ?? []).map((r) => [r.name, r]));

  for (const s of Array.isArray(raw.list) ? raw.list : []) {
    const kind = s.kind === "agent" ? "agents" : "skills";
    const flat = kind === "agents" ? s.name.replace(/\.md$/, "") : s.name;
    const rel = String(s.relPath ?? s.name).replace(/\.md$/, "");
    const check = checks.get(`${kind}:${rel}`) ?? checks.get(`${kind}:${flat}`);
    const repo = s.repoName ? behind.get(s.repoName) : null;
    const item = {
      key: `${scope}:${kind}:${flat}`, kind, scope, name: flat, label: rel.split("/").pop(), rel,
      src: shortSource(check?.source ?? s.source) || (s.repoName ? `tracked repo ${s.repoName}` : rel.includes("/") ? rel : "local"),
      disabled: Boolean(s.disabled), version: check?.version ?? null, state: "ok", repo: s.repoName || null,
    };
    if (item.disabled) item.state = "off";
    else if (check?.status === "update_available" || repo?.status === "behind") {
      item.state = "update"; item.behind = repo?.behind ?? 0; item.update = repo ? repo.name : rel;
    }
    items.push(item);
  }

  const mcp = new Map();
  for (const c of raw.mcp?.changes ?? []) {
    const m = mcp.get(c.name) ?? { targets: [] };
    m.targets.push(c.target);
    mcp.set(c.name, m);
  }
  for (const [name, m] of mcp) {
    items.push({ key: `${scope}:mcp:${name}`, kind: "mcp", scope, name, label: name, src: "MCP server", state: "ok", targets: m.targets });
  }

  for (const [name, p] of Object.entries(raw.plugins?.packages ?? {})) {
    const bindings = Object.values(p.bindings ?? {});
    items.push({ key: `${scope}:plugins:${name}`, kind: "plugins", scope, name, label: name,
      src: shortSource(p.source ?? bindings[0]?.id ?? "") || "plugin", version: p.version ?? bindings[0]?.version ?? null,
      state: "ok", targets: Object.keys(p.bindings ?? {}) });
  }

  // Declared hooks, top level and per project root.
  for (const [root, source] of [["", raw.hooks?.source], ...Object.entries(raw.hooks?.source?.projects ?? {})]) {
    for (const [name, entry] of Object.entries(source?.entries ?? {})) {
      const targets = Object.keys(entry.bindings ?? {}), disabled = entry.enabled === false;
      items.push({ key: `${scope}:hooks:${root ? root + "/" : ""}${name}`, kind: "hooks", scope, root, name, label: name, declared: true, disabled,
        description: entry.description, targets, src: targets.join(", ") || "no agents", state: disabled ? "off" : "ok" });
    }
  }
  const error = raw.hooks?.error;
  if (error && Array.isArray(raw.list)) {
    items.push({ key: `${scope}:hooks:status:error`, kind: "hooks", scope, root: "", name: "Hook status", label: "Hook status", src: "", targets: [], declared: false, notice: true, reason: error, state: "ok" });
  }
  return items;
}

// Only top-level declared hooks can be changed with the panel's scoped CLI actions.
export function hookArgs(item, action) {
  if (item.kind !== "hooks" || !item.declared || item.root || !["enable", "disable", "remove"].includes(action)) return null;
  if ((action === "enable" && !item.disabled) || (action === "disable" && item.disabled)) return null;
  return ["hooks", action, item.name, item.scope === "project" ? "-p" : "-g"];
}

// The line under a row's name.
export function rowSub(item, showScope) {
  const pre = showScope ? `${item.scope} · ` : "";
  if (item.kind === "hooks" && item.disabled) return `${pre}disabled · ${item.src}`;
  if (item.state === "update") return `${pre}${item.version ? item.version.slice(0, 7) + " → newer" : "update available"}${item.behind ? ` · ↓${item.behind}` : ""}`;
  if (item.state === "off") return `${pre}disabled`;
  return `${pre}${item.src}${item.version && item.kind === "plugins" ? ` · ${item.version}` : ""}`;
}

// hideDisabled drops disabled rows.
export function filterItems(items, { scope, kind, query, hideDisabled = false }) {
  const q = String(query ?? "").trim().toLowerCase();
  return items.filter((i) => (scope === "all" || i.scope === scope) && (!kind || i.kind === kind)
    && !(hideDisabled && i.state === "off")
    && (!q || i.name.toLowerCase().includes(q) || i.src.toLowerCase().includes(q)
      || (i.kind === "hooks" && `${i.root ?? ""} ${i.reason ?? ""}`.toLowerCase().includes(q))));
}

export function groupItems(items) {
  const by = (s) => items.filter((i) => !i.notice && s.includes(i.state)).sort((a, b) => a.label.localeCompare(b.label));
  return { update: by(["update"]), ok: by(["ok", "off"]) };
}

export function counts(items) {
  const c = { all: 0, project: 0, global: 0, skills: 0, agents: 0, mcp: 0, plugins: 0, hooks: 0 };
  for (const i of items) { if (!i.notice) { c.all++; c[i.scope]++; c[i.kind]++; } }
  return c;
}

// "owner/repo", "github.com/owner/repo" or a URL → something git can clone, and whether the
// source names one skill inside the repo (then there is nothing to pick).
export function cloneUrl(source) {
  const s = String(source ?? "").trim().replace(/\/$/, "");
  if (!s) return null;
  if (/^(git@|ssh:\/\/|file:\/\/|\/|~)/.test(s)) return { url: s, single: false };
  let rest = s.replace(/^https?:\/\//, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(rest)) rest = `github.com/${rest}`;
  const parts = rest.split("/");
  if (parts.length < 3) return null;
  const repo = parts.slice(0, 3).join("/").replace(/\.git$/, "");
  const single = parts.length > 3 && !(parts[3] === "tree" && parts.length <= 5);
  const onBranch = ["tree", "blob"].includes(parts[3]);
  const path = !single ? "" : (onBranch ? parts.slice(5) : parts.slice(3)).join("/");
  return { url: `https://${repo}.git`, single, path, branch: onBranch && parts[4] ? parts[4] : "" };
}

// Skill folders → what `install --skill` takes (the folder's own name).
export function skillChoices(paths) {
  return paths.filter((p) => p && p !== ".").map((p) => ({ path: p, name: p.split("/").pop() }));
}

// The message an agent gets when asked to audit a resource.
export function auditMessage(item) {
  const flag = item.scope === "project" ? " -p" : " -g";
  const kind = item.kind === "agents" ? "agents " : "";
  return `Audit the ${item.kind === "agents" ? "agent" : "skill"} "${item.name}": run \`skillshare audit ${kind}${item.name}${flag} --json\`. Summarize any findings, then wait for me.`;
}

// DISCOVER's output → the kept clone folder and the skill folders in it.
export function parseDiscover(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const dir = lines[0]?.startsWith("@dir ") ? lines.shift().slice(5) : null;
  return { dir, paths: lines };
}

const SEVERITY = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

// AUDIT's output → whether the audit would stop the install, and the findings that stop it.
// No readable result (an older CLI) is "unknown": install still audits on its own.
export function parseAudit(text, dir) {
  const prefix = dir ? `${dir}/r/` : null;
  const findings = [], blocked = [];
  let read = 0;
  for (const part of String(text ?? "").split(/^@@ /m).slice(1)) {
    const nl = part.indexOf("\n");
    const folder = part.slice(0, nl).trim();
    const j = parseJSON(part.slice(nl + 1));
    if (!j?.results) continue;
    read++;
    for (const r of j.results) {
      if (!r.isBlocked) continue;
      const skill = folder === "." ? "." : folder.split("/").pop(); // "." is the repository root; the caller names it
      blocked.push(skill);
      for (const f of r.findings ?? []) {
        const file = prefix && String(f.file ?? "").startsWith(prefix) ? f.file.slice(prefix.length) : f.file;
        findings.push({ skill, severity: f.severity, pattern: f.pattern, file, line: f.line, snippet: f.snippet ?? f.message ?? "" });
      }
    }
  }
  findings.sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
  return { unknown: read === 0, blocked, findings };
}
