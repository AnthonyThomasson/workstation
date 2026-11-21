// A run on another machine: its worktrees, run folder and agents live on that machine (a space's `where.on`), while the Task
// Orchestrator, the spawn and merge scripts and pane.json stay on this computer. Pure: exec is passed in, so node --test runs it.
//   exec(cmd, args, { on }) -> Promise<{ code, stdout, stderr }>, Herdr's exec (or `hc exec --on`).
// A machine is described as a host: { on, os: "unix" | "windows", home }, home in forward slashes (C:/Users/me on Windows).
// Windows has no sh: anything that needs a shell there goes through Git Bash, and git itself is called as plain git.

export const GIT_BASH = "C:/Program Files/Git/bin/bash.exe";

// What `uname -s` says on Git Bash, MSYS2 or Cygwin.
export const isWindowsKernel = (kernel) => /^(mingw|msys|cygwin)|windows/i.test(String(kernel ?? "").trim());

// A shell script run on a host, as exec's (cmd, args): sh -c on Unix, Git Bash -lc on Windows. $1... are `args`.
export const shArgv = (os, script, args = []) => (os === "windows"
  ? [GIT_BASH, ["-lc", script, "github-tasks", ...args]]
  : ["sh", ["-c", script, "github-tasks", ...args]]);

const UNIX_PROBE = 'uname -s; printf "%s\\n" "$HOME"';
const WINDOWS_PROBE = 'uname -s; cygpath -m "$HOME"';

// The two lines a probe prints: the kernel and the home folder.
export function parseProbe(stdout) {
  const [kernel = "", home = ""] = String(stdout ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim());
  return { kernel, home: home.replace(/\\/g, "/").replace(/\/+$/, "") };
}

// What a machine runs, found by asking it, never assumed from its name: sh first (any Unix); a machine with no sh, or whose sh
// is Windows' own (Git's sh on the PATH), is asked again through Git Bash for its home as a Windows path. Throws with the reason.
export async function probeMachine(exec, on) {
  const ask = (os, script) => { const [cmd, args] = shArgv(os, script); return exec(cmd, args, { on }).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) })); };
  const unix = await ask("unix", UNIX_PROBE);
  if (unix.code === 0) {
    const found = parseProbe(unix.stdout);
    if (!isWindowsKernel(found.kernel) && found.home.startsWith("/")) return { on, os: "unix", home: found.home };
  }
  const win = await ask("windows", WINDOWS_PROBE);
  if (win.code === 0) {
    const found = parseProbe(win.stdout);
    if (found.home) return { on, os: "windows", home: found.home };
  }
  const why = (r) => String(r.stderr || r.stdout || "").trim().split("\n")[0];
  throw new Error(`Couldn't tell what ${on} runs (sh: ${why(unix) || "no answer"}; Git Bash at ${GIT_BASH}: ${why(win) || "no answer"}).`);
}

// Runs a sh script on a machine as that machine runs one: on this computer (on unset) plain sh, never probed; elsewhere the
// machine's OS is asked first (probeMachine, once per machine: `seen` keeps the answers) so Windows gets Git Bash. A probe
// that fails resolves like a failed command ({ code: 1, stderr: why }), so a caller that reads code and stderr says why.
//   deps: { exec, probe = probeMachine, seen = a Map of machine -> host }
const SEEN = new Map();
export async function shOn({ exec, probe = probeMachine, seen = SEEN }, on, script, args = []) {
  let os = "unix";
  if (on) {
    try {
      if (!seen.has(on)) seen.set(on, await probe(exec, on));
      os = seen.get(on).os;
    } catch (e) {
      return { code: 1, stdout: "", stderr: String(e?.message ?? e) };
    }
  }
  const [cmd, argv] = shArgv(os, script, args);
  return exec(cmd, argv, ...(on ? [{ on }] : []));
}

// Where an agent's program is on a host: its bare name when the host's PATH has it, else the usual install folder
// (~/.local/bin, where Claude's installer puts it; .exe on Windows). null when neither runs.
export async function remoteProgram(exec, host, name) {
  const runs = async (cmd) => (await exec(cmd, ["--version"], { on: host.on }).catch(() => ({ code: 1 }))).code === 0;
  if (await runs(name)) return name;
  const installed = `${host.home}/.local/bin/${name}${host.os === "windows" ? ".exe" : ""}`;
  return (await runs(installed)) ? installed : null;
}

// An agent's command (agentArgv's) as the host runs it: its program swapped for the host's own (`program`), and a custom
// command's sh -c run through Git Bash on Windows.
export function hostArgv(argv, host, program = null) {
  if (argv[0] === "sh" && argv[1] === "-c" && argv.length === 3) return host.os === "windows" ? [GIT_BASH, "-lc", argv[2]] : argv;
  return program ? [program, ...argv.slice(1)] : argv;
}

// The prefix that runs git where the ticket's worktree is, for the orchestrator's prompt: plain git here, `hc exec --on` there.
export const gitWhere = (on) => (on ? `hc exec --on ${on} -- git` : "git");

// The sh lines that the spawn and merge scripts start with: `rgit` runs git, and `exists <path>` tests a path, where the worktrees
// are. Here, plain git and test; on a host, through `hc exec --on` (Git Bash on Windows, so git and the test see the same paths).
// quote: the scripts' sh quoting (shQuote).
export function hostShell(host, quote) {
  if (!host?.on) return ["rgit() { git \"$@\"; }", "exists() { [ -e \"$1\" ]; }"];
  const shell = host.os === "windows" ? `${quote(GIT_BASH)} -lc` : "sh -c";
  return [
    `machine=${quote(host.on)}`,
    `# runs a sh script on $machine: ${host.os === "windows" ? "through Git Bash, as Windows has no sh" : "with its sh"}`,
    `on_machine() { s=$1; shift; hc exec --on "$machine" --timeout 600 -- ${shell} "$s" github-tasks "$@"; }`,
    "rgit() { on_machine 'git \"$@\"' \"$@\"; }",
    "exists() { on_machine '[ -e \"$1\" ]' \"$1\"; }",
  ];
}
