// What View does for a running task: brings its tab to the front with the run page beside the orchestrator. Everything it
// touches comes in as `deps` (start.js passes Herdr's), so node --test runs it against fakes:
//   deps.run(command, args)  deps.panes()  deps.app(command, args)  deps.readTextFile(path)  deps.home()  deps.notify(note)
import { FOLDER_LABEL, branchName, reopenProps, RUN_LABEL, ticketName } from "./run.js";

// Brings a run's tab to the front with the run's own pane (the list of its agents) beside the
// orchestrator. The pane is opened again when it's gone: closed, or never made because that part of Start failed.
// ticket and repo: what the run is for, to name the pane. Doesn't throw; a pane that can't open leaves the tab as it is.
export async function viewRunWith(running, cx, { ticket, repo, project } = {}, deps) {
  const { run, panes, app, readTextFile, home } = deps;
  const { "herdr.space": space, "herdr.tab": tab, [RUN_LABEL]: id, [FOLDER_LABEL]: folder } = running.labels;
  if (space) run("space.select", { id: space });
  if (tab) run("tab.select", { id: tab });
  if (!tab || !id || panes().some((p) => p.tab === tab && p.mod === "github-tasks")) return;
  try {
    const pane = panes().find((p) => p.terminal === running.address)?.pane;
    if (!pane) return;
    const partial = {
      role: "run", id, orchestrator: running.address, title: ticketName(ticket), workflow: "", branch: branchName(ticket), folder: folder ?? "",
      ticket: { number: ticket?.number ?? null, key: ticket?.key ?? null }, projectId: project?.id ?? null,
    };
    // Start saved the full props (repoRoot, statusField, workflow name) beside the run's other files.
    const saved = await readTextFile(`${home()}/.herdr/workflow-runs/${id}/pane.json`).catch(() => null);
    await app("pane.split", { pane, direction: "right", mod: "github-tasks", props: reopenProps(saved, partial, running.address) });
    run("pane.focus", { pane });
  } catch { /* the tab is showing; only the list of agents is missing */ }
}

