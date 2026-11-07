// Pull conflicts: when pulling stops because both sides changed the same files, read each side, merge
// `.metadata.json` entry by entry without asking, and let the person pick a side per file. Ported from
// the skills mod's old sync code (git show 7bcf58e). It works on any git folder (the skillshare
// source's repo, or the config repo after job 1's rebase was undone) through the same replay: a
// `git merge --no-ff --no-commit @{u}` that lists the unmerged files and stays in progress until
// RESOLVE or ABORT. No Herdr imports: the tests (conflicts.test.js) run it against real git repos.
//   io.sh(script, args): one short exec; io.job(script, args): the same, detached (it may use the network).
//   Every script gets the repo folder as $1.

const isMetadata = (f) => f === ".metadata.json" || f.endsWith("/.metadata.json");
const lines = (r) => String(r.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
const lastLine = (text) => String(text ?? "").trim().split("\n").filter((l) => l.trim()).pop()?.trim() ?? "";

// sh -c PREVIEW <name> <repo> <files...>: each conflicting file as this computer committed it and
// as the remote has it ("@@gone" when that side deleted it), capped at 2000 lines.
export const PREVIEW = `cd "$1" || exit 1; shift
for p; do
  for side in local remote; do
    if [ $side = local ]; then rev=HEAD; else rev='@{u}'; fi
    printf '@@%s %s\\n' "$side" "$p"
    if git cat-file -e "$rev:$p" 2>/dev/null; then git show "$rev:$p" | head -n 2000; else echo "@@gone"; fi
  done
done`;

// sh -c CONFLICTS <name> <repo>: replays the merge that the pull undid and lists the files both sides
// changed. The merge stays in progress until RESOLVE or ABORT.
export const CONFLICTS = `cd "$1" || exit 1
git merge --abort 2>/dev/null || true
git merge --no-ff --no-commit '@{u}' >/dev/null 2>&1 || true
git -c core.quotePath=false diff --name-only --diff-filter=U`;

// sh -c RESOLVE <name> <repo> <path=local|remote>...: takes one side of each file and commits the
// merge. .metadata.json is merged per entry first (mergeMetadata, METADATA_*); any other file still
// unmerged stops it, so nothing is resolved without a choice.
export const RESOLVE = `set -e
cd "$1"; shift
for c in "$@"; do
  p=\${c%=*}; side=\${c##*=}
  if [ "$side" = remote ]; then flag=--theirs; else flag=--ours; fi
  git checkout "$flag" -- "$p" 2>/dev/null && git add -- "$p" || git rm -q -- "$p"
done
if [ -n "$(git diff --name-only --diff-filter=U)" ]; then echo "unchosen conflicts remain" >&2; exit 1; fi
git commit -q --no-edit`;

// sh -c METADATA_STAGES <name> <repo> <path>: the file at the merge base, here and on the remote,
// each after an "@@stage N" line (empty when that side lacks it). A blank line comes first, so a file
// without a final newline cannot run into the next marker.
export const METADATA_STAGES = `cd "$1" || exit 1
for n in 1 2 3; do echo; echo "@@stage $n"; git show ":$n:$2" 2>/dev/null; done`;

// sh -c METADATA_WRITE <name> <repo> <path> <content>: writes the merged file and stages it.
export const METADATA_WRITE = `cd "$1" && printf '%s' "$3" > "$2" && git add -- "$2"`;

export const ABORT = 'cd "$1" && git merge --abort 2>/dev/null; true';

// sh -c FETCH <name> <repo>: the remote's newest commits, so a choice is judged against what is there now.
export const FETCH = 'GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT; cd "$1" && git fetch --quiet';

// sh -c UPHASH <name> <repo>: the commit the remote branch is at here.
export const UPHASH = 'cd "$1" && git rev-parse --verify -q "@{u}"';

// ---- Parsing ----

// The same per-entry merge skillshare's own pull does (internal/install/metadata_merge.go): an entry
// changed on one side takes that side; changed on both, the later installed_at wins (the remote on a
// tie) and an edit beats a delete; a local delete of an entry the remote left alone sticks.
export function mergeMetadata(base, ours, theirs) {
  const parse = (text) => { const j = String(text ?? "").trim() ? JSON.parse(text) : {}; j.entries ??= {}; return j; };
  const b = parse(base), o = parse(ours), th = parse(theirs);
  const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
  const same = (x, y) => canon(x ?? null) === canon(y ?? null);
  const at = (e) => Date.parse(e?.installed_at ?? "") || 0;
  const merged = th;
  for (const [name, mine] of Object.entries(o.entries)) {
    const old = b.entries[name], remote = th.entries[name];
    if (same(mine, old)) continue;
    if (same(remote, old) || remote == null || at(mine) > at(remote)) merged.entries[name] = mine;
  }
  for (const name of Object.keys(th.entries)) {
    if (!(name in o.entries) && b.entries[name] != null && same(th.entries[name], b.entries[name])) delete merged.entries[name];
  }
  return JSON.stringify(merged, null, 2) + "\n";
}

export function parseStages(text) {
  const out = ["", "", ""];
  let cur = -1;
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^@@stage ([123])$/);
    if (m) { cur = Number(m[1]) - 1; continue; }
    if (cur >= 0) out[cur] += `${line}\n`;
  }
  return out;
}

