// The Test device: one Herdr machine that tickets build and test on (today a Windows desktop reached over Tailscale). Pure:
// the binding that is saved, the light that is worked out from `hc machine ls --json` alone, the one script the deep check runs
// on the device and the parser that judges what it printed. Herdr's calls (the exec, the shared state) are elsewhere
// (deep-check.js takes exec as an argument; the card and the CLI call it).
//
// There is deliberately NO timer here and none may be added: the earlier poller (exec with { on } on an interval) made
// herdr-core spike the CPU. The cheap light is computed whenever the settings page or the sidebar already refreshes, and the
// deep check runs only when a person or herdr-tasks asks for it. test-device.test.js asserts it.
import { GIT_BASH } from "../runs/index.js";
import { posixFolder } from "../workflow/index.js";
import { authIssues, parse as parseYaml, parseAuthStatus } from "../lib/index.js";

export const LEVELS = ["green", "yellow", "red"];
const isLevel = (v) => LEVELS.includes(v);
const DAY = 24 * 60 * 60 * 1000;
export const STALE_AFTER_MS = 7 * DAY; // a deep result older than this is "Last checked N days ago" (yellow)
export const MIN_FREE_KB = 10 * 1024 * 1024; // under 10 GB free is yellow

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => (typeof v === "string" ? v.trim() : "");

// "owner/name", as GitHub spells a repo: the only keys the binding keeps per repo.
export const isRepoKey = (key) => /^[\w.-]+\/[\w.-]+$/.test(String(key ?? ""));

// ---- The binding (shared state: github-tasks.testDevice) ----

function normalizeCheck(c) {
  if (!isObject(c) || !text(c.id) || !isLevel(c.level) || typeof c.message !== "string") return null;
  return { id: text(c.id), level: c.level, message: c.message, ...(text(c.fix) ? { fix: text(c.fix) } : {}) };
}

// The last deep check: { level, checks, at } (at: ms since the epoch); null when there is none or it is malformed.
export function normalizeHealth(raw) {
  if (!isObject(raw) || !isLevel(raw.level) || !Array.isArray(raw.checks) || !Number.isFinite(raw.at)) return null;
  return { level: raw.level, checks: raw.checks.map(normalizeCheck).filter(Boolean), at: raw.at };
}

// What is saved, or null (unbound) for anything malformed: not an object, no machine, an os that isn't unix or windows, no home.
// Unknown fields are dropped (a hostname, user or key is never kept), and so is a repo that doesn't look like owner/repo.
// startHere keeps only repos that have a folder, and only the ones switched on.
export function normalizeBinding(raw) {
  if (!isObject(raw)) return null;
  const machine = text(raw.machine), home = posixFolder(text(raw.home));
  if (!machine || (raw.os !== "unix" && raw.os !== "windows") || !home) return null;
  const repoRoots = {};
  if (isObject(raw.repoRoots)) {
    for (const [repo, folder] of Object.entries(raw.repoRoots)) {
      if (isRepoKey(repo) && typeof folder === "string" && posixFolder(folder.trim())) repoRoots[repo] = posixFolder(folder.trim());
    }
  }
  const startHere = {};
  if (isObject(raw.startHere)) for (const [repo, on] of Object.entries(raw.startHere)) if (on === true && repoRoots[repo]) startHere[repo] = true;
  return { machine, os: raw.os, home, repoRoots, startHere, health: normalizeHealth(raw.health) };
}

// A machine's binding as bind makes it: the probe's { os, home } cached, nothing else (no health until a check runs).
export const bindMachine = (machine, host) => normalizeBinding({ machine, os: host?.os, home: host?.home });

