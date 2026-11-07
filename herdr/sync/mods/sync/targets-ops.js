// What the sync mod runs against skillshare on a machine: read each scope's snapshot, link the targets
// (skillshare sync --all, then sync plugins, per scope) and read one item's diff. No Herdr imports and
// no view state: main.js takes the lock and shows the result, and the tests (targets-ops.test.js) pass
// a fake machine.
//   io.sh(script, args, on): one short exec; io.run(args, { on, cwd }): one short skillshare exec;
//   io.job(args, { on, cwd, script }): a long one, detached (jobs.js).
import {
  FIND_PROJECT, SNAPSHOT, parseSnapshot, buildItems, failure, flag, parseJSON, stripAnsi, syncCommands, syncDone, diffArgs,
} from "./targets.js";

const scopesOf = (project) => (project ? ["project", "global"] : ["global"]);
const at = (on, project, scope) => ({ on, cwd: scope === "project" ? project : null });

// The skillshare project of the first folder that is one, or null.
export async function findProject({ sh }, on, folders) {
  return (await sh(FIND_PROJECT, folders, on)).stdout.trim() || null;
}

// Whether skillshare can be run on the machine.
export async function hasSkillshare({ sh }, on) {
  return (await sh("command -v skillshare >/dev/null 2>&1", [], on)).code === 0;
}

// Every scope's rows: { raw: { [scope]: { list, diff, mcp, plugins, hooks, took, error } }, items, error }.
export async function loadTargets(io, on, project) {
  const raw = {};
  await Promise.all(scopesOf(project).map(async (scope) => {
    const r = await io.job([scope === "project" ? project : "", flag(scope)], { on, script: SNAPSHOT });
    const snap = parseSnapshot(r.stdout);
    raw[scope] = { list: snap.list, diff: snap.diff, mcp: snap.mcp, plugins: snap.plugins, hooks: snap.hooks, took: snap.took, error: Array.isArray(snap.list) ? null : failure(r, "skillshare list") };
  }));
  const items = Object.entries(raw).flatMap(([scope, r]) => buildItems(scope, r));
  return { raw, items, error: raw.global?.error ?? raw.project?.error ?? null };
}

// Links the targets, one scope after the other. step(text) says what it is doing.
// Resolves to { kind: "done" | "error", text }.
export async function syncTargets(io, { on = null, project = null, scopes, plugins = true, step = () => {} }) {
  for (const scope of scopes) {
    step(`Syncing ${scope}…`);
    for (const args of syncCommands(scope, plugins)) {
      const r = await io.job(args, at(on, project, scope));
      if (r.code !== 0) return { kind: "error", text: failure(r, `skillshare ${args.slice(0, args[1] === "plugins" ? 2 : 1).join(" ")}`) };
    }
  }
  return { kind: "done", text: syncDone(scopes) };
}

// `skillshare diff [agents] --stat --no-tui -g|-p` for one skill or agent: what the next sync would change.
export async function diffText(io, item, { on = null, project = null }) {
  const r = await io.run(diffArgs(item), at(on, project, item.scope));
  return { title: `What sync would change (${item.scope})`, text: stripAnsi(r.stdout || r.stderr || "No output") };
}

export { parseJSON };
