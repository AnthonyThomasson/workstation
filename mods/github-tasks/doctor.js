// The doctor: what is wrong with the Tasks setup, and a prompt an agent can use to fix it. Pure: gathering the
// inputs (gh, files, the installed agents) is doctor-run.js, so node --test runs this against plain data.
//
// Not problems, because the person decided they are valid: a workflow with no labels (the fallback) and an empty prompt.
import { STATUSES, sameStatus, REFRESH, LOGIN } from "./model.js";
import { ROLES, ROLE_LABELS, CUSTOM } from "./workflow-model.js";
import { hasLabel } from "./labels.js";

export const DOCTOR_KEY = "github-tasks.doctor"; // { issues, repo, project }: what the last check found, for the settings and the sidebar

// diagnose(inputs) -> [{ kind, message, ... }], in the order they should be read.
//   repo           "owner/name"; null when the space is not in a GitHub repo (no project or status checks then); undefined when not known
//   project        { id, title, url } | null (the repo has no linked project) | undefined (not known: gh could not answer)
//   statuses       the project's Status field options [{ name }] ([] with no such field) | undefined (not known)
//   labels         the repo's labels [{ name }] | undefined (not known: no repo, or gh could not list them)
//   carried        the project, status and label issues of the last check of this same place, kept for whatever above is not known
//   auth           { installed, signedIn: true | false | null (not known), scopes: [string] | null (gh did not list them) } | undefined
//   agents         what knownAgents() knows: [{ key, installed }] | null (not known)
//   groomerAgent   the task agent saved on the settings page, or null
//   workflows      { items: [workflow], errors: ["file.yaml: why"] } as store.loadAll gives them
// Kinds: no-project, status-missing, status-misnamed, label-missing, gh-auth, gh-scope, agent-missing, workflow-invalid.
export function diagnose({ repo, project, statuses, labels, carried = [], auth, agents = null, groomerAgent = null, workflows } = {}) {
  return [
    ...checkAuth(auth),
    ...checkProject({ repo, project, statuses, carried }),
    ...checkLabels({ repo, labels, carried }, workflows?.items ?? []),
    ...checkAgents(agents, groomerAgent, workflows?.items ?? []),
    ...(workflows?.errors ?? []).map((error) => ({ kind: "workflow-invalid", message: `A workflow file can't be read: ${error}`, file: error })),
  ];
}

function checkAuth(auth) {
  if (!auth) return [];
  if (!auth.installed) return [{ kind: "gh-auth", message: "gh isn't installed or can't run, so Tasks can't reach GitHub." }];
  if (auth.signedIn === false) return [{ kind: "gh-auth", message: "gh isn't signed in to GitHub." }];
  if (Array.isArray(auth.scopes) && !auth.scopes.includes("project")) {
    return [{ kind: "gh-scope", message: 'gh\'s token is missing the "project" scope, so Tasks can\'t read or edit GitHub Projects.', scopes: auth.scopes }];
  }
  return [];
}

const PROJECT_KINDS = ["no-project", "status-missing", "status-misnamed"];
function checkProject({ repo, project, statuses, carried }) {
  const kept = (kinds) => (carried ?? []).filter((i) => kinds.includes(i.kind));
  if (repo === null) return [];
  if (repo === undefined || project === undefined) return kept(PROJECT_KINDS);
  if (project === null) return [{ kind: "no-project", message: `No GitHub Project is linked to ${repo}.` }];
  if (!Array.isArray(statuses)) return kept(PROJECT_KINDS.slice(1));
  const issues = [];
  for (const status of Object.values(STATUSES)) {
    if (statuses.some((o) => o.name === status)) continue;
    const found = statuses.find((o) => sameStatus(o.name, status))?.name;
    issues.push(found === undefined
      ? { kind: "status-missing", status, message: `The project has no "${status}" status.` }
      : { kind: "status-misnamed", status, found, message: `The project calls the "${status}" status "${found}"; it should be named "${status}".` });
  }
  return issues;
}

