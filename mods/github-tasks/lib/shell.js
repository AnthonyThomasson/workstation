// How a machine runs a shell script or a Unix tool: sh on Unix, Git Bash on Windows, which has no sh (nor mv, rm, mkdir or chmod)
// on the PATH Herdr's exec searches. No Herdr in it: the local OS is passed in (widgets/local-shell.js reads it from Herdr's window()),
// so node --test runs it. runs/remote.js re-exports GIT_BASH and shArgv for runs/'s callers.

export const GIT_BASH = "C:/Program Files/Git/bin/bash.exe";

// This computer's OS as a host names it ("unix" | "windows"), from Herdr's window().platform: "windows" is Windows; "macos",
// "linux", or no window at all (window() is null while `herdr-app check` loads the mod) is Unix, as the mod always assumed.
export const localOs = (platform) => (platform === "windows" ? "windows" : "unix");

// A shell script run on a host, as exec's (cmd, args): sh -c on Unix, Git Bash -lc on Windows. $1... are `args`.
export const shArgv = (os, script, args = []) => (os === "windows"
  ? [GIT_BASH, ["-lc", script, "github-tasks", ...args]]
  : ["sh", ["-c", script, "github-tasks", ...args]]);

// A Unix tool (mv, rm, mkdir, chmod…) run on a host, as exec's (cmd, args): the tool itself on Unix, exactly as before; on Windows
// through Git Bash, whose /usr/bin has it (`exec "$@"` runs the tool with the arguments untouched).
export const toolArgv = (os, cmd, args = []) => (os === "windows"
  ? [GIT_BASH, ["-lc", 'exec "$@"', "github-tasks", cmd, ...args]]
  : [cmd, args]);

// A terminal's argv that is a `sh -c <script>` (a custom agent's command, the run tab's placeholder) as a host starts it: Git Bash
// -lc on Windows, unchanged elsewhere and for any other argv.
export const shellArgv = (argv, os) => (os === "windows" && argv?.[0] === "sh" && argv[1] === "-c" && argv.length === 3
  ? [GIT_BASH, "-lc", argv[2]]
  : argv);
