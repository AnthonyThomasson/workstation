// What Create Project does after it has made the project, with no agent: the Status field gets exactly the
// six fixed statuses, and every label a saved workflow triggers on exists in the repo. Pure: gh comes in as
// gh(args, { cwd, on }) -> { code, stdout, stderr } (like loader.js and labels.js), so node --test runs it.
import { GitHubError, loadStatusField } from "./loader.js";
import { loadLabels, hasLabel, LABEL_LIMIT } from "./labels.js";
import { STATUSES } from "./model.js";

export const STATUS_FIELD_MUTATION = "updateProjectV2Field";

// The mutation that replaces all of a field's options, in order. GitHub wants a color and a description on
// every option. The names are the fixed STATUSES, so they go into the text rather than through a variable.
export const statusOptionsMutation = (names) => `mutation($field: ID!) {
  ${STATUS_FIELD_MUTATION}(input: { fieldId: $field, singleSelectOptions: [${names.map((n) => `{ name: ${JSON.stringify(n)}, color: GRAY, description: "" }`).join(", ")}] }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
}`;

// Replaces the new project's Status options with the six statuses (Won't Do last). The project is brand new, so replacing is safe.
async function setStatuses(gh, project, where) {
  const field = await loadStatusField(gh, project.id, where);
  if (!field) throw new GitHubError("The project has no Status field.");
  const query = statusOptionsMutation(Object.values(STATUSES));
  const r = await gh(["api", "graphql", "-f", `query=${query}`, "-f", `field=${field.id}`], where);
  if (r.code !== 0) throw new GitHubError(r.stderr || r.stdout);
}

// The labels saved workflows trigger on, each once (labels match without regard to case), in order.
const triggerLabels = (workflows) => {
  const seen = [];
  for (const w of workflows) for (const name of w?.trigger?.labels ?? []) if (!hasLabel(seen.map((n) => ({ name: n })), name)) seen.push(name);
  return seen;
};

const why = (e) => String(e?.message ?? e);

// Sets up a project just made for the repo. Never throws: each part that fails adds a sentence to problems and
// the other part still runs. loadWorkflows(where) is workflow-env.js's, the set Start uses.
// Returns { created: [labels made], problems: [what failed], doctorFixes: whether the Doctor gives a fix for one
// of them (a statuses failure or a label that failed to create; not a workflow or label list that couldn't be read) }.
export async function setupProject(gh, { repo, project, loadWorkflows, where }) {
  const problems = [], created = [];
  let doctorFixes = false;

  try { await setStatuses(gh, project, where); }
  catch (e) { problems.push(`The statuses weren't set: ${why(e)}`); doctorFixes = true; }

  let wanted = [];
  try { wanted = triggerLabels((await loadWorkflows(where)).items ?? []); }
  catch (e) { problems.push(`The saved workflows couldn't be read, so their labels weren't checked: ${why(e)}`); }

  if (wanted.length) {
    let have = null;
    try { have = await loadLabels(gh, repo, where); }
    catch (e) { problems.push(`The repo's labels couldn't be read, so none were created: ${why(e)}`); }
    // A full page may be cut short, so a label past it would look missing: create none.
    if (have && have.length >= LABEL_LIMIT) {
      problems.push(`The repo has ${LABEL_LIMIT} or more labels, so they couldn't all be read and it can't tell which trigger labels are missing: ${wanted.join(", ")}. None were created.`);
      have = null;
    }
    for (const name of have ? wanted.filter((n) => !hasLabel(have, n)) : []) {
      try {
        // A name starting with "-" would be read as a flag, so it goes after "--".
        const r = await gh(name.startsWith("-") ? ["label", "create", "-R", repo, "--", name] : ["label", "create", name, "-R", repo], where);
        if (r.code !== 0) throw new GitHubError(r.stderr || r.stdout);
        created.push(name);
      } catch (e) { problems.push(`The label "${name}" wasn't created: ${why(e)}`); doctorFixes = true; }
    }
  }
  return { created, problems, doctorFixes };
}

// The sidebar's note after a setup that had problems; null when there were none. It points at the Doctor only
// when doctorFixes says the Doctor gives a fix for one of them.
export const setupNote = (problems, doctorFixes = false) => problems.length
  ? `The project was made and is linked, but its setup didn't finish. ${problems.join(" ")}${doctorFixes ? " The Doctor shows the fix." : ""}`
  : null;
