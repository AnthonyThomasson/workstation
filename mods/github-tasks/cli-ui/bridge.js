// The Tasks sidebar's end of herdr-tasks (cli/client.js): it answers the requests the command drops in the mailbox (workflow/places.js
// cliRequestsDir) by doing what the UI's buttons do, in this mod (handlers.js), and writes each reply where the command waits for it
// (cliRepliesDir). It looks when the command says so (`herdr-app do github-tasks.cli`, which main.js passes to poke), when the folder
// changes (watchFolder), and every POLL in case both were missed. Only the sidebar role runs one, so a request is answered once; a
// request is taken by renaming it, so a second copy (another layout's sidebar) that tries as well finds it gone.
import { exec, home, readTextFile, watchFolder, writeTextFile } from "herdr";
import { cliRepliesDir, cliRequestsDir } from "../workflow/index.js";
import { checkRequest, claimedName, failReply, fileName, okReply, partName, waitingId } from "../cli/index.js";
import { HANDLERS, explain } from "./handlers.js";

const START_AFTER = 2000; // a copy that only lives for a moment (herdr-app check renders the mod once) never takes a request
const POLL = 15000;
const RETRY = 15000; // a watch that failed is started again after this
const STALE_MINUTES = 60; // replies nobody came for, and requests left taken by a copy that was reloaded mid-answer, go after this

const sh = (script, ...args) => exec("sh", ["-c", script, "github-tasks", ...args]);

export class Bridge {
  constructor(cx) {
    this.requests = cliRequestsDir(home());
    this.replies = cliRepliesDir(home());
    this.ready = false;
    this.looking = false;
    this.again = false;
    this.working = new Set(); // ids being answered by this copy
    cx.spawn(async (cx) => {
      await cx.sleep(START_AFTER);
      const made = await sh('mkdir -p "$1" "$2"', this.requests, this.replies).catch(() => null);
      if (made?.code !== 0) return; // no mailbox: herdr-tasks says Herdr didn't take its request
      await this.tidy();
      this.ready = true;
      this.look(cx);
      for (;;) {
        try { await watchFolder(this.requests); } catch { await cx.sleep(RETRY); }
        this.look(cx);
      }
    });
    cx.timer.every(POLL, (cx) => this.look(cx));
    cx.timer.every(STALE_MINUTES * 60000, () => { this.tidy(); });
  }

  // herdr-tasks said a request is waiting.
  poke(cx) { this.look(cx); }

  // Takes every waiting request and answers each in a task of its own (a start can take a while; a list shouldn't wait for it).
  look(cx) {
    if (!this.ready) return;
    if (this.looking) { this.again = true; return; }
    this.looking = true;
    cx.spawn(async (cx) => {
      try {
        do {
          this.again = false;
          const listed = await sh('ls -1 "$1" 2>/dev/null', this.requests).catch(() => null);
          const ids = String(listed?.stdout ?? "").split("\n").map(waitingId).filter((id) => id && !this.working.has(id));
          for (const id of ids) {
            const from = `${this.requests}/${fileName(id)}`, to = `${this.requests}/${claimedName(id)}`;
            const taken = await exec("mv", [from, to]).catch(() => null);
            if (taken?.code !== 0) continue; // another copy took it, or its command gave up
            this.working.add(id);
            cx.spawn(async (cx) => { try { await this.answer(id, to, cx); } finally { this.working.delete(id); } });
          }
        } while (this.again);
      } finally { this.looking = false; }
    });
  }

  // Answers one taken request: reads it, runs its handler, writes the reply, then lets the request go (herdr-tasks takes a request
  // that is gone with no reply for a lost one, so the taken file stays until the reply is there).
  async answer(id, taken, cx) {
    const text = await readTextFile(taken).catch(() => null);
    const checked = text === null ? { error: "The request couldn't be read.", id } : checkRequest(text);
    let reply = null;
    if (checked.request) {
      const req = checked.request;
      try { reply = okReply(id, await HANDLERS[req.op](req, cx)); }
      catch (e) { reply = failReply(id, explain(e, req), { code: e?.code ?? null, data: e?.data ?? null }); }
    } else if (!checked.expired) {
      reply = failReply(checked.id ?? id, checked.error);
    }
    if (reply) {
      const part = `${this.replies}/${partName(id)}`;
      try {
        await writeTextFile(part, `${JSON.stringify(reply)}\n`, null);
        await exec("mv", ["-f", part, `${this.replies}/${fileName(id)}`]);
      } catch { /* the command will say Herdr didn't answer */ }
    }
    await exec("rm", ["-f", taken]).catch(() => {});
  }

  // Removes what is left over in the mailbox: replies nobody read, and requests taken by a copy that ended before it answered.
  tidy() {
    return sh(`find "$1" "$2" -type f -mmin +${STALE_MINUTES} -exec rm -f {} + 2>/dev/null`, this.requests, this.replies).catch(() => null);
  }
}
