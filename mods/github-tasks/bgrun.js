// A run's orchestrator runs in the background, owned by no tab or pane (`hc run --bg`, with none of the herdr.space /
// herdr.tab labels that would adopt it into a pane). Its tab only shows it: a placeholder terminal on the left with the
// orchestrator shown over it (terminal.show), and the run page on the right. Closing the tab ends the placeholder, not
// the run. The tab is the first tab of the ticket's own space, rooted at the ticket's worktree and named for the ticket,
// which the Spaces sidebar nests under the repo's space; Merge closes that space. Pure apart from the deps it is handed,
// so node --test runs it.
//
// The Agents panel (Herdr's `agents` mod, read-only) lists two things: the terminals in a tab's pane that report a status
// (OSC 7501), and, under each of those, their live sub-agents, the terminals whose hc `parent` chain leads to it (clicking a
// paneless one runs terminal.peek; a blocked or erroring one reads "Needs you"). An orchestrator started `--no-parent` with no
// pane is neither, so neither it nor its workers and reviewers (whose parent is the orchestrator, by `spawn`) were ever listed,
// and a parent cannot be changed after a terminal is born.
// So each run gets a **host**: a tiny terminal in a tab of the repo's space (named `#<n> agents`) that reports `idle` by OSC
// 7501 (`ESC ] 7501 ; state=idle BEL`, found out live: `status=idle` and a bare `idle` are not read), prints one line and
// waits for ever. It is not an agent of the run (no run label; labelled herdr.workflow.host=<run id> and herdr.role=host so it
// is found again by label, never by saved ids) but the orchestrator's parent: `--parent <host> --outlive-parent --no-notify`,
// so the panel shows host > orchestrator > workers and reviewers, and closing a tab or the space never ends any of them (no
// agent is owned by a tab or pane). The host ends with the run: Merge, and the clean-up when Start fails, kill it and close its
// tab. If it can't be opened the run starts as before (no parent) and Start says why the panel won't list the run.
import { FOLDER_LABEL, HOST_LABEL, ROLE_LABEL, RUN_LABEL, TICKET_LABEL, shQuote } from "./run.js";

// Where the run's tab is saved (shared state, as herdr.tab labels are gone): { tab, left, space }.
export const slotKey = (id) => `github-tasks.runtab.${id}`;

// Where the run's host is saved (shared state): { tab, space, created } (created: Start made the space for it).
export const hostKey = (id) => `github-tasks.host.${id}`;

// The orchestrator's hc name: the run id and `-orch`, cut and cleaned to hc's rule (1-32 of a-z 0-9 - _), unique per run.
const orchestratorName = (id) => `${String(id).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 27)}-orch`;

// `hc run` for the orchestrator; its labels are set at birth. Under a `parent` (the run's host) it outlives it, types no notes
// into it and is named; without one (no host could be opened) it has no parent, so nothing but a kill or Merge ends it.
export function orchestratorRunArgs({ id, key, workDir, argv, parent = null }) {
  const labels = [`${RUN_LABEL}=${id}`, `${ROLE_LABEL}=orchestrator`, `${TICKET_LABEL}=${key}`, `${FOLDER_LABEL}=${workDir}`];
  const family = parent ? ["--parent", parent, "--outlive-parent", "--no-notify"] : ["--no-parent"];
  return ["run", "--bg", "--json", ...family, "--cwd", workDir, "--name", orchestratorName(id), ...labels.flatMap((l) => ["--label", l]), "--", ...argv];
}

// The host's program: it reports a status (so the Agents panel lists it), says what it is, and waits for ever (a program that
// exits closes its pane). tail reads nothing from the terminal, so it never takes hc notes as input.
export const hostArgv = (note = "Host of this ticket's agents in the Agents panel. Ends when the ticket is merged.") => ["sh", "-c", `printf '\\033]7501;state=idle\\007'; printf '%s\\n' ${shQuote(note)}; exec tail -f /dev/null`];

export const hostTabName = (ticket) => `${ticket?.number ? `#${ticket.number}` : String(ticket?.title ?? "Ticket")} agents`;

// The address in the answer of `hc run --json`, or null.
export function parseStarted(stdout) {
  try { return JSON.parse(stdout)?.address || null; } catch { return null; }
}