// PREVIEW's output → { path: { local, remote } }, null for a side that deleted the file.
export function parsePreview(text) {
  const out = {};
  let cur = null;
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^@@(local|remote) (.+)$/);
    if (m) { cur = { path: m[2], side: m[1] }; (out[m[2]] ??= { local: [], remote: [] })[m[1]] = []; continue; }
    if (!cur) continue;
    const side = out[cur.path];
    if (line === "@@gone") side[cur.side] = null;
    else if (side[cur.side]) side[cur.side].push(line);
  }
  for (const v of Object.values(out)) for (const k of ["local", "remote"]) if (v[k]) v[k] = v[k].join("\n").replace(/\n$/, "");
  return out;
}

// Two versions of a file → each side's lines with the ones the other lacks marked, unchanged runs
// folded to `context` lines around each change.
export function diffSides(a, b, context = 2) {
  const x = a == null ? [] : String(a).split("\n"), y = b == null ? [] : String(b).split("\n");
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const markX = new Array(n).fill(true), markY = new Array(m).fill(true);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (x[i] === y[j]) { markX[i++] = false; markY[j++] = false; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  const fold = (ls, marks) => {
    const keep = marks.map((_, i) => marks.slice(Math.max(0, i - context), i + context + 1).some(Boolean));
    const out = [];
    ls.forEach((text, i) => {
      if (keep[i]) out.push({ text, mark: marks[i] });
      else if (out.at(-1)?.gap !== true) out.push({ text: "…", gap: true });
    });
    return out;
  };
  const differ = Math.max(markX.filter(Boolean).length, markY.filter(Boolean).length);
  return { local: a == null ? null : fold(x, markX), remote: b == null ? null : fold(y, markY), differ };
}

// ---- Operations ----

// A stopped pull is kept in shared values, so its previews stay small: at most this many files, and
// this many lines on a side.
export const MAX_FILES = 10, MAX_LINES = 80;

// Merges every conflicted .metadata.json in the merge in progress. Returns an error text, or null.
async function mergeMetadataFiles(io, repo) {
  const files = lines(await io.sh('cd "$1" && git -c core.quotePath=false diff --name-only --diff-filter=U', [repo])).filter(isMetadata);
  for (const f of files) {
    let merged;
    try { merged = mergeMetadata(...parseStages((await io.sh(METADATA_STAGES, [repo, f])).stdout)); } catch (e) { return `Could not merge ${f}: ${e.message ?? e}`; }
    const w = await io.sh(METADATA_WRITE, [repo, f, merged]);
    if (w.code !== 0) return `Could not write ${f}: ${lastLine(w.stderr)}`;
  }
  return null;
}

// Both sides of each file, as { differ, local: {lines, cut}, remote: {lines, cut} } (a null side: deleted).
export async function previewFiles(io, repo, files) {
  const shown = (l) => l && { lines: l.slice(0, MAX_LINES), cut: l.length > MAX_LINES };
  const raw = parsePreview((await io.sh(PREVIEW, [repo, ...files.slice(0, MAX_FILES)])).stdout);
  return Object.fromEntries(Object.entries(raw).map(([f, v]) => {
    const d = diffSides(v.local, v.remote);
    return [f, { differ: d.differ, local: shown(d.local), remote: shown(d.remote) }];
  }));
}

// A pull that both sides changed: replay it, and put the folder back as it was. Resolves to
//   { kind: "none" }    nothing conflicts (the pull failed for another reason),
//   { kind: "merged" }  only .metadata.json conflicted: merged per entry and the merge committed,
//   { kind: "stopped", stopped: { repo, files, previews, upHash } }  files to ask about (nothing changed),
//   { kind: "error", text }.
export async function prepare(io, { repo, step = () => {} }) {
  step("Reading conflicts…");
  const upHash = (await io.sh(UPHASH, [repo])).stdout.trim();
  const all = lines(await io.sh(CONFLICTS, [repo]));
  const files = all.filter((f) => !isMetadata(f));
  if (!all.length) { await io.sh(ABORT, [repo]); return { kind: "none" }; }
  if (!files.length) {
    step("Merging skill records…");
    let err = await mergeMetadataFiles(io, repo);
    if (!err && (await io.sh(RESOLVE, [repo])).code !== 0) err = "Could not commit the merged skill records";
    if (err) { await io.sh(ABORT, [repo]); return { kind: "error", text: err }; }
    return { kind: "merged" };
  }
  await io.sh(ABORT, [repo]);
  return { kind: "stopped", stopped: { repo, files, previews: await previewFiles(io, repo, files), upHash } };
}

// Replays the stopped pull with the person's choice for each file ({ path: "local" | "remote" }).
// The remote is fetched first; when it moved since the person looked, or other files conflict now,
// nothing is applied and the answer is { kind: "again", stopped } to ask afresh. Otherwise
//   { kind: "applied" } (the merge is committed), { kind: "none" } (nothing conflicts any more),
//   { kind: "merged" } or { kind: "error", text }.
export async function applyChoices(io, { repo, choices, upHash, step = () => {} }) {
  step("Checking the remote…");
  await (io.job ?? io.sh)(FETCH, [repo]);
  const moved = Boolean(upHash) && (await io.sh(UPHASH, [repo])).stdout.trim() !== upHash;
  if (!moved) {
    const now = lines(await io.sh(CONFLICTS, [repo])).filter((f) => !isMetadata(f));
    if (!now.some((f) => !choices[f])) {
      step("Applying your choices…");
      const meta = await mergeMetadataFiles(io, repo);
      if (meta) { await io.sh(ABORT, [repo]); return { kind: "error", text: meta }; }
      const picks = now.map((f) => `${f}=${choices[f]}`);
      const r = await io.sh(RESOLVE, [repo, ...picks]);
      if (r.code !== 0) { await io.sh(ABORT, [repo]); return { kind: "error", text: lastLine(r.stderr) || "Could not apply the choices; nothing changed" }; }
      return { kind: "applied" };
    }
  }
  await io.sh(ABORT, [repo]);
  const again = await prepare(io, { repo, step });
  if (again.kind === "stopped") return { kind: "again", stopped: again.stopped };
  return again;
}

// Whether a failed skillshare pull or push stopped on a conflict (its message says so).
export const looksLikeConflict = (r) => /both changed|merge was undone|conflict/i.test(`${r?.stdout ?? ""}\n${r?.stderr ?? ""}`);
