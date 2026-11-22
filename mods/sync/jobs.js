// Runs long work on a machine: Herdr stops an exec after 30 s, so the sync script (it may reinstall
// skills over the network) runs as a detached job that is polled until it writes its exit code. Copied from
// the skills mod's job runner (not imported: mods do not import each other). No Herdr imports: main.js
// passes Herdr's exec and file reads in, and the tests (jobs.test.js) pass real sh and fs.

// Long work runs detached, its output kept in a temp folder (out, err, code, pid) that we poll. Herdr
// ends an exec's whole process group when the exec returns, so the job gets its own: setsid where it
// exists (Linux), or sh job control (macOS, whose sh is bash; dash turns job control off without a
// terminal, but Linux has setsid). Never both: a job that already leads its group makes setsid fork
// and exit. The job writes its own pid once detached, and the starter waits for it (up to 5 s) so it
// is not ended before then. Herdr also hangs up programs that carry the exec's HC_SCOPE once the exec
// returns (git died with exit 129), so the job drops it.
// Git Bash and Cygwin have no setsid, and job control stays off there: a job in a background process group that starts a Windows
// program (git.exe, skillshare.exe) can be stopped by the console it shares, and then never writes its exit code.
const DETACH = 'unset HC_SCOPE; if command -v setsid >/dev/null 2>&1; then bg() { exec setsid "$@"; }; else case "${OSTYPE:-}" in msys*|cygwin*) ;; *) set -m ;; esac; bg() { exec "$@"; }; fi';
// Named so SWEEP can tell our job folders from anything else in the temp folder.
const TEMP = 'd=$(mktemp -d "${TMPDIR:-/tmp}/sync-mod-job.XXXXXX")';
// Then prints the folder as the machine itself names it, so readText finds it: cygpath -m on Git Bash, MSYS2 or Cygwin (/tmp/x is
// C:/Users/…/Temp/x there, which Windows programs read; /c/Users/… they can't), the path as it is elsewhere.
const READY = 'i=0; while [ ! -s "$d/pid" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; if command -v cygpath >/dev/null 2>&1; then cygpath -m "$d"; else printf %s "$d"; fi';

// sh -c START <name> <script> <args...>: runs our script given <args...>; prints the temp folder.
export const START = `${DETACH}; ${TEMP}; script=$1; shift
bg sh -c 'echo $$ >"$1/pid"; d=$1; script=$2; shift 2; sh -c "$script" job "$@" >"$d/out" 2>"$d/err" </dev/null; echo $? >"$d/code"' job "$d" "$script" "$@" >/dev/null 2>&1 </dev/null &
${READY}`;

// sh -c ALIVE <name> <temp folder>: fails when the job stopped without writing its exit code.
// A killed job nobody reaps stays a zombie (a container without init) that kill -0 still finds,
// so a zombie counts as stopped. Where ps has no -p (busybox), only kill -0 decides.
export const ALIVE = '[ -s "$1/code" ] || { p=$(cat "$1/pid" 2>/dev/null); kill -0 "$p" 2>/dev/null && ! ps -o stat= -p "$p" 2>/dev/null | grep -q Z; } || [ -s "$1/code" ]';

// The longest we wait for one job, and so how old a job folder must be before SWEEP may remove it.
export const JOB_MINUTES = 15;

// sh -c SWEEP: removes job folders nobody will read: a view that closed mid-job never collects its
// result. Keeps a job that still runs and any folder changed in the last JOB_MINUTES.
export const SWEEP = `for d in "\${TMPDIR:-/tmp}"/sync-mod-job.*; do
  [ -d "$d" ] && [ -n "$(find "$d" -prune -mmin +${JOB_MINUTES})" ] || continue
  [ ! -s "$d/code" ] && sh -c '${ALIVE}' alive "$d" && continue
  rm -rf "$d"
done; exit 0`;

// How long a budget is, as the message says it: "15 minutes", "1 minute", "0.1 seconds".
export const spellBudget = (ms) => (ms >= 60000 && ms % 60000 === 0
  ? `${ms / 60000} minute${ms === 60000 ? "" : "s"}` : `${ms / 1000} second${ms === 1000 ? "" : "s"}`);

const lastLine = (text) => String(text ?? "").trim().split("\n").filter((l) => l.trim()).pop()?.trim() ?? "";

// createRunner({ exec, readText }):
//   exec(script, args, on) runs `sh -c script` on machine `on` (null: this computer) and resolves
//     to { code, stdout, stderr }; it must not reject. Herdr stops an exec after 30 s.
//   readText(path, on) resolves to the file's text, or null when it can't be read.
// The returned runner:
//   sh(script, args, on): one exec of a script of ours. Short reads only.
//   job(args, { on, script, sleep }): our `script` given args, run detached. Resolves when it ends to { code, stdout, stderr }; a job that
//     dies without an exit code, or runs past its budget, resolves with code 1 and the reason.
//     `sleep(ms)` waits between polls (a Herdr view passes cx.sleep).
//   budgetMs: how long a job may take, in wall time from its start (JOB_MINUTES by default); now() reads the clock.
// The first job on each machine also removes job folders that a closed view never collected.
export function createRunner({ exec, readText, pollMs = 500, aliveEvery = 10, budgetMs = JOB_MINUTES * 60 * 1000, now = Date.now }) {
  const swept = new Set();
  const read = (path, on) => Promise.resolve().then(() => readText(path, on)).catch(() => null);
  const sh = (script, args = [], on = null) => exec(script, args, on);

  async function job(args, { on = null, script, sleep }) {
    if (!swept.has(on ?? "")) { swept.add(on ?? ""); sh(SWEEP, [], on); }
    const until = now() + budgetMs;
    const s = await sh(START, [script, ...args], on);
    const d = lastLine(s.stdout); // the folder is START's last line, whatever a shell's startup printed before it
    if (s.code !== 0 || !d) return { code: s.code || 1, stdout: "", stderr: s.stderr || "Could not start the job" };
    const done = async (result) => { await sh('rm -rf "$1"', [d], on); return result; };
    for (let i = 1; now() < until; i++) {
      await sleep(pollMs);
      const code = await read(`${d}/code`, on);
      if (code !== null && code.trim() !== "") {
        const [stdout, stderr] = await Promise.all([read(`${d}/out`, on), read(`${d}/err`, on)]);
        return done({ code: Number(code.trim()), stdout: stdout ?? "", stderr: stderr ?? "" });
      }
      // A job that was killed never writes its code, so check now and then that it still runs.
      if (i % aliveEvery === 0 && (await sh(ALIVE, [d], on)).code === 1) {
        const err = await read(`${d}/err`, on);
        return done({ code: 1, stdout: "", stderr: lastLine(err) || "The job stopped before it finished" });
      }
    }
    const said = lastLine(await read(`${d}/err`, on));
    return { code: 1, stdout: "", stderr: `The job took longer than ${spellBudget(budgetMs)}${said ? `; it last said: ${said}` : ""}` };
  }

  return { sh, job };
}