// The program the tab's own terminal runs: a note, then it waits for ever (a program that exits closes its pane).
// The orchestrator is shown over it, so the note only reads when the connection is lost; it says nothing about the run's
// state, which may well have ended by then.
// kind: "run" (the default), "investigation" (investigate.js: the tab of a New Task agent, which works like a run's), or
// "investigation-ended" (the same tab opened again after its agent ended on its own: it says so).
const NOTES = {
  run: (a) => `This tab shows orchestrator ${a} of the run. When it is not showing, View reconnects it.`,
  investigation: (a) => `This tab shows agent ${a} of an investigation. When it is not showing, View reconnects it.`,
  "investigation-ended": (a) => `Agent ${a} of this investigation has ended. Press Done to remove its worktree and branch.`,
};
export const placeholderArgv = (orchestrator, kind = "run") => ["sh", "-c", `printf '%s\\n' ${shQuote(NOTES[kind](orchestrator))}; exec tail -f /dev/null`];

// Whether a terminal is the placeholder made for one of these orchestrators: its argv holds placeholderArgv's script (a login-shell wrapper around the argv is fine).
// Both kinds count, so a run's and an investigation's tab are found the same way.
const placeholderMatcher = (orchestrators) => {
  const texts = (orchestrators ?? []).filter(Boolean).flatMap((o) => Object.keys(NOTES).map((kind) => placeholderArgv(o, kind)[2]));
  return (t) => Array.isArray(t.argv) && t.argv.some((a) => texts.includes(a));
};

// What is left of the run's tab, from the saved slot: { tab, space, left, page } with left (the pane the orchestrator is
// shown in) or page (the run page) null when closed, or null when the tab is gone or has neither.
// The slot can go stale (the ids change). With the tab's `name` (the ticket's name) a stale slot is made good: the tab that
// has that name, a github-tasks pane and a terminal pane is the run's tab (the slot's own tab and space first); its left is
// the slot's left if still there, else its one terminal pane. panes() can't tell the run page from a ticket editor (both are
// the mod's pane, tab named the same), so a tab with no terminal pane is never taken by name, nor one with several (which
// is the orchestrator's?). Only the slot's space and the ticket's own space (`ticketSpace`) are searched: a same-named tab
// elsewhere is another repo's or an earlier run's.
// A tab found by name must also be this run's: its one terminal pane is the placeholder of one of the run's orchestrators
// (`orchestrators`, with the live `terminals`); with none given no tab is taken by name.
export function runTabParts({ slot, spaces, panes, name, ticketSpace = null, orchestrators = [], terminals: live = [] }) {
  const tabParts = (tab, space) => {
    const inTab = (panes ?? []).filter((p) => p.tab === tab);
    const left = inTab.some((p) => p.pane === slot?.left) ? slot.left : null;
    const page = inTab.find((p) => p.mod === "github-tasks")?.pane ?? null;
    return { tab, space, left, page, inTab };
  };
  const spaceOf = (tab) => (spaces ?? []).find((s) => (s.tabs ?? []).some((t) => t.id === tab))?.id;
  const strip = ({ inTab, ...parts }) => parts;
  const slotSpace = slot?.tab ? spaceOf(slot.tab) : undefined;
  const own = slotSpace ? tabParts(slot.tab, slotSpace) : null;
  if (own?.left && own.page) return strip(own);
  if (name) {
    const named = [];
    const mine = new Set([slot?.space, ticketSpace].filter(Boolean));
    for (const s of spaces ?? []) if (mine.has(s.id)) for (const t of s.tabs ?? []) if (t.name === name) named.push(tabParts(t.id, s.id));
    const terminals = (c) => c.inTab.filter((p) => p.terminal && p.mod !== "github-tasks");
    const placeholder = placeholderMatcher(orchestrators);
    const isMine = (c) => live.some((t) => t.address === terminals(c)[0].terminal && placeholder(t));
    const whole = named.filter((c) => c.page && terminals(c).length === 1 && isMine(c));
    whole.sort((a, b) => (b.tab === slot?.tab) - (a.tab === slot?.tab) || (b.space === slot?.space) - (a.space === slot?.space));
    const found = whole[0];
    if (found) {
      const left = found.left ?? terminals(found)[0].pane;
      return { tab: found.tab, space: found.space, left, page: found.page };
    }
  }
  return own && (own.left || own.page) ? strip(own) : null;
}

// The run's open tab, whole enough to show the orchestrator: the saved slot, while its tab and its left pane exist.
export function findRunTab({ slot, spaces, panes, name, ticketSpace = null, orchestrators, terminals }) {
  const parts = runTabParts({ slot, spaces, panes, name, ticketSpace, orchestrators, terminals });
  return parts?.left ? { tab: parts.tab, left: parts.left, space: parts.space } : null;
}

