// What a gh failure means, and how the browser sign-in starts. No Herdr in it.

// The gh commands that sign in with the permission Tasks needs. "project" lets Tasks read Projects and edit them;
// it includes read:project. auth.js runs them; the doctor names them in its prompt.
const GRANT = ["-h", "github.com", "-s", "project"];
export const REFRESH = ["auth", "refresh", ...GRANT];
export const LOGIN = ["auth", "login", "-h", "github.com", "-p", "https", "-s", "project", "-w"];

// What a gh failure means: no-write-scope, no-scope, no-auth, not-a-repo, or other.
// GitHub names the scopes a field needs: a mutation on a project asks for plain "project", a read
// for "read:project".
export function classifyError(text) {
  const s = String(text ?? "");
  if (/scopes?:\s*\[\s*'project'\s*\]/i.test(s)) return "no-write-scope";
  if (/read:project|INSUFFICIENT_SCOPES|required scopes/i.test(s)) return "no-scope";
  if (/gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(s)) return "no-auth";
  if (/not a git repository|no git remotes|none of the git remotes|could not determine (the )?(base )?repo/i.test(s)) return "not-a-repo";
  return "other";
}

// What gh printed while it waits for the browser: its one-time code, and the page to enter it on.
export function signInFrom(text) {
  const s = String(text ?? "");
  return { code: s.match(/code \(([A-Z0-9-]+)\)/)?.[1] ?? null, url: s.match(/https:\/\/\S+/)?.[0] ?? null };
}