// The binding with this repo's folder set (an empty folder clears it, and its Start toggle with it), a toggle changed, or a deep result saved.
export function withRepoRoot(binding, repo, folder) {
  if (!binding || !isRepoKey(repo)) return binding;
  const repoRoots = { ...binding.repoRoots }, startHere = { ...binding.startHere };
  if (text(folder)) repoRoots[repo] = folder; else { delete repoRoots[repo]; delete startHere[repo]; }
  return normalizeBinding({ ...binding, repoRoots, startHere });
}
export function withStartHere(binding, repo, on) {
  if (!binding || !isRepoKey(repo)) return binding;
  return normalizeBinding({ ...binding, startHere: { ...binding.startHere, [repo]: on === true } });
}
export const withHealth = (binding, health) => (binding ? normalizeBinding({ ...binding, health }) : binding);

// The repo folder bound for a repo on the device, or null.
export const repoRootFor = (binding, repo) => binding?.repoRoots?.[repo] ?? null;
// Whether Start puts this repo's tickets on the device (the opt-in).
export const startsHere = (binding, repo) => Boolean(binding?.startHere?.[repo] && binding.repoRoots?.[repo]);

// ---- Rollup and the cheap light ----

// Any red makes red, else any yellow makes yellow, else green.
export function rollup(checks) {
  const levels = (checks ?? []).map((c) => c.level);
  return levels.includes("red") ? "red" : levels.includes("yellow") ? "yellow" : "green";
}

// `hc machine ls --json` is { machines: [...] }; the list itself is accepted too.
export const machinesFrom = (json) => (Array.isArray(json) ? json : Array.isArray(json?.machines) ? json.machines : []);

// The light from `hc machine ls --json` alone (local to herdr-core: nothing spawns on the device), plus the last deep result:
// { level, checks, checkedAt } for a binding, null when unbound. Checks only carry what the cheap rules found, or the deep ones.
//   machines: the list (or its { machines })     now: ms
export function cheapHealth(binding, machines, now = Date.now()) {
  if (!binding) return null;
  const name = binding.machine;
  const entry = machinesFrom(machines).find((m) => m?.name === name);
  const red = (id, message, fix) => ({ level: "red", checks: [{ id, level: "red", message, fix }], checkedAt: binding.health?.at ?? null });
  if (!entry) return red("machine", `\`${name}\` isn't a Herdr machine any more.`, `Unbind it, or add ${name} again with Add a machine.`);
  if (entry.state !== "connected") return red("connected", `\`${name}\` isn't connected.`, `Start Herdr on ${name} and let it connect, then reopen settings.`);
  const health = binding.health;
  const yellow = (message) => ({ level: "yellow", checks: [{ id: "checked", level: "yellow", message, fix: "Press Check to run the deep check." }], checkedAt: health?.at ?? null });
  if (!health) return yellow("Not checked yet");
  const age = now - health.at;
  if (age > STALE_AFTER_MS) return yellow(`Last checked ${Math.floor(age / DAY)} days ago`);
  return { level: health.level, checks: health.checks, checkedAt: health.at };
}

// The checks that are not green, for a tooltip or list: [{ id, level, message, fix? }], reds first.
export const failing = (health) => (health?.checks ?? []).filter((c) => c.level !== "green").sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level));

// ---- The deep check ----

