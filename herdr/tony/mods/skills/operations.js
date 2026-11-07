// What each request the panel performs does on a machine: the skillshare commands in order, how
// their output reads, and what to tell the person. No Herdr imports and no view state: main.js
// takes the lock, shows progress and the result, and the tests pass a fake machine.
import { hookArgs, failure, parseJSON, flag } from "./model.js";

const done = (text) => ({ kind: "done", text });
const error = (text) => ({ kind: "error", text });
const outcome = (r, ok, what) => (r.code === 0 ? done(ok) : error(failure(r, what)));

// operate(req, io) performs one request on machine req.on.
//   io.job(args, { on, cwd }): skillshare run detached; io.run(args, { on, cwd }): a short read;
//   io.step(text): what it is doing now.
// Resolves to { kind, text } for the notice (kind null: none), and overlay: { title, text } to show.
export async function operate(req, io) {
  const op = OPS[req.op];
  return op ? op(req, io, req.on ?? null) : { kind: null };
}

const at = (req, scope) => ({ on: req.on ?? null, cwd: scope === "project" ? req.project : null });

const OPS = {
  async update(req, { job, step }) {
    let updated = 0;
    for (const u of req.updates) {
      step(u.all ? `Updating all ${u.kind === "agents" ? "agents" : "skills"} (${u.scope})…` : `Updating ${u.label}…`);
      const args = ["update", ...(u.kind === "agents" ? ["agents"] : []), ...(u.all ? ["--all"] : [u.name]), "--json", flag(u.scope)];
      const r = await job(args, at(req, u.scope));
      const j = parseJSON(r.stdout);
      const blocked = (j?.items ?? []).filter((i) => i.status === "security_blocked").map((i) => i.name);
      if (blocked.length) return error(`Audit blocked ${blocked.join(", ")}. Ask an agent to audit it before updating.`);
      if (r.code !== 0 && !j) return error(failure(r, "skillshare update"));
      const failed = [...(j?.items ?? []), ...(j?.agents ?? [])].filter((i) => i.status === "failed");
      if (failed.length) return error(`Could not update ${failed.map((i) => i.name).join(", ")}: ${failed[0].error ?? failed[0].message ?? "see skillshare update"}`);
      updated += j?.updated ?? (j?.agents ?? []).filter((a) => a.status === "updated").length ?? 0;
    }
    return done(updated ? `Updated ${updated}` : "Already up to date");
  },

  async hook(req, { job, step }) {
    const args = hookArgs(req.item, req.action);
    if (!args) return error("This hook action is unavailable.");
    step(`Saving ${req.item.label}…`);
    const r = await job(args, at(req, req.item.scope));
    return outcome(r, "Saved", "skillshare hooks");
  },

  async uninstall(req, { job, step }) {
    const it = req.item;
    step(`Uninstalling ${it.label}…`);
    const kind = it.kind === "agents" ? ["agents"] : [];
    const args = it.scope === "project" ? ["uninstall", ...kind, it.rel, "-p", "--force"] : ["uninstall", ...kind, it.rel, "--json", "-g"];
    const r = await job(args, at(req, it.scope));
    const j = parseJSON(r.stdout);
    if (r.code !== 0 || j?.failed?.length) return error(j?.failed?.length ? `Could not uninstall ${j.failed.join(", ")}` : failure(r, "skillshare uninstall"));
    return done(`Moved ${it.label} to the skillshare trash`);
  },

  async text(req, { run, step }, on) {
    step(req.busy);
    const r = await run(req.args, { on, cwd: req.cwd ?? null });
    return { kind: null, overlay: { title: req.title, text: String(r.stdout || r.stderr || "No output").replace(/\x1b\[[0-9;]*m/g, "") } };
  },
};
