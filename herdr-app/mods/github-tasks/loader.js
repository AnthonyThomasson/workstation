// Asking GitHub, through a gh the caller hands in: gh(args, { cwd, on }) -> { code, stdout, stderr }.
// A failure throws a GitHubError whose kind is one of model.js classifyError's.
import { classifyError } from "./model.js";

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
            ... on DraftIssue { title createdAt }
            ... on Issue {
              number
              title
              url
              state
              stateReason(enableDuplicate: true)
              createdAt
              repository { nameWithOwner }
            }
          }
        }
      }
    }
  }
}`;

function parse(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

// A query's data. GitHub can fail part of a query and still answer the rest, and gh then exits
// non-zero, so a partial answer is used unless the failure is about access.
async function graphql(gh, query, vars, where) {
  const fields = Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`]);
  const r = await gh(["api", "graphql", "-f", `query=${query}`, ...fields], where);
  const data = parse(r.stdout)?.data;
  if (r.code === 0 && data) return data;
  const failure = new GitHubError(r.stderr || r.stdout);
  if (failure.kind === "other" && data) return data;
  throw failure;
}

export async function findRepo(gh, where) {
  const r = await gh(["repo", "view", "--json", "nameWithOwner"], where);
  const repo = r.code === 0 ? parse(r.stdout)?.nameWithOwner : null;
  if (!repo) throw new GitHubError(r.stderr || r.stdout);
  return repo;
}

// The open projects linked to the repo, most recently updated first.
export async function findProjects(gh, repo, where) {
  const [owner, name] = repo.split("/");
  const data = await graphql(gh, PROJECTS_QUERY, { owner, name }, where);
  return (data.repository?.projectsV2?.nodes ?? []).filter((p) => p && !p.closed);
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