// A GitHub remote's "owner/name" (https, ssh and git@ forms, with or without .git); null for anything else.
export function repoSlug(remote) {
  const m = String(remote ?? "").trim().match(/github\.com[:/]+([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// The commands the repo's config says the device needs (test_device.requires in its .herdr/config.yaml, text given): [] when none.
export function requiresFromConfig(configText) {
  let parsed;
  try { parsed = parseYaml(String(configText ?? "")); } catch { return []; }
  const list = parsed?.test_device?.requires;
  return Array.isArray(list) ? [...new Set(list.map((c) => String(c ?? "").trim()).filter((c) => /^[\w.+-]+$/.test(c)))] : [];
}

// The ONE script a deep check runs on the device (through shOn: sh on Unix, Git Bash on Windows, one spawn). Its arguments:
// $1 the repo folder ("-" when none is set: an empty argument is not relied on), then the commands to look for. It prints `dc.key=value` lines and ends with dc.done=1,
// so output that stopped early is told from one that finished. It writes nothing. The mod's installed copy is compared with the
// clone sync.json names, leaving out what mods/sync/sync.sh never copies.
export const DEEP_SCRIPT = String.raw`root=$1; [ $# -gt 0 ] && shift
[ "$root" = "-" ] && root=
printf 'dc.os=%s\n' "$(uname -s 2>/dev/null)"
if command -v git >/dev/null 2>&1; then printf 'dc.git=1\n'; else printf 'dc.git=0\n'; fi
if command -v gh >/dev/null 2>&1; then
  out=$(gh auth status -h github.com 2>&1); code=$?
  printf 'dc.gh_code=%s\n' "$code"
  printf '%s\n' "$out" | sed 's/^/dc.gh_out=/'
else
  printf 'dc.gh_code=127\n'
fi
if [ -z "$root" ]; then
  printf 'dc.repo=unset\n'
elif [ ! -d "$root" ]; then
  printf 'dc.repo=missing\n'
else
  printf 'dc.repo=found\n'
  if [ -d "$root/.git" ]; then printf 'dc.main=1\n'; else printf 'dc.main=0\n'; fi
  printf 'dc.origin=%s\n' "$(git -C "$root" remote get-url origin 2>/dev/null)"
fi
d=$root; [ -d "$d" ] || d=$HOME
printf 'dc.disk_kb=%s\n' "$(df -Pk "$d" 2>/dev/null | awk 'NR==2 {print $4}')"
for c in "$@"; do command -v "$c" >/dev/null 2>&1 || printf 'dc.missing=%s\n' "$c"; done
app=$HOME/.config/herdr-app; [ -n "$HERDR_APP_HOME" ] && app=$HERDR_APP_HOME
mod=$app/mods/github-tasks
if [ ! -d "$mod" ]; then
  printf 'dc.mods=not-installed\n'
else
  clone=$(sed -n 's/.*"repo"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$app/sync.json" 2>/dev/null | head -n 1 | sed 's/\\\\/\//g')
  if [ -z "$clone" ]; then
    printf 'dc.mods=no-sync-json\n'
  elif [ ! -d "$clone/mods/github-tasks" ]; then
    printf 'dc.mods=no-clone\n'
  else
    diffs=$(diff -rq -x .DS_Store -x gpui-kit.d.ts -x jsconfig.json -x RECIPE.md -x preview.png "$clone/mods/github-tasks" "$mod" 2>&1); rc=$?
    if [ "$rc" -eq 0 ]; then
      printf 'dc.mods=same\n'
    elif [ "$rc" -eq 1 ]; then
      printf 'dc.mods=differs\n'
      printf 'dc.mods_count=%s\n' "$(printf '%s\n' "$diffs" | wc -l | tr -d ' ')"
      printf '%s\n' "$diffs" | head -n 3 | sed 's/^/dc.mods_file=/'
    else
      printf 'dc.mods=unknown\n'
    fi
  fi
fi
printf 'dc.done=1\n'
`;

// The arguments for DEEP_SCRIPT: the repo folder ("-" when none: the script reads that as unset), then each required command.
export const deepArgs = ({ repoRoot, requires }) => [repoRoot || "-", ...(requires ?? [])];

// What the script printed -> { done, os, git, ghCode, ghOut, repo, main, origin, diskKb, missing, mods, modsCount, modsFiles }.
// CRLF (Git Bash through Windows) is read like LF, lines that aren't dc.* are ignored, and done is false unless dc.done=1 came last.
export function parseDeep(stdout) {
  const out = { done: false, os: "", git: null, ghCode: null, ghOut: [], repo: null, main: null, origin: "", diskKb: null, missing: [], mods: null, modsCount: 0, modsFiles: [] };
  for (const line of String(stdout ?? "").replace(/\r/g, "").split("\n")) {
    const m = line.match(/^dc\.([a-z_]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    switch (key) {
      case "os": out.os = value.trim(); break;
      case "git": out.git = value === "1"; break;
      case "gh_code": out.ghCode = Number.parseInt(value, 10); break;
      case "gh_out": out.ghOut.push(value); break;
      case "repo": out.repo = value.trim(); break;
      case "main": out.main = value === "1"; break;
      case "origin": out.origin = value.trim(); break;
      case "disk_kb": out.diskKb = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null; break;
      case "missing": if (value.trim()) out.missing.push(value.trim()); break;
      case "mods": out.mods = value.trim(); break;
      case "mods_count": out.modsCount = Number.parseInt(value, 10) || 0; break;
      case "mods_file": out.modsFiles.push(value.trim()); break;
      case "done": out.done = value.trim() === "1"; break;
      default: break;
    }
  }
  return out;
}

const GB = (kb) => `${(kb / 1024 / 1024).toFixed(1)} GB`;

// The failed probe (Herdr's exec couldn't run sh or Git Bash there) as a check: red, since nothing else can be known.
export function probeFailure(machine, error) {
  const why = String(error?.message ?? error ?? "").trim().split("\n")[0];
  return {
    id: "probe", level: "red", message: `Couldn't run anything on \`${machine}\`${why ? `: ${why}` : "."}`,
    fix: `Make sure Herdr is running and connected on ${machine}, and that Git for Windows is installed at ${GIT_BASH} if it is a Windows machine.`,
  };
}

// The deep check's checks: [{ id, level, message, fix? }], from what the script printed (`run`: { code, stdout, stderr }).
// input: { machine, repo ("owner/name"), repoRoot (the folder bound for it, or null), requires }. Output that stopped early is red,
// never green. A passing group is one green check (repo, git, gh, disk, requires, mods).
export function deepChecks({ machine, repo, repoRoot, requires = [] }, run) {
  const p = parseDeep(run?.stdout);
  if (!p.done) {
    const why = String(run?.stderr ?? "").trim().split("\n")[0];
    return [{ id: "output", level: "red", message: `The check on \`${machine}\` didn't finish${why ? `: ${why}` : "."}`, fix: `Press Check again; if it keeps failing, restart Herdr on ${machine}.` }];
  }
  const checks = [];
  const add = (id, level, message, fix) => checks.push({ id, level, message, ...(fix ? { fix } : {}) });

  // red: the repo folder
  const folder = repoRoot ?? "";
  const set = `Set "Repo folder on ${machine}" to where ${repo ?? "the repo"} is cloned (its main checkout).`;
  if (p.repo === "unset" || !folder) add("repo-folder", "red", `No repo folder is set for ${repo ?? "this repo"} on \`${machine}\`.`, set);
  else if (p.repo === "missing") add("repo-folder", "red", `${folder} doesn't exist on \`${machine}\`.`, `Clone ${repo ?? "the repo"} there, or ${set.charAt(0).toLowerCase()}${set.slice(1)}`);
  else if (p.main === false) add("repo-main", "red", `${folder} on \`${machine}\` isn't the main checkout (a worktree, a subfolder or not a repo).`, `Point "Repo folder on ${machine}" at the repo's main checkout (the folder with the .git directory).`);
  else if (repo && p.git !== false && repoSlug(p.origin)?.toLowerCase() !== repo.toLowerCase()) {
    add("repo-origin", "red", p.origin ? `${folder}'s origin on \`${machine}\` is ${p.origin}, not ${repo}.` : `${folder} on \`${machine}\` has no origin remote.`, `Point "Repo folder on ${machine}" at a clone of ${repo}.`);
  } else add("repo", "green", `${folder} is the main checkout of ${repo ?? "the repo"}.`);

  // red: git
  if (p.git === false) add("git", "red", `git isn't installed on \`${machine}\`.`, `Install Git for Windows (or git) on ${machine}.`);
  else add("git", "green", "git is installed.");

  // yellow: gh, through the doctor's own reading of `gh auth status`
  const auth = parseAuthStatus({ code: p.ghCode ?? 1, stdout: p.ghOut.join("\n"), stderr: "" });
  const issues = authIssues(auth);
  if (issues.length) {
    for (const issue of issues) {
      const id = issue.kind === "gh-scope" ? "gh-scope" : issue.kind === "gh-auth" && p.ghCode === 127 ? "gh" : issue.kind;
      const fix = id === "gh" ? `Install the GitHub CLI (gh) on ${machine}.` : id === "gh-scope" ? `Sign in on ${machine} again to add the project scope.` : `Sign in to GitHub on ${machine}.`;
      add(id, "yellow", `On \`${machine}\`: ${issue.message}`, fix);
    }
  } else if (auth.signedIn === null) {
    add("gh-auth", "yellow", `On \`${machine}\`: couldn't tell whether gh is signed in.`, `Run gh auth status on ${machine}, and sign in if it says so.`);
  } else add("gh", "green", "gh is signed in with the project scope.");

  // yellow: disk
  if (p.diskKb !== null && p.diskKb < MIN_FREE_KB) add("disk", "yellow", `Only ${GB(p.diskKb)} is free on \`${machine}\`'s drive.`, "Free some space: every run makes a worktree.");
  else if (p.diskKb !== null) add("disk", "green", `${GB(p.diskKb)} free.`);

  // yellow: commands the repo says tests need
  if (requires.length) {
    if (p.missing.length) add("requires", "yellow", `${p.missing.join(", ")} ${p.missing.length === 1 ? "isn't" : "aren't"} installed on \`${machine}\` (the repo's test_device.requires).`, `Install ${p.missing.join(", ")} on ${machine} and make sure it is on the PATH of a Git Bash login shell.`);
    else add("requires", "green", `${requires.join(", ")} found.`);
  }

  // yellow: the installed mod
  const sync = `Run sync.sh from the Sync mod in its clone on ${machine} to update the installed mods.`;
  switch (p.mods) {
    case "same": add("mods", "green", "The installed github-tasks matches its clone."); break;
    case "differs": add("mods", "yellow", `The github-tasks installed on \`${machine}\` differs from its clone (${p.modsCount} file${p.modsCount === 1 ? "" : "s"}), so herdr-tasks there is stale.`, sync); break;
    case "not-installed": add("mods", "yellow", `github-tasks isn't installed on \`${machine}\`.`, sync); break;
    case "no-sync-json": add("mods", "yellow", `\`${machine}\` has no sync.json, so which clone its mods come from isn't known.`, sync); break;
    case "no-clone": add("mods", "yellow", `The clone named in \`${machine}\`'s sync.json has no github-tasks mod folder.`, sync); break;
    default: add("mods", "yellow", `Couldn't compare the installed github-tasks on \`${machine}\` with its clone.`, sync);
  }
  return checks;
}

// A deep result as it is saved in the binding: { level, checks, at }.
export const healthOf = (checks, now = Date.now()) => ({ level: rollup(checks), checks, at: now });

// The prefilled "Repo folder on <machine>": from the spaces known on that machine, the main checkout whose origin is this repo.
//   spaces: [{ on, mainRoot, remote }], the machine a space is on (null here), its repo's main checkout (null when not a repo) and
//   that checkout's origin URL. null when no space matches.
export function pickRepoFolder(spaces, { machine, repo }) {
  const want = String(repo ?? "").toLowerCase();
  for (const s of spaces ?? []) {
    if (!s || s.on !== machine || !text(s.mainRoot)) continue;
    if (repoSlug(s.remote)?.toLowerCase() === want) return posixFolder(s.mainRoot.trim());
  }
  return null;
}
