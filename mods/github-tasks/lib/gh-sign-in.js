// What a gh failure means, and how the browser sign-in starts. No Herdr in it.
import { machinePath } from "./machine-path.js";

// The gh commands that sign in with the permission Tasks needs. "project" lets Tasks read Projects and edit them;
// it includes read:project. auth.js runs them; the doctor names them in its prompt.
const GRANT = ["-h", "github.com", "-s", "project"];
export const REFRESH = ["auth", "refresh", ...GRANT];
export const LOGIN = ["auth", "login", "-h", "github.com", "-p", "https", "-s", "project", "-w"];

// The sign-in, as sh scripts (auth.js runs them with runs/ shOn: sh here and on Unix, Git Bash on Windows). gh's output goes to
// a new folder, so its one-time code can be read while it waits for the browser, and its exit code goes to code when it ends.
// SIGN_IN_PREPARE makes the folder and prints it, then the machine's kernel (uname -s). The folder is printed as the machine's
// own path (cygpath -m on Git Bash: C:/Users/…/Temp/tmp.x, not /tmp/tmp.x), because Herdr reads the files in it there.
export const SIGN_IN_PREPARE = `d=$(mktemp -d) || exit 1; ${machinePath('"$d"')}; uname -s 2>/dev/null || true`;
// On this Mac: gh runs detached ($1 is the folder, then gh's arguments) and opens the browser here.
export const SIGN_IN = 'd=$1; shift; ( GH_PROMPT_DISABLED=1 gh "$@" </dev/null >"$d/out" 2>"$d/err"; echo $? > "$d/code" ) >/dev/null 2>&1 &';
// Anywhere else (another machine, or not a Mac): the device flow, finished from the laptop's browser. gh still prints its code
// and github.com/login/device; a no-op browser keeps it from opening one on that machine. gh runs in the foreground, so the
// exec that runs this stays open until gh ends: hc exec would kill a detached gh once the shell exits.
export const SIGN_IN_DEVICE = 'd=$1; shift; GH_BROWSER=true BROWSER=true GH_PROMPT_DISABLED=1 gh "$@" </dev/null >"$d/out" 2>"$d/err"; echo $? > "$d/code"';
export const DEVICE_URL = "https://github.com/login/device";
// How long the device flow's held-open exec may run: Herdr's exec cap (its default, 30s, would kill gh mid-sign-in), as the
// spawn scripts' hc exec --timeout 600. The mod stops waiting at the same point; on the Mac gh is detached, so it waits as long
// as GitHub's device codes last (about 15 minutes).
export const DEVICE_TIMEOUT_MS = 600000;
export const signInSeconds = (device) => (device ? DEVICE_TIMEOUT_MS / 1000 : 900);

// SIGN_IN_PREPARE's two lines: { dir, kernel }.
export function preparedFrom(stdout) {
  const [dir = "", kernel = ""] = String(stdout ?? "").split(/\r?\n/).map((l) => l.trim());
  return { dir, kernel };
}
// Whether the sign-in uses the device flow: on another machine (on set), or on a machine that isn't a Mac.
export const usesDeviceFlow = (on, kernel) => Boolean(on) || String(kernel ?? "").trim().toLowerCase() !== "darwin";

// Removes the sign-in's folder ($1) once it is read.
export const SIGN_IN_CLEANUP = 'rm -rf "$1"';

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