// View's quick path: the run's tab is whole and the ticket's own space exists (ticketSpace; or no worktree is known), wherever the
// tab is: the person may have put it in another space, and it is only rebuilt when the ticket's space is gone: its space and tab are selected, the orchestrator is shown over its left pane again and the slot is rewritten
// with what was found (it may have been stale). True when that was done, false when the tab must be connected (viewConnect).
// The ticket's space is found here (findTicketSpace) from the worktree (folder) and the main checkout (repoRoot, which GitHub
// tickets don't carry: read it from pane.json), the same for both paths, so the repo's space is never taken for it.
//   args: { slot, spaces, panes, name, folder, repoRoot, orchestrators, terminals, setSlot(slot), run(name, args), show(left) }
export function viewQuick({ slot, spaces, panes, name, folder, repoRoot, orchestrators, terminals, setSlot, run, show }) {
  const ticketSpace = findTicketSpace({ spaces, panes, folder, repoRoot });
  const open = runTabParts({ slot, spaces, panes, name, ticketSpace, orchestrators, terminals });
  if (!(open?.left && open.page && (ticketSpace || !folder))) return false;
  setSlot({ tab: open.tab, left: open.left, space: open.space });
  run("space.select", { id: open.space });
  run("tab.select", { id: open.tab });
  show(open.left);
  return true;
}

// View's slow path: connects what is missing. The tab is read again (the person may have closed the rest meanwhile). A tab
// that is whole but outside the ticket's own space, and that the slot itself points at (never one found only by name), is
// made again in the ticket's space (connect(null)), and the old tab is closed only after that has worked; a connect that
// throws leaves it. Any other tab found is repaired in place (connect(existing)).
//   args: { slot, spaces, panes, name, folder, repoRoot, orchestrators, terminals, connect(existing, ticketSpace) -> Promise, closeTab(tab) }
export async function viewConnect({ slot, spaces, panes, name, folder, repoRoot, orchestrators, terminals, connect, closeTab }) {
  const ticketSpace = findTicketSpace({ spaces, panes, folder, repoRoot });
  const part = runTabParts({ slot, spaces, panes, name, ticketSpace, orchestrators, terminals });
  const moved = part?.left && part.page && !ticketSpace && Boolean(folder) && part.tab === slot?.tab ? part : null;
  await connect(part && !moved ? { ...part } : null, ticketSpace);
  if (moved) closeTab(moved.tab);
}

// Runs fn unless one for this id is going already (then false); the id is free again when it ends, or throws.
export async function guarded(busy, id, fn) {
  if (busy.has(id)) return false;
  busy.add(id);
  try { return await fn(); } finally { busy.delete(id); }
}

const inside = (path, folder) => path === folder || path.startsWith(`${folder.replace(/\/+$/, "")}/`);

// The ticket's own space, if it is open: on this computer, and its first terminal is inside the ticket's worktree (folder;
// what the sidebar nests by). The space's own folder is only used when no first terminal is known, as it can drift with the
// focused pane (a repo space would then look like the ticket's). Matching is by the worktree, not
// by name, so a renamed issue or space is still found. The repo's space never is: it is skipped when its folder is the main
// checkout (repoRoot), and a tab an older run opened at the worktree inside it doesn't count, as it is not its first terminal.
// Its id, or null.
export function findTicketSpace({ spaces, panes, folder, repoRoot = "" }) {
  if (!folder || folder === repoRoot) return null;
  const first = (s) => { const tab = s.tabs?.[0]?.id; return (panes ?? []).find((p) => p.tab === tab && p.cwd); };
  const found = (spaces ?? []).find((s) => {
    if (s.machine || (repoRoot && s.folder === repoRoot)) return false;
    const terminal = first(s);
    return terminal ? inside(terminal.cwd, folder) : Boolean(s.folder && inside(s.folder, folder));
  });
  return found?.id ?? null;
}

// The space View connects the run's tab in: the ticket's, or null when it was closed (then View makes a new one at the
// worktree). Never the space the person happens to be in, which may be the repo's.
export const viewTarget = findTicketSpace;

// The repo's own space, if it is open: on this computer, its first terminal (else its own folder) inside the main checkout
// (repoRoot). A ticket's space is rooted at its worktree, outside the checkout, so it never matches. Its id, or null.
export function findRepoSpace({ spaces, panes, repoRoot }) {
  if (!repoRoot) return null;
  const first = (s) => { const tab = s.tabs?.[0]?.id; return (panes ?? []).find((p) => p.tab === tab && p.cwd); };
  const found = (spaces ?? []).find((s) => {
    if (s.machine) return false;
    const terminal = first(s);
    return terminal ? inside(terminal.cwd, repoRoot) : Boolean(s.folder && inside(s.folder, repoRoot));
  });
  return found?.id ?? null;
}

// The run's live host terminal among `terminals` (found by its label, not by saved ids), or null.
export const findHost = (terminals, id) => (terminals ?? []).find((k) => k.state === "live" && k.labels?.[HOST_LABEL] === id) ?? null;

