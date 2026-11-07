// What happens after a Pull or Push of the config repo stopped on a rebase conflict (ops.js undid the
// rebase): the replay in conflicts.js merges .metadata.json entry by entry without asking, and anything
// else is asked about. No Herdr imports: the tests (repo-conflict.test.js) run it against real git repos.
import { prepare } from "./conflicts.js";
import { finishMerge } from "./ops.js";

// Resolves to
//   { kind: "done", text, out, openAgent: false }  only .metadata.json conflicted: merged and committed, Herdr updated and, for a
//                                push, the merge pushed (out is finishMerge's outcome),
//   { kind: "stopped", stopped, openAgent }  files the person must choose a side for (nothing changed); stopped
//                                is what the Conflicts section keeps (target "repo", `push` says which op),
//   { kind: "none", openAgent }  the replay found nothing to ask about (an edit in the way, say),
//   { kind: "error", text }.
// openAgent: a Push conflict opens the configured agent on its own; a Pull conflict shows the choice and
// lets the person ask the agent with a button.
export async function settleRepoConflict(io, cfg, { repo, push, step = () => {} }) {
  const openAgent = Boolean(push);
  const p = await prepare(io, { repo, step });
  if (p.kind === "stopped") return { kind: "stopped", stopped: { target: "repo", ...p.stopped, push: Boolean(push) }, openAgent };
  if (p.kind === "error") return { kind: "error", text: p.text };
  if (p.kind === "none") return { kind: "none", openAgent };
  step("Updating Herdr…");
  const out = await finishMerge(io, cfg, { push: Boolean(push) });
  if (out.result !== "ok") return { kind: "error", text: out.message || "The sync script stopped." };
  return { kind: "done", text: `Merged the skill records from both sides. ${out.message}`, out, openAgent: false };
}