// One issue per label that a saved workflow triggers on and the repo does not have (compared without regard to case, as GitHub
// does), listing the workflows. With the repo's labels unknown the last check's label issues are kept, for the labels still
// triggered on.
function triggerLabels(items) {
  const found = new Map(); // lower-case name -> { label, usedBy }, in the order found
  for (const w of items) {
    for (const raw of w?.trigger?.labels ?? []) {
      const label = String(raw ?? "").trim();
      if (!label) continue;
      const entry = found.get(label.toLowerCase()) ?? { label, usedBy: [] };
      if (!entry.usedBy.includes(w.name)) entry.usedBy.push(w.name);
      found.set(label.toLowerCase(), entry);
    }
  }
  return [...found.values()];
}
function checkLabels({ repo, labels, carried }, items) {
  if (repo === null) return [];
  const wanted = triggerLabels(items);
  if (typeof repo !== "string" || !Array.isArray(labels)) {
    return (carried ?? []).filter((i) => i.kind === "label-missing" && wanted.some((w) => hasLabel([{ name: w.label }], i.label)));
  }
  return wanted.filter((w) => !hasLabel(labels, w.label)).map(({ label, usedBy }) => ({
    kind: "label-missing", label, usedBy, message: `The label "${label}" isn't in ${repo} (the trigger of ${usedBy.join(", ")}).`,
  }));
}

// One issue per agent that knownAgents() knows and reports as not installed, listing everything that uses it. A custom agent
// runs its own command, and a key knownAgents() does not know is run as a bare command (as a run does), so neither is flagged.
function checkAgents(agents, groomerAgent, items) {
  if (!Array.isArray(agents)) return [];
  const missing = new Set(agents.filter((a) => !a.installed).map((a) => a.key));
  const uses = new Map(); // agent key -> what uses it, in the order found
  const add = (agent, user) => { if (agent && agent !== CUSTOM && missing.has(agent)) uses.set(agent, [...(uses.get(agent) ?? []), user]); };
  add(groomerAgent, "Task agent");
  for (const w of items) for (const role of ROLES) add(w[role]?.agent, `${w.name} ${ROLE_LABELS[role].toLowerCase()}`);
  return [...uses].map(([agent, usedBy]) => ({
    kind: "agent-missing", agent, usedBy, message: `The agent "${agent}" isn't installed (used by ${usedBy.join(", ")}).`,
  }));
}

// What gh auth status said: { installed, signedIn, scopes }. signedIn is false only when gh says there is no account at all or
// the active account's token is invalid; a network failure, a validation error, or a stale second account is not known to be
// a problem (null). scopes: those of the active, logged-in account; null when gh lists none (a GH_TOKEN, say).
export function parseAuthStatus({ code, stdout = "", stderr = "" }) {
  if (code === 127) return { installed: false, signedIn: false, scopes: null };
  const text = `${stdout}\n${stderr}`;
  // One block per account: gh starts each with "✓ Logged in to <host> account <name>" or "X Failed to log in to <host> account <name>".
  const blocks = text.split(/(?=^.*\b(?:Logged in to|Failed to log in to) \S+ account)/m).filter((b) => /(?:Logged in to|Failed to log in to) \S+ account/.test(b));
  const active = blocks.filter((b) => /Active account:\s*true/i.test(b));
  const judged = active.length ? active : blocks;
  const good = judged.find((b) => /Logged in to /.test(b) && !/Failed to log in/.test(b));
  if (good) {
    const line = good.match(/Token scopes:\s*(.*)/i)?.[1] ?? "";
    const scopes = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    return { installed: true, signedIn: true, scopes: scopes.length ? scopes : null };
  }
  const none = { installed: true, scopes: null };
  if (/not logged in(to)? any/i.test(text)) return { ...none, signedIn: false };
  if (judged.length) {
    const invalid = /token .{0,40}\binvalid\b|bad credentials|HTTP 401|has been revoked|expired/i.test(judged.join("\n"));
    return { ...none, signedIn: invalid ? false : null };
  }
  return { ...none, signedIn: code === 0 ? true : null };
}

// What a check depends on. When it changes, the check runs again. The place is its repo's top folder (cwd when it has none),
// so moving about inside one repo is not a change.
export const doctorSignature = ({ place, workflowsChanged, groomer, project }) => JSON.stringify([
  place?.root ?? place?.cwd ?? null, place?.on ?? null, workflowsChanged ?? null, groomer?.agent ?? null, project ?? null,
]);

