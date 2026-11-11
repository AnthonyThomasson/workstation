// herdr-tasks, the command line of GitHub Tasks: bin/herdr-tasks runs this file with node. Everything the Tasks UI does happens in the
// Herdr app, in this mod, so the command doesn't do it itself: it writes a request into the mailbox (workflow/places.js cliRequestsDir),
// tells the Tasks sidebar to look (`herdr-app do github-tasks.cli`, delivered to its nextCommand(); it also watches the folder), and
// waits for the reply the sidebar's bridge (cli-ui/bridge.js) writes. Runs started this way are the same runs the play button
// starts: the UI knows them. protocol.js has the files, commands.js the commands and format.js what is printed.
// Plain node: this file is never imported by the mod (it isn't in cli/index.js), so it may use node's own modules.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliRepliesDir, cliRequestsDir } from "../workflow/index.js";
import { CLI_ACTION } from "../lib/index.js";
import { EXIT, claimedName, exitFor, fileName, makeRequest, requestId } from "./protocol.js";
import { parseArgv } from "./commands.js";
import { formatReply } from "./format.js";

export const CLAIM_WAIT = 10000; // how long a request may wait for the sidebar to take it before Herdr counts as not answering
export const POKE_FAILED_WAIT = 3000; // the same once `herdr-app do` has failed (no window open, say)
const TICK = 100;

// The texts of --body-file (a file, or "-" for what is piped in), read here so the request carries the text itself.
function withFiles(args, io) {
  if (args.bodyFile === undefined) return args;
  const { bodyFile, ...rest } = args;
  const text = bodyFile === "-" ? io.stdin() : io.read(path.resolve(io.cwd(), bodyFile));
  if (text === null) throw new Error(`Can't read ${bodyFile}.`);
  return { ...rest, body: text };
}

// Waits for the reply to request id. { reply } or { error } (Herdr didn't take it, or didn't answer in time).
async function waitForReply(id, { requests, replies, deadline, poked, started }, io) {
  const waiting = path.join(requests, fileName(id)), claimed = path.join(requests, claimedName(id)), answer = path.join(replies, fileName(id));
  for (;;) {
    const text = io.read(answer);
    if (text !== null) {
      try { const reply = JSON.parse(text); io.remove(answer); return { reply }; } catch { /* being written: look again */ }
    }
    const now = io.now();
    const untaken = io.exists(waiting) && !io.exists(claimed);
    const patience = poked.ok ? CLAIM_WAIT : POKE_FAILED_WAIT;
    if (untaken && now - started > patience) {
      io.remove(waiting);
      const why = poked.ok ? "" : ` (herdr-app said: ${poked.error})`;
      return { error: `Herdr didn't take the request${why}. Is the Herdr app open, with the Tasks sidebar (the github-tasks mod) in its layout?` };
    }
    if (now > deadline) {
      if (untaken) { io.remove(waiting); return { error: "Herdr didn't take the request in time." }; }
      return { error: `Herdr is still working on it after ${Math.round((now - started) / 1000)}s; this stops waiting (--timeout waits longer). Look in Herdr for how it went.` };
    }
    await io.sleep(TICK);
  }
}

// Runs one command. argv: the words after herdr-tasks. io: the outside world (realIo, or a test's fake). Resolves with the exit code.
export async function main(argv, io) {
  const parsed = parseArgv(argv);
  if (parsed.help) { io.out(parsed.help); return EXIT.ok; }
  if (parsed.error) {
    io.err(`herdr-tasks: ${parsed.error}`);
    io.err(parsed.command ? `Usage: herdr-tasks ${parsed.command.usage}` : "Try: herdr-tasks --help");
    return EXIT.usage;
  }
  const { op, global } = parsed;
  let args;
  try { args = withFiles(parsed.args, io); } catch (e) { io.err(`herdr-tasks: ${e.message}`); return EXIT.usage; }
  const requests = cliRequestsDir(io.home()), replies = cliRepliesDir(io.home());
  const started = io.now(), id = requestId(started, io.random());
  const request = makeRequest({ id, op, args, where: { cwd: path.resolve(io.cwd(), global.cwd ?? "."), on: global.on }, project: global.project, at: started, timeout: global.timeout });
  try {
    io.mkdir(requests);
    io.mkdir(replies);
    io.write(path.join(requests, fileName(id)), `${JSON.stringify(request)}\n`);
  } catch (e) {
    io.err(`herdr-tasks: can't write the request into ${requests}: ${e.message}`);
    return EXIT.failed;
  }
  const poked = await io.poke();
  const { reply, error } = await waitForReply(id, { requests, replies, deadline: started + global.timeout * 1000, poked, started }, io);
  if (error) { io.err(`herdr-tasks: ${error}`); return EXIT.noAnswer; }
  if (global.json) io.out(JSON.stringify(reply.ok ? reply.data : { error: reply.error, code: reply.code, ...(reply.data ? { data: reply.data } : {}) }, null, 2));
  else (reply.ok ? io.out : io.err)(formatReply(op, reply));
  return exitFor(reply);
}

// The real world. A request is written under a temporary name and renamed, so the bridge never reads half of one.
export const realIo = () => ({
  cwd: () => process.cwd(),
  home: () => os.homedir(),
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  write: (file, text) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); },
  read: (file) => { try { return readFileSync(file, "utf8"); } catch { return null; } },
  exists: (file) => existsSync(file),
  remove: (file) => rmSync(file, { force: true }),
  stdin: () => { try { return readFileSync(0, "utf8"); } catch { return null; } },
  // `herdr-app do github-tasks.cli`: the sidebar looks in the mailbox at once. A failure is no reason to stop: the sidebar also
  // watches the folder, and the wait says what went wrong if nothing takes the request.
  poke: () => new Promise((resolve) => {
    execFile("herdr-app", ["do", CLI_ACTION], { timeout: 10000 }, (e, stdout, stderr) => {
      let said = null;
      try { said = JSON.parse(stdout || "{}").error ?? null; } catch { /* not JSON */ }
      resolve(e || said ? { ok: false, error: String(said || stderr || e?.message || "it failed").trim() } : { ok: true });
    });
  }),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});

// Run as a program (not imported by a test).
const self = fileURLToPath(import.meta.url);
let invoked = null;
try { invoked = process.argv[1] ? realpathSync(process.argv[1]) : null; } catch { /* no such file */ }
if (invoked === realpathSync(self)) {
  main(process.argv.slice(2), realIo()).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`herdr-tasks: ${e?.stack ?? e}\n`); process.exitCode = EXIT.failed; });
}
