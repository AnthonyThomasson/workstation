// The doctor: what is wrong with the Tasks setup, and a prompt an agent can use to fix it. Pure: gathering the
// inputs (gh, files, the installed agents) is doctor-run.js, so node --test runs this against plain data.
//
// Not problems, because the person decided they are valid: a workflow with no labels (the fallback) and an empty prompt.
import { STATUSES, sameStatus, REFRESH, LOGIN } from "./model.js";
import { ROLES, ROLE_LABELS, CUSTOM } from "./workflow-model.js";

export const DOCTOR_KEY = "github-tasks.doctor"; // { issues, repo, project }: what the last check found, for the settings and the sidebar

// diagnose(inputs) -> [{ kind, message, ... }], in the order they should be read.
//   repo           "owner/name", or null when the space is not in a GitHub repo (no project or status checks then)
//   project        { id, title, url } | null (the repo has no linked project) | undefined (not known: gh could not answer)
//   statuses       the project's Status field options [{ name }] ([] with no such field) | undefined (not known)
//   auth           { installed, signedIn, scopes: [string] | null (gh did not list them) } | undefined (not known)
//   installedAgents  the keys of the installed agents | null (not known)
//   groomerAgent   the grooming agent saved on the settings page, or null
//   workflows      { items: [workflow], errors: ["file.yaml: why"] } as store.loadAll gives them
// Kinds: no-project, status-missing, status-misnamed, gh-auth, gh-scope, agent-missing, workflow-invalid.
export function diagnose({ repo = null, project, statuses, auth, installedAgents = null, groomerAgent = null, workflows } = {}) {
  return [
    ...checkAuth(auth),
    ...(repo ? checkProject(repo, project, statuses) : []),
    ...checkAgents(installedAgents, groomerAgent, workflows?.items ?? []),
    ...(workflows?.errors ?? []).map((error) => ({ kind: "workflow-invalid", message: `A workflow file can't be read: ${error}`, file: error })),
  ];
}

function checkAuth(auth) {
  if (!auth) return [];
  if (!auth.installed) return [{ kind: "gh-auth", message: "gh isn't installed or can't run, so Tasks can't reach GitHub." }];
  if (!auth.signedIn) return [{ kind: "gh-auth", message: "gh isn't signed in to GitHub." }];
  if (Array.isArray(auth.scopes) && !auth.scopes.includes("project")) {
    return [{ kind: "gh-scope", message: 'gh\'s token is missing the "project" scope, so Tasks can\'t read or edit GitHub Projects.', scopes: auth.scopes }];
  }
  return [];
}

function checkProject(repo, project, statuses) {
  if (project === null) return [{ kind: "no-project", message: `No GitHub Project is linked to ${repo}.` }];
  if (!project || !Array.isArray(statuses)) return [];
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

// One issue per agent that is not installed, listing everything that uses it. A custom agent runs its own command.
function checkAgents(installed, groomerAgent, items) {
  if (!Array.isArray(installed)) return [];
  const uses = new Map(); // agent key -> what uses it, in the order found
  const add = (agent, user) => { if (agent && agent !== CUSTOM && !installed.includes(agent)) uses.set(agent, [...(uses.get(agent) ?? []), user]); };
  add(groomerAgent, "Grooming agent");
  for (const w of items) for (const role of ROLES) add(w[role]?.agent, `${w.name} ${ROLE_LABELS[role].toLowerCase()}`);
  return [...uses].map(([agent, usedBy]) => ({
    kind: "agent-missing", agent, usedBy, message: `The agent "${agent}" isn't installed (used by ${usedBy.join(", ")}).`,
  }));
}

// What gh auth status said: { installed, signedIn, scopes }. The scopes of the active account; null when gh lists none.
export function parseAuthStatus({ code, stdout = "", stderr = "" }) {
  if (code === 127) return { installed: false, signedIn: false, scopes: null };
  const signedIn = code === 0;
  const blocks = `${stdout}\n${stderr}`.split(/(?=^\s*\S*\s*Logged in to )/m).filter((b) => /Logged in to /.test(b));
  const block = blocks.find((b) => /Active account:\s*true/i.test(b)) ?? blocks[0] ?? "";
  const line = block.match(/Token scopes:\s*(.*)/i)?.[1] ?? "";
  const scopes = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return { installed: true, signedIn, scopes: signedIn && scopes.length ? scopes : null };
}

// What a check depends on. When it changes, the check runs again.
export const doctorSignature = ({ place, context, workflowsChanged, groomer }) => JSON.stringify([
  place?.cwd ?? null, place?.on ?? null, context?.repo ?? null, context?.project?.id ?? null, workflowsChanged ?? null, groomer?.agent ?? null,
]);

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