// Opens the run's host: a tab in the repo's space (rooted at the main checkout, so the sidebar keeps it with the repo), or, when
// the repo's space isn't open, a space of its own named for the repo with the tab as its first (created: true), so the host
// is never put in the ticket's space (that is closed by Merge with the person's own tabs) nor in whichever space the person
// is in. Its terminal gets its labels afterwards (a tab made with an argv takes none). Throws with the reason; what was made is
// ended again then.
// A New Task session (investigate.js) has no ticket space but its own: with `own` ({ spaceName, folder, note? }) the host is the first tab
// of a new space of that name rooted at `folder` (the session's worktree, so the sidebar nests it under the repo's, and the session's
// agent then opens its tab in that space), never the repo's.
//   deps: { app(name, args) -> made, hc(args), run(name, args) }; args: { id, name, repoRoot, spaces, panes, own? }
//   Resolves with { address, tab, space, created }.
export async function openHost(deps, { id, name, repoRoot, spaces, panes, own = null }) {
  const space = own ? null : findRepoSpace({ spaces, panes, repoRoot });
  const created = !space;
  let made;
  try {
    made = created
      ? await deps.app("space.new", { name: own?.spaceName || String(repoRoot).split("/").filter(Boolean).pop() || "repo", tab: name, folder: own?.folder ?? repoRoot, argv: own?.note ? hostArgv(own.note) : hostArgv() })
      : await deps.app("tab.new", { name, folder: repoRoot, argv: hostArgv(), space });
  } catch (e) { throw new Error(`the host tab couldn't be made (${why(e)})`); }
  const undo = async () => {
    if (made?.terminal) { await deps.hc(["kill", made.terminal]).catch(() => {}); await deps.hc(["rm", made.terminal]).catch(() => {}); }
    try { if (created && made?.space) deps.run("space.close", { id: made.space, confirmed: true }); else if (made?.tab) deps.run("tab.close", { id: made.tab, confirmed: true }); } catch { /* it stays */ }
  };
  if (!made?.terminal) { await undo(); throw new Error("the host tab has no terminal address"); }
  const labelled = await deps.hc(["label", made.terminal, `${HOST_LABEL}=${id}`, `${ROLE_LABEL}=host`]).catch((e) => ({ code: 1, stdout: "", stderr: why(e) }));
  if (labelled.code !== 0) { await undo(); throw new Error(`the host couldn't be labelled (${String(labelled.stderr || labelled.stdout || "hc label failed").trim()})`); }
  return { address: made.terminal, tab: made.tab, space: made.space ?? space, created };
}

// Ends the run's host: every live terminal labelled as its host is killed and removed, then its tab closed (found from the host's
// own pane, else the saved record), and the space too when Start made it for the host and it holds nothing else. A host that
// is gone already is nothing to do; a tab already closed is no failure. A host that is still live after its kill is an error
// naming it, and its tab is kept.
//   deps: { id, hc, terminals() , run, spaces, panes, record? ({ tab, space, created }), also? (addresses to end even if their label
//   isn't listed yet: a host just made), closeSpace? }. Resolves with { error }.
//   closeSpace: a failed start's way (investigate.js): the space this start made for the host is closed by its id, after the host's tab,
//   whatever `spaces` says: the snapshot may still list the agent's tab that was closed a moment ago, or not list the new space yet.
//   Only a space the start made (record.created); one that is already gone is no failure.
export async function endHost({ id, hc, terminals, run, spaces, panes, record = null, also = [], closeSpace = false }) {
  const hosts = (terminals() ?? []).filter((k) => k.state === "live" && k.labels?.[HOST_LABEL] === id);
  for (const address of also) if (address && !hosts.some((h) => h.address === address)) hosts.push({ address });
  const stuck = [], tabs = new Set();
  for (const h of hosts) {
    const tab = (panes ?? []).find((p) => p.terminal === h.address)?.tab ?? record?.tab;
    const r = await hc(["kill", h.address]).catch((e) => ({ code: 1, stderr: why(e), stdout: "" }));
    if (r.code !== 0 && (terminals() ?? []).some((k) => k.address === h.address && k.state === "live")) { stuck.push(`${h.address}: ${String(r.stderr || r.stdout || "kill failed").trim()}`); continue; }
    await hc(["rm", h.address]).catch(() => {});
    if (tab) tabs.add(tab);
  }
  if (stuck.length) return { error: `couldn't end the run's host ${stuck.join("; ")}` };
  for (const tab of tabs) { try { run("tab.close", { id: tab, confirmed: true }); } catch { /* it closed with its terminal */ } }
  if (closeSpace && record?.created && record.space) { try { run("space.close", { id: record.space, confirmed: true }); } catch { /* it is gone already */ } return { error: null }; }
  const space = record?.created && record.space ? (spaces ?? []).find((s) => s.id === record.space) : null;
  if (space && tabs.size && (space.tabs ?? []).every((t) => tabs.has(t.id))) { try { run("space.close", { id: space.id, confirmed: true }); } catch { /* it closed with its tab */ } }
  return { error: null };
}

