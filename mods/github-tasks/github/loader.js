// Asking GitHub, through a gh the caller hands in: gh(args, { cwd, on }) -> { code, stdout, stderr }.
// A failure throws a GitHubError whose kind is one of lib/gh-sign-in.js classifyError's.
import { classifyError, changes, checkTask, wontDoOption, STATUSES } from "../lib/index.js";

export const PAGE_SIZE = 100;
export const MAX_ITEMS = 1000;

export class GitHubError extends Error {
  constructor(text) {
    const message = String(text ?? "").trim().split("\n")[0] || "GitHub didn't answer.";
    super(message);
    this.kind = classifyError(text);
  }
}

const PROJECTS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { id title url closed }
    }
  }
}`;

// enableDuplicate: without it, GitHub reports a duplicate as NOT_PLANNED.
const ITEMS_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          status: fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            __typename
            ... on DraftIssue { id title createdAt }
            ... on Issue {
              number
              title
              url
              state
              stateReason(enableDuplicate: true)
              createdAt
              closedAt
              labels(first: 30) { nodes { name } }
              repository { nameWithOwner }
            }
          }
        }
      }
    }
  }
}`;

export function parseJson(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

// A query's data. GitHub can fail part of a query and still answer the rest, and gh then exits
// non-zero, so a partial answer is used unless the failure is about access.
async function graphql(gh, query, vars, where) {
  const fields = Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`]);
  const r = await gh(["api", "graphql", "-f", `query=${query}`, ...fields], where);
  const data = parseJson(r.stdout)?.data;
  if (r.code === 0 && data) return data;
  const failure = new GitHubError(r.stderr || r.stdout);
  if (failure.kind === "other" && data) return data;
  throw failure;
}

export async function findRepo(gh, where) {
  const r = await gh(["repo", "view", "--json", "nameWithOwner"], where);
  const repo = r.code === 0 ? parseJson(r.stdout)?.nameWithOwner : null;
  if (!repo) throw new GitHubError(r.stderr || r.stdout);
  return repo;
}

// The open projects linked to the repo, most recently updated first.
export async function findProjects(gh, repo, where) {
  const [owner, name] = repo.split("/");
  const data = await graphql(gh, PROJECTS_QUERY, { owner, name }, where);
  return (data.repository?.projectsV2?.nodes ?? []).filter((p) => p && !p.closed);
}

const REPO_OWNER_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id owner { id } }
}`;

const CREATE_PROJECT_MUTATION = `mutation($owner: ID!, $repo: ID!, $title: String!) {
  createProjectV2(input: { ownerId: $owner, repositoryId: $repo, title: $title }) {
    projectV2 { id title url closed }
  }
}`;

// Makes a project for the repo, titled with the repo's name and linked to it, owned by the repo's
// owner. Returns it as findProjects does.
export async function createProject(gh, repo, where) {
  const [owner, name] = repo.split("/");
  const data = await graphql(gh, REPO_OWNER_QUERY, { owner, name }, where);
  const found = data.repository;
  if (!found?.id || !found.owner?.id) throw new GitHubError(`GitHub has no repo called ${repo}.`);
  const fields = ["-f", `owner=${found.owner.id}`, "-f", `repo=${found.id}`, "-f", `title=${name}`];
  const r = await gh(["api", "graphql", "-f", `query=${CREATE_PROJECT_MUTATION}`, ...fields], where);
  const project = r.code === 0 ? parseJson(r.stdout)?.data?.createProjectV2?.projectV2 : null;
  if (!project?.id) throw new GitHubError(r.stderr || r.stdout);
  return project;
}

// A project's items, a page per call because exec has a time limit. keepGoing is asked before each
// further page, so a load nobody wants any more stops. truncated: the project has more than MAX_ITEMS.
export async function loadItems(gh, projectId, where, keepGoing = () => true) {
  const nodes = [];
  let cursor = null;
  for (;;) {
    const vars = cursor ? { id: projectId, cursor } : { id: projectId };
    const data = await graphql(gh, ITEMS_QUERY, vars, where);
    const items = data.node?.items;
    nodes.push(...(items?.nodes ?? []));
    const more = Boolean(items?.pageInfo?.hasNextPage);
    if (!more) return { nodes, truncated: false };
    if (nodes.length >= MAX_ITEMS) return { nodes, truncated: true };
    if (!keepGoing()) return { nodes, truncated: true };
    cursor = items.pageInfo.endCursor;
  }
}

// ---- One task: reading it, and writing back what changed --------------------------------------------

const DRAFT_QUERY = `query($id: ID!) {
  node(id: $id) { ... on DraftIssue { title body updatedAt } }
}`;

const STATUS_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
    }
  }
}`;

const DRAFT_MUTATION = `mutation($id: ID!, $title: String!, $body: String!) {
  updateProjectV2DraftIssue(input: { draftIssueId: $id, title: $title, body: $body }) { draftIssue { id } }
}`;

export const STATUS_MUTATION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
}`;

// A project item's position is the item it goes after (null or left out: the very top). The position is global across the project, not per
// Status.
export const POSITION_MUTATION = `mutation($project: ID!, $item: ID!, $after: ID) {
  updateProjectV2ItemPosition(input: { projectId: $project, itemId: $item, afterId: $after }) { clientMutationId }
}`;