// Whether a check made for `checked` ({ cwd, on, root }) still describes `place` ({ cwd, on }): the same machine, and the same
// folder or one inside the checked repo.
export function samePlace(checked, place) {
  if (!checked || !place) return !checked && !place;
  if ((checked.on ?? null) !== (place.on ?? null)) return false;
  if (checked.cwd === place.cwd) return true;
  return Boolean(checked.root && place.cwd && (place.cwd === checked.root || place.cwd.startsWith(`${checked.root.replace(/\/+$/, "")}/`)));
}

// What the settings page and the sidebar read from the shared key: the doctor's answer, or nothing when it was made for another place.
export const doctorFor = (found, place) => (found && samePlace(found.place ?? null, place ?? null) ? found : null);

// A prompt to copy to an agent: the repo and project, the problems, and what to do about each.
// context: { repo, project: { title, url } | null }. "" when there is nothing wrong.
export function fixPrompt(issues, { repo = null, project = null } = {}) {
  if (!issues?.length) return "";
  const where = repo ?? "the repo of this space";
  const board = project ? `the GitHub Project "${project.title ?? ""}"${project.url ? ` (${project.url})` : ""}` : null;
  const by = (...kinds) => issues.filter((i) => kinds.includes(i.kind));
  const steps = [];

  for (const i of by("gh-auth")) steps.push(`gh: ${i.message} Sign in with \`gh ${LOGIN.join(" ")}\`, which opens a browser for the person to approve.`);
  for (const i of by("gh-scope")) steps.push(`gh: ${i.message} Add it with \`gh ${REFRESH.join(" ")}\`, which opens a browser for the person to approve.`);
  for (const i of by("no-project")) {
    steps.push(`Project: ${i.message} Create one in the repo owner's account with \`gh project create --owner <owner> --title <title>\` and link it with \`gh project link <number> --owner <owner> --repo ${repo ?? "<owner/repo>"}\`. Then check its statuses below.`);
  }
  const statuses = by("status-missing", "status-misnamed");
  if (statuses.length) {
    steps.push(`Statuses: ${board ?? "The project"} must have a Status field with exactly these options: ${Object.values(STATUSES).join(", ")}. Tasks matches them by name, so spell them exactly like that, with these capitals and spaces.`);
    for (const i of statuses) {
      steps.push(i.kind === "status-missing"
        ? `Create the status "${i.status}" on the project's Status field.`
        : `Rename the status "${i.found}" to "${i.status}". Rename it in place, so the tickets keep their status: don't delete the option and recreate it. The project's Settings page on GitHub can do this.`);
    }
    steps.push("Existing tickets must keep their statuses. Don't remove or reorder the other options.");
  }
  for (const i of by("label-missing")) {
    const name = /^[\w.:-]+$/.test(i.label) ? i.label : `'${i.label.replace(/'/g, `'\\''`)}'`;
    // A name starting with "-" would be read as a flag, even quoted, so it goes after "--".
    const into = repo ?? "<owner/repo>", create = i.label.startsWith("-") ? `-R ${into} -- ${name}` : `${name} -R ${into}`;
    steps.push(`Label: ${i.message} Create it with \`gh label create ${create}\`, so the workflow starts for tickets that have it.`);
  }
  for (const i of by("agent-missing")) steps.push(`Agent: ${i.message} Install it, or open the Tasks settings and the workflows that use it and choose an installed agent instead.`);
  for (const i of by("workflow-invalid")) {
    steps.push(`Workflow file: ${i.message} Workflows are YAML files in \`~/.config/herdr-app/workflows/\` (global) or \`.herdr/workflows/\` in the repo. Read the file, fix what the error says, and keep everything else in it as it is.`);
  }

  return [
    `# You are helping the person fix the Tasks setup of ${where}`, "",
    "## Context", "",
    `- Tasks is a Herdr module that shows ${board ?? "the GitHub Project linked to the repo"} as a ticket list and starts agent workflows on tickets.`,
    `- The repo is ${where}. You are working in its folder.`,
    board ? `- The project is ${board}.` : "- The repo has no project known to Tasks yet.",
    "- Tasks' doctor found these problems:",
    ...issues.map((i) => `  - ${i.message}`), "",
    "## What to do", "",
    ...steps.map((s, n) => `${n + 1}. ${s}`), "",
    "## While you work", "",
    "- Ask the person before you change anything on GitHub or in their files, and say what you will change first.",
    "- Fix only the problems above.",
    "- When you are done, tell the person to reopen the Tasks settings: the doctor checks again by itself within a minute.",
  ].join("\n");
}