// The space a worker's or reviewer's terminal is peeked from, so that keeping it as a tab lands in the ticket's space: the
// space of the run's open tab, else the ticket's space found by its worktree, else null.
export function peekSpace({ slot, spaces, panes, folder, repoRoot }) {
  return runTabParts({ slot, spaces, panes })?.space ?? findTicketSpace({ spaces, panes, folder, repoRoot });
}

// Takes back what Start opened when the run fails to start: the space it made (confirmed: it holds only the run's tab), else
// the tab it added to a space that was there already. Nothing to do when neither is open.
export function undoRunTab({ created, part, run }) {
  if (created) run("space.close", { id: created, confirmed: true });
  else if (part) run("tab.close", { id: part.tab, confirmed: true }); // confirmed: it may be the space's last tab
}

const why = (e) => String(e?.message ?? e);

// Opens the run's tab connected to the orchestrator: placeholder on the left, orchestrator shown over it, run page on the right,
// the left focused. With `existing` ({ tab, space, left, page }, from runTabParts) it makes good what that tab lacks (a
// left placeholder, or the run page) instead of opening another tab. Throws with the reason; a tab it made itself is closed
// again then, so a retry never leaves two. A tab that was already there is left alone.
// Without a space to put the tab in (`space` null) and with spaceName, it makes a new space of that name rooted at `folder`
// (the ticket's worktree: the sidebar nests a space under its repo by where its first terminal is) with the tab as its first;
// the slot returned then has created: true, and a failure closes that whole space.
//   deps: { app(name, args) -> made, paneOf(made) -> pane id | null, run(name, args), setSlot(id, slot), sleep(ms),
//           isShown?(orchestrator, left), warn?(message) }
//   kind: which placeholder note the left pane prints (placeholderArgv), and what the messages call the agent: "orchestrator", or "agent"
//   for an investigation's.
//   "investigation-ended" is an investigation's tab opened again after its agent ended on its own, so Done can be pressed: the
//   agent's terminal is shown if the app still has it, and not being able to show it is no failure.
export async function connectRun(deps, { id, orchestrator, name, space, spaceName, folder, props, existing = null, kind = "run" }) {
  const ended = kind === "investigation-ended";
  const who = kind.startsWith("investigation") ? "agent" : "orchestrator";
  let made = null, tab = existing?.tab, left = existing?.left ?? null, page = existing?.page ?? null, createdSpace = false;
  try {
    if (!existing) {
      createdSpace = !space && Boolean(spaceName);
      if (createdSpace) {
        try { made = await deps.app("space.new", { name: spaceName, tab: name, ...(folder ? { folder } : {}), argv: placeholderArgv(orchestrator, kind) }); }
        catch (e) { throw new Error(`the space couldn't be made (${why(e)})`); }
      } else {
        try { made = await deps.app("tab.new", { name, ...(folder ? { folder } : {}), argv: placeholderArgv(orchestrator, kind), ...(space ? { space } : {}) }); }
        catch (e) { throw new Error(`the tab couldn't be made (${why(e)})`); }
      }
      tab = made.tab;
      left = await deps.paneOf(made);
      if (!left) throw new Error("the tab's pane didn't appear");
    } else if (!left) {
      if (!page) throw new Error("the run's tab has nothing left to attach to");
      let fresh;
      try { fresh = await deps.app("pane.split", { pane: page, direction: "right", argv: placeholderArgv(orchestrator, kind) }); }
      catch (e) { throw new Error(`the tab's left pane couldn't be made again (${why(e)})`); }
      left = await deps.paneOf({ ...fresh, tab });
      if (!left) throw new Error("the tab's new pane didn't appear");
      try { await deps.app("pane.swap", { pane: left, target: page }); } catch { /* it stays on the right: still works */ }
    }
    const where = existing?.space ?? made?.space ?? space;
    if (where) deps.run("space.select", { id: where });
    deps.run("tab.select", { id: tab });
    const show = async () => {
      try { await deps.app("terminal.show", { terminal: orchestrator, pane: left }); }
      catch (e) { throw new Error(`the ${who} ${orchestrator} couldn't be shown (${why(e)})`); }
    };
    if (ended) await show().catch(() => {}); // nothing is going on in it: the note on the left says it has ended
    else await show(); // fails here, before the page opens, when the orchestrator can't be shown at all
    if (!page) {
      try { await deps.app("pane.split", { pane: left, direction: "right", mod: "github-tasks", props }); }
      catch (e) { throw new Error(`the run page couldn't open (${why(e)})`); }
    }
    const slot = { tab, left, space: where ?? null };
    deps.setSlot(id, slot);
    deps.run("pane.focus", { pane: left });
    const held = ended ? null : await holdShown(deps, { orchestrator, left, show });
    if (held === false) deps.warn?.(who === "agent"
      ? `The agent ${orchestrator} may not be showing in its tab yet. Click its row under Investigations to show it again; the agent itself is going.`
      : `The orchestrator ${orchestrator} may not be showing in its tab yet. Press View on the ticket to show it again; the run itself is going.`);
    return createdSpace ? { ...slot, created: true } : slot;
  } catch (e) {
    if (made) {
      try { // a space this made holds only this tab: it goes whole, so no empty space is left
        if (createdSpace) deps.run(made.space ? "space.close" : "tab.close", made.space ? { id: made.space, confirmed: true } : { id: made.tab, confirmed: true });
        else deps.run("tab.close", { id: made.tab });
      } catch { /* it stays; View repairs it */ }
    }
    throw e;
  }
}

