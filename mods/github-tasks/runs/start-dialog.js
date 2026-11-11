// The Start dialog: the pure side of it. It lists the workflows a ticket's saved labels trigger to choose from, or says why there is
// none, and starts the one chosen. Two places show it, both drawn by start-dialog-view.js: over the ticket editor (the editor's Start
// button, editor/editor.js) and as an overlay of its own over the workspace (a row's Start with several or no matching workflows, main.js).
// This file holds the state, what closes it, and the texts and layout; the view draws them.

export const WIDTH = 560;
export const OVERLAY_KEY = "github-tasks.start";

// The overlay that shows the dialog over the workspace. props: what the sidebar knew when Start was pressed (see startProps).
export const startOverlay = (props) => ({
  mod: "github-tasks", kind: "window", key: OVERLAY_KEY, width: 1, height: 1, frame: "none",
  props: { ...props, role: "start" },
});

// What the overlay needs, as plain data: the ticket (with its saved labels), where to start it from (GitHub mode has a repo and a project,
// local mode neither), and what the sidebar already found: the matching workflows and the unreadable workflow files.
export const startProps = ({ ticket, repo, project, where, matches, skipped }) => ({
  ticket, repo: repo ?? null, project: project ? { id: project.id, title: project.title } : null,
  where: { cwd: where?.cwd, on: where?.on },
  matches: matches ?? [], skipped: skipped ?? [],
});

// Why a run can't start from this place (`where`: the space's folder and machine), or null. The sidebar says so itself instead of opening a
// dialog that could only fail; start.js refuses the same places.
export const cantStartHere = (where) => (where?.on ? `This space is on ${where.on}. Workflows only run on this computer for now.`
  : !where?.cwd ? "This space has no folder to work in." : null);

// What Esc does: the dialog closes, unless a run is being started, which can't be called back halfway (an overlay's tasks end with it):
// then nothing.
export const escStep = ({ starting }) => (starting ? "ignore" : "close");

export const labelsLine = (d) => `Matched on labels: ${d.labels.length ? d.labels.join(", ") : "none"}`;
export const scopeBadge = (w) => (w.scope === "global" ? "Global" : "Repo");
export const rowDetail = (w) => (w.trigger.labels.length ? `${w.trigger.match === "all" ? "All of" : "Any of"}: ${w.trigger.labels.join(", ")}` : "Fallback: no labels");
export const STARTING = "Getting the branch ready and starting the Task Orchestrator…";

// What the dialog shows now: its title, which body (loading, the error alone, the starting message, the list of workflows, or the
// explanation that there is none), the error to show above the list, and the explanation's lines.
export function layout(d) {
  const title = d.chosen ? d.chosen.name : d.matches.length > 1 ? "Choose a workflow" : "Start";
  const empty = [d.labels.length ? "No workflow matches this ticket's labels." : "This ticket has no labels, and no workflow is the fallback.", "Make one in the Task settings."];
  // A failed start shows the reason alone, unless the dialog allows a retry (the row's overlay): then the list stays under it.
  const alone = !d.listed || (d.phase === "error" && !d.retry);
  const body = d.phase === "loading" ? "loading" : alone ? "error" : d.phase === "starting" ? "starting" : d.matches.length ? "list" : "empty";
  return { title, body, error: d.error, empty: body === "empty" ? empty : null };
}

// The dialog's state and what its buttons do. phase: "loading" (the workflows are being read), "ready" (listed), "starting" (a run is
// being started) or "error" (the workflows couldn't be read, or the run didn't start). onChange: called after every change, for the
// view to redraw. retry: after a failed start the list stays under the reason, so another workflow can be picked (the row's overlay;
// the editor's dialog shows the reason alone).
export class StartDialog {
  constructor(onChange = () => {}, { retry = false } = {}) {
    this.retry = retry;
    this.phase = "ready";
    this.labels = [];
    this.matches = [];
    this.skipped = [];
    this.chosen = null;
    this.error = null;
    this.listed = false; // whether the matches are known: false while loading and when reading the workflows failed
    this.closed = false;
    this.onChange = onChange;
  }

  get starting() { return this.phase === "starting"; }

  // The saved labels are known and the workflows are being read.
  begin(labels) {
    this.labels = [...labels];
    this.phase = "loading";
    this.listed = false;
    this.onChange();
  }

  // The workflows are read: `matches` are the ones the labels trigger, `skipped` the unreadable files.
  ready(labels, matches, skipped) {
    this.labels = [...labels];
    this.matches = matches;
    this.skipped = skipped;
    this.phase = "ready";
    this.listed = true;
    this.error = null;
    this.onChange();
  }

  // The workflows couldn't be read: the reason shows alone.
  loadFailed(message) {
    this.phase = "error";
    this.listed = false;
    this.error = String(message);
    this.onChange();
  }

  skippedLine() {
    return this.skipped.length ? `Skipped unreadable workflows: ${this.skipped.join("; ")}` : null;
  }

  // Esc, the ✕ and a press on the backdrop: closes without starting anything. True when it closed.
  requestClose() {
    if (escStep(this) === "ignore") return false;
    this.closed = true;
    this.onChange();
    return true;
  }

  // A workflow is chosen: `start(workflow)` starts it (it throws with the message for the person). On success the dialog closes; on a
  // failure it stays open with the reason, and another workflow can be chosen. Resolves with "started", "failed" or "ignored".
  async choose(workflow, start) {
    if (!this.listed || this.starting) return "ignored";
    this.phase = "starting";
    this.chosen = workflow;
    this.error = null;
    this.onChange();
    try {
      await start(workflow);
    } catch (e) {
      this.phase = "error";
      this.error = String(e?.message ?? e) || "The workflow didn't start.";
      this.onChange();
      return "failed";
    }
    this.phase = "ready";
    this.closed = true;
    this.onChange();
    return "started";
  }
}