// A mutation is all or nothing: unlike a read, a partial answer is a failure.
async function mutate(gh, query, vars, where) {
  const fields = Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`]);
  const r = await gh(["api", "graphql", "-f", `query=${query}`, ...fields], where);
  if (r.code !== 0) throw new GitHubError(r.stderr || r.stdout);
}

const ADD_DRAFT_MUTATION = `mutation($project: ID!, $title: String!) {
  addProjectV2DraftIssue(input: { projectId: $project, title: $title }) {
    projectItem { id content { ... on DraftIssue { id title createdAt } } }
  }
}`;

// Adds a draft task to the project and returns it as a ticket, ready to open in the editor.
export async function createDraft(gh, projectId, title, where) {
  const fields = ["-f", `project=${projectId}`, "-f", `title=${title}`];
  const r = await gh(["api", "graphql", "-f", `query=${ADD_DRAFT_MUTATION}`, ...fields], where);
  const item = r.code === 0 ? parseJson(r.stdout)?.data?.addProjectV2DraftIssue?.projectItem : null;
  if (!item?.id) throw new GitHubError(r.stderr || r.stdout);
  const c = item.content ?? {};
  return { key: item.id, contentId: c.id ?? null, draft: true, number: null, title: c.title ?? title, url: null, state: "OPEN", reason: null, createdAt: c.createdAt ?? new Date().toISOString(), closedAt: null, status: null, labels: [] };
}

// The ticket as GitHub has it now: { title, body, labels: [name], updatedAt }. An issue is read by gh
// issue view, a draft through the project. The caller's own status comes from the project item.
export async function loadTask(gh, repo, ticket, where) {
  if (ticket.draft) {
    const data = await graphql(gh, DRAFT_QUERY, { id: ticket.contentId }, where);
    const draft = data.node;
    if (!draft) throw new GitHubError("That draft is gone from the project.");
    return { title: draft.title ?? "", body: draft.body ?? "", labels: [], updatedAt: draft.updatedAt ?? null };
  }
  const r = await gh(["issue", "view", String(ticket.number), "-R", repo, "--json", "title,body,labels,updatedAt"], where);
  const issue = r.code === 0 ? parseJson(r.stdout) : null;
  if (!issue) throw new GitHubError(r.stderr || r.stdout);
  return { title: issue.title ?? "", body: issue.body ?? "", labels: (issue.labels ?? []).map((l) => l.name), updatedAt: issue.updatedAt ?? null };
}

// The project's Status field: { id, options: [{ id, name }] }, or null when it has none.
export async function loadStatusField(gh, projectId, where) {
  const data = await graphql(gh, STATUS_QUERY, { id: projectId }, where);
  const field = data.node?.field;
  return field?.id ? { id: field.id, options: field.options ?? [] } : null;
}

// Sends what differs between before and after, and nothing else: the title, body and labels of an
// issue (gh issue edit), or of a draft (a project mutation), then the status. Throws on the first
// failure; what was sent before it stays sent. Returns the keys it changed.
export async function saveTask(gh, { repo, ticket, project, statusField, before, after }, where) {
  const bad = checkTask(after, statusField?.options);
  if (bad) throw new GitHubError(bad);
  const diff = changes(before, after, { draft: ticket.draft });
  const keys = Object.keys(diff);
  if (!keys.length) return keys;

  if (ticket.draft) {
    if ("title" in diff || "body" in diff) {
      await mutate(gh, DRAFT_MUTATION, { id: ticket.contentId, title: after.title, body: after.body }, where);
    }
  } else if ("title" in diff || "body" in diff || diff.labels) {
    const args = ["issue", "edit", String(ticket.number), "-R", repo];
    if ("title" in diff) args.push(`--title=${diff.title}`);
    if ("body" in diff) args.push(`--body=${diff.body}`);
    for (const l of diff.labels?.add ?? []) args.push(`--add-label=${l}`);
    for (const l of diff.labels?.remove ?? []) args.push(`--remove-label=${l}`);
    const r = await gh(args, where);
    if (r.code !== 0) throw new GitHubError(r.stderr || r.stdout);
  }

  if ("status" in diff) {
    const option = statusField?.options.find((o) => o.name === diff.status);
    if (!option || !statusField) throw new GitHubError(`The project has no "${diff.status}" status.`);
    await mutate(gh, STATUS_MUTATION, { project: project.id, item: ticket.key, field: statusField.id, option: option.id }, where);
  }
  return keys;
}

// Moves a project item to just after another (afterId, an item key), or to the very top of the project when afterId is null. `after` is
// left out for the top: gh's -f would send an empty string, which is not a valid ID. Throws GitHubError (kind from the failing gh call).
export async function moveItem(gh, { projectId, itemId, afterId }, where) {
  await mutate(gh, POSITION_MUTATION, { project: projectId, item: itemId, ...(afterId ? { after: afterId } : {}) }, where);
}

// Marks an issue as not going to be done: sets the project Status to Won't Do, then closes the issue as "not planned".
// The Status goes first, so a failure there leaves the issue open and nothing changed. If the Status was set but closing
// failed, the error says so. Throws GitHubError (kind from the failing gh call).
export async function markWontDo(gh, { repo, ticket, project, statusField }, where) {
  if (ticket.draft) throw new GitHubError("A draft can't be closed: create the ticket first.");
  const option = wontDoOption(statusField?.options);
  if (!statusField || !option) throw new GitHubError(`The project has no "${STATUSES.wontDo}" status.`);
  await mutate(gh, STATUS_MUTATION, { project: project.id, item: ticket.key, field: statusField.id, option: option.id }, where);
  const r = await gh(["issue", "close", String(ticket.number), "-R", repo, "--reason", "not planned"], where);
  if (r.code !== 0) {
    const cause = new GitHubError(r.stderr || r.stdout);
    const failure = new GitHubError(`The status was set to ${STATUSES.wontDo}, but closing the issue failed: ${cause.message}`);
    failure.kind = cause.kind;
    throw failure;
  }
}