// A terminal.show made while the new tab is settling is lost (found out live: the placeholder stayed on screen until a
// later show), so it is repeated until the app says it holds (focused().shown, via deps.isShown), or a few times when
// it can't say. Resolves true (it holds), false (the app says it doesn't), or null (the app can't say). A show that keeps
// failing is left to the caller's warning: the tab is there, and View shows it again.
export async function holdShown(deps, { orchestrator, left, show, tries = 10, wait = 300 }) {
  for (let i = 0; i < tries; i++) {
    await deps.sleep(wait);
    if (deps.isShown?.(orchestrator, left)) return true;
    try { await show(); } catch { /* tried again next time round */ }
  }
  return deps.isShown ? Boolean(deps.isShown(orchestrator, left)) : null;
}

// Waits for the orchestrator's agent to be ready for its first task: the core says so when it reports idle, done or blocked.
// A terminal that has ended, or `hc` failing, is a failure with the reason. An agent that never reports (a custom command)
// is waited on for the whole budget and then let through, as spawn does, flagged `unconfirmed`.
export async function waitReady({ hc, orchestrator, tries = 3, timeout = 20 }) {
  for (let i = 0; i < tries; i++) {
    const r = await hc(["wait", orchestrator, "--timeout", String(timeout)]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
    if (r.code !== 0) return { ok: false, why: String(r.stderr || r.stdout || "hc wait failed").trim() };
    let got = null;
    try { got = JSON.parse(r.stdout); } catch { /* no answer to read: wait again */ }
    if (["idle", "done", "blocked"].includes(got?.status)) return { ok: true };
    if (got && (got.exit_code != null || ["exit", "exited", "killed", "ended"].includes(got.reason))) return { ok: false, why: `the orchestrator ended while starting (${got.reason ?? "exit"})` };
  }
  return { ok: true, unconfirmed: true };
}

// After a Herdr restart a terminal.show is gone: show each live orchestrator again over the left pane of the one tab its
// run has. Runs with no tab are left for View. Resolves with how many were shown; one that fails doesn't stop the rest.
export async function reapplyRuns({ terminals, slot, spaces, panes, show }) {
  let shown = 0;
  for (const k of terminals ?? []) {
    const id = k.labels?.[RUN_LABEL];
    if (k.state !== "live" || k.labels?.[ROLE_LABEL] !== "orchestrator" || !id) continue;
    const open = findRunTab({ slot: slot(id), spaces, panes });
    if (!open) continue;
    try { await show({ terminal: k.address, pane: open.left }); shown++; } catch { /* the next pass or View tries again */ }
  }
  return shown;
}

// Merge's end of a run: the orchestrator is killed on purpose first (nothing else ends a background run, and it would
// start more workers meanwhile), then the terminals of the run that are left, read again; then, as the very last step (the
// run page lives in it), the ticket's whole space is closed, confirmed, even with other tabs the person opened in it. That is
// only done to the ticket's own space (ticketSpace, found by its worktree): a run from before the ticket got a space has its
// tab in the repo's space, and then only that tab is closed. With no tab left, ticketSpace is closed. A terminal that is still live after its kill is an
// error: the space and slot are kept and the error says which, so the person can end it by hand. A space already closed is
// not a failure; `tabFound` false tells the page nothing was there to close.
//   deps: { hc(args) -> { code, stderr }, terminals() (read again as needed), run(name, args), slot, spaces, panes, ticketSpace?, clearSlot(),
//           host? (the saved record), clearHost?() }. The run's host (endHost) is ended after the run's terminals, before the space is closed.
//   Resolves with { closed, error } (+ tabFound: false when no space was found).
export async function endRun({ id, orchestrator, hc, terminals, run, slot, spaces, panes, ticketSpace = null, clearSlot, host = null, clearHost = () => {} }) {
  const live = () => (terminals() ?? []).filter((k) => k.state === "live" && (k.address === orchestrator || k.labels?.[RUN_LABEL] === id));
  const stuck = [];
  const kill = async (address) => {
    const r = await hc(["kill", address]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e), stdout: "" }));
    if (r.code !== 0 && live().some((k) => k.address === address)) stuck.push(`${address}: ${String(r.stderr || r.stdout || "kill failed").trim()}`);
    await hc(["rm", address]).catch(() => {});
  };
  if (orchestrator) await kill(orchestrator);
  for (const k of live().filter((k) => k.address !== orchestrator)) await kill(k.address);
  if (stuck.length) return { closed: false, error: `couldn't end ${stuck.join("; ")}. Its space was kept; end it with hc kill.` };
  const hosted = await endHost({ id, hc, terminals, run, spaces, panes, record: host }); // after its orchestrator (the host's child) and the rest
  if (hosted.error) return { closed: false, error: `${hosted.error}. Its space was kept; end it with hc kill.` };
  clearHost();
  const parts = runTabParts({ slot, spaces, panes });
  clearSlot();
  if (parts && parts.space !== ticketSpace) run("tab.close", { id: parts.tab }); // not the ticket's own space: the person's other tabs stay
  else if (ticketSpace) run("space.close", { id: ticketSpace, confirmed: true });
  else return { closed: false, error: null, tabFound: false };
  return { closed: true, error: null };
}

// Starts a run's orchestrator and opens its tab at once, so the person watches it boot (and View, held off by the caller's
// guard, can't make a second tab): hc run, pane.json, the tab, then the wait for the agent, then its first task.
// A failure after the orchestrator exists ends it again (kill and rm) and closes the tab, then throws. A tab that can't open
// is only a problem to say: the run is going and View connects it.
//   deps: { hc(args), writePaneJson(props), connect(props) -> slot (throws), closeTab(), openHost?() -> host (throws), closeHost?(host) }
//   The host (openHost, before anything else) is the orchestrator's parent so the Agents panel lists the run; one that won't open
//   is only a problem to say and the run starts with no parent. A failure that ends the orchestrator ends the host too.
//   runArgs: the `hc run` arguments for { id, key, workDir, argv, parent } (orchestratorRunArgs; investigate.js has its own labels and
//   no host: it passes no openHost, so its agent has no parent);
//   who: what the messages call the agent. Resolves with { orchestrator, problems, host }.
export async function launchRun(deps, { id, key, workDir, argv, task, props, runArgs = orchestratorRunArgs, who = "orchestrator" }) {
  const problems = [];
  let host = null;
  if (deps.openHost) {
    try { host = await deps.openHost(); }
    catch (e) { problems.push(`The Agents panel won't list this ${who === "agent" ? "session" : "run"}'s agents: its host tab didn't open (${why(e)}). The ${who === "agent" ? "session" : "run"} itself is going.`); }
  }
  const endHostToo = async () => { if (host) await Promise.resolve(deps.closeHost?.(host)).catch(() => {}); };
  const started = await deps.hc(runArgs({ id, key, workDir, argv, parent: host?.address })).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  const orchestrator = started.code === 0 ? parseStarted(started.stdout) : null;
  if (!orchestrator) { await endHostToo(); throw new Error(`The ${who} didn't start: ${String(started.stderr || started.stdout || "").trim() || "hc gave no address"}`); }
  const full = { ...props, orchestrator };
  await deps.writePaneJson(full).catch(() => {}); // View reconnects from this, so it is there before anything else can look
  try { await deps.connect(full); }
  catch (e) { problems.push(`Its tab didn't open: ${why(e)}. It is running; View connects to it.`); }
  const abort = async (message) => {
    await deps.hc(["kill", orchestrator]).catch(() => {});
    await deps.hc(["rm", orchestrator]).catch(() => {});
    try { deps.closeTab(); } catch { /* nothing to close */ }
    await endHostToo();
    throw new Error(message);
  };
  const ready = await waitReady({ hc: deps.hc, orchestrator });
  if (!ready.ok) await abort(`The ${who} didn't start properly, so it was ended: ${ready.why}`);
  const sent = await deps.hc(["send", orchestrator, task]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  if (sent.code !== 0) await abort(`The ${who} didn't take its task, so it was ended: ${String(sent.stderr || sent.stdout || "").trim() || "hc send failed"}`);
  return { orchestrator, problems, host };
}

// A new orchestrator for a run whose own has ended, started because the person pressed the red Merge button: the same command
// and labels as the first (so the run's agents, View and the page find it), shown in the run's tab, and its first task is the
// fix. Like launchRun but the tab is there already: the new address is saved first (pane.json, and saveOrchestrator for the
// page's shared state, so View and a reload follow it), then show puts it over the tab's left pane. A tab that can't show it is
// only a problem to say. A failure after the orchestrator exists ends it again and throws.
//   deps: { hc(args), writePaneJson(props), saveOrchestrator(address), show(address) (throws), findHost?() -> the run's live host or null }
//   The new orchestrator goes under the run's host when it is still there (as the first did), else it has no parent.
//   key (the ticket label) and argv (the orchestrator's command): as start.js saved them in pane.json; without them the run can't be started again.
//   Resolves with { orchestrator, problems }.
export async function restartOrchestrator(deps, { id, key, workDir, argv, task, props }) {
  if (!key || !Array.isArray(argv) || !argv.length) throw new Error("This run's orchestrator can't be started again: it was started before the command that opens it was saved. Fix it by hand.");
  const parent = deps.findHost?.()?.address ?? null;
  const started = await deps.hc(orchestratorRunArgs({ id, key, workDir, argv, parent })).catch((e) => ({ code: 1, stdout: "", stderr: why(e) }));
  const orchestrator = started.code === 0 ? parseStarted(started.stdout) : null;
  if (!orchestrator) throw new Error(`The orchestrator didn't start: ${String(started.stderr || started.stdout || "").trim() || "hc gave no address"}`);
  const problems = [];
  try { await deps.writePaneJson({ ...props, orchestrator }); }
  catch (e) { problems.push(`The run's pane.json wasn't updated with the new orchestrator: ${why(e)}. View may connect to the old address until it is.`); }
  deps.saveOrchestrator(orchestrator);
  try { await deps.show(orchestrator); }
  catch (e) { problems.push(`It isn't showing in the run's tab: ${why(e)}. It is running; View shows it.`); }
  const abort = async (message) => {
    await deps.hc(["kill", orchestrator]).catch(() => {});
    await deps.hc(["rm", orchestrator]).catch(() => {});
    throw new Error(message);
  };
  const ready = await waitReady({ hc: deps.hc, orchestrator });
  if (!ready.ok) await abort(`The new orchestrator didn't start properly, so it was ended: ${ready.why}`);
  const sent = await deps.hc(["send", orchestrator, task]).catch((e) => ({ code: 1, stdout: "", stderr: why(e) }));
  if (sent.code !== 0) await abort(`The new orchestrator didn't take its task, so it was ended: ${String(sent.stderr || sent.stdout || "").trim() || "hc send failed"}`);
  return { orchestrator, problems };
}

// What the run page shows once Merge has ended the run: done (its space, or for an older run its tab, and so the page, is closed), an error naming what
// couldn't be ended, or a note that the space couldn't be found. Anything but done frees the page from "Merging…".
export function mergeOutcome(ended) {
  if (ended.closed) return { done: true, error: null, note: null };
  if (ended.error) return { done: false, error: `Merged, but ${ended.error}`, note: null };
  return { done: false, error: null, note: { text: "Merged. This run's space couldn't be found to close: close it yourself.", detail: "The run has ended; only its space is left." } };
}

// The run tab's slot found from the run's own placeholder terminal (placeholderArgv's script names the orchestrator it was made for; a login-shell wrapper around the argv is fine), so it
// holds after ids changed (e.g. a Herdr restart). The tab is the one holding that terminal's pane, and only when it is the only such
// tab and holds exactly one github-tasks pane (the run page); otherwise null, never a guess. left = the saved left while it is a pane
// of that tab, else the placeholder's pane. The same slot object when nothing differs, so the caller can skip the write.
export function slotFromPage({ orchestrators, terminals, spaces, panes, slot }) {
  const mine = (terminals ?? []).filter(placeholderMatcher(orchestrators));
  const found = (panes ?? []).filter((p) => p.terminal && mine.some((t) => t.address === p.terminal));
  const tabs = [...new Set(found.map((p) => p.tab))];
  if (tabs.length !== 1) return null;
  const tab = tabs[0];
  const inTab = (panes ?? []).filter((p) => p.tab === tab);
  if (inTab.filter((p) => p.mod === "github-tasks").length !== 1) return null;
  const space = (spaces ?? []).find((s) => (s.tabs ?? []).some((t) => t.id === tab));
  if (!space) return null;
  const left = inTab.some((p) => p.pane === slot?.left) ? slot.left : found[0].pane;
  const next = { tab, left, space: space.id };
  return slot && slot.tab === next.tab && slot.left === next.left && slot.space === next.space ? slot : next;
}
