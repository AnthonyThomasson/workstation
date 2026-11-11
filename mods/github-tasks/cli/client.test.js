import test from "node:test";
import assert from "node:assert/strict";
import { CLAIM_WAIT, main } from "./client.js";
import { EXIT, checkRequest, claimedName, failReply, fileName, okReply, waitingId } from "./protocol.js";
import { cliRepliesDir, cliRequestsDir } from "../workflow/index.js";

const HOME = "/home/me";
const REQUESTS = cliRequestsDir(HOME), REPLIES = cliRepliesDir(HOME);

// The outside world, made up: files in a Map, a clock that moves only when slept on, and a bridge (answer) that the poke wakes.
// answer(request) -> a reply, or null to leave the request untaken; "claim" takes it and never replies.
function world({ answer = () => null, poke = { ok: true }, files = {}, stdin = null } = {}) {
  const fs = new Map(Object.entries(files));
  const out = [], err = [];
  let now = 1_800_000_000_000;
  const bridge = () => {
    for (const [file, text] of [...fs]) {
      if (!file.startsWith(`${REQUESTS}/`)) continue;
      const id = waitingId(file.slice(REQUESTS.length + 1));
      if (!id) continue;
      const { request } = checkRequest(text, now);
      const reply = answer(request);
      if (reply === null) continue;
      fs.delete(file);
      fs.set(`${REQUESTS}/${claimedName(id)}`, text);
      if (reply === "claim") continue;
      fs.delete(`${REQUESTS}/${claimedName(id)}`);
      fs.set(`${REPLIES}/${fileName(id)}`, JSON.stringify({ ...reply, id }));
    }
  };
  const io = {
    cwd: () => "/repo/sub", home: () => HOME, now: () => now, random: () => 0.25,
    sleep: async (ms) => { now += ms; },
    mkdir: () => {}, write: (file, text) => fs.set(file, text), read: (file) => fs.get(file) ?? null,
    exists: (file) => fs.has(file), remove: (file) => fs.delete(file), stdin: () => stdin,
    poke: async () => { bridge(); return poke; },
    out: (t) => out.push(t), err: (t) => err.push(t),
  };
  return { io, fs, out, err, sent: () => [...fs].filter(([f]) => f.startsWith(REQUESTS)) };
}

test("a command becomes a request in the mailbox, and the reply is printed and removed", async () => {
  let seen;
  const w = world({ answer: (r) => { seen = r; return okReply(r.id, { ticket: { number: 12, title: "Fix login" } }); } });
  const code = await main(["open", "#12", "--cwd", "..", "--project", "Roadmap"], w.io);
  assert.equal(code, EXIT.ok);
  assert.equal(seen.op, "open");
  assert.deepEqual(seen.args, { ticket: "#12" });
  assert.deepEqual(seen.where, { cwd: "/repo", on: null });
  assert.equal(seen.project, "Roadmap");
  assert.equal(seen.timeout, 120);
  assert.deepEqual(w.out, ["Opened #12 in Herdr."]);
  assert.equal(w.fs.size, 0, "nothing is left in the mailbox");
});

test("--json prints the data, or the error with its code", async () => {
  const w = world({ answer: (r) => okReply(r.id, { runs: [] }) });
  assert.equal(await main(["runs", "--json"], w.io), EXIT.ok);
  assert.deepEqual(JSON.parse(w.out[0]), { runs: [] });
  const f = world({ answer: (r) => failReply(r.id, "pick one", { code: "choose", data: { choices: [{ id: "bug", name: "Bug" }] } }) });
  assert.equal(await main(["start", "12", "--json"], f.io), EXIT.choose);
  assert.deepEqual(JSON.parse(f.out[0]), { error: "pick one", code: "choose", data: { choices: [{ id: "bug", name: "Bug" }] } });
});

test("a failure is printed on stderr and exits 1", async () => {
  const w = world({ answer: (r) => failReply(r.id, "The project has no ticket #99.") });
  assert.equal(await main(["show", "99"], w.io), EXIT.failed);
  assert.deepEqual(w.err, ["herdr-tasks: The project has no ticket #99."]);
  assert.deepEqual(w.out, []);
});

test("--body-file sends the file's text, or what is piped in", async () => {
  let args;
  const w = world({ answer: (r) => { args = r.args; return okReply(r.id, { ticket: { number: 1, title: "T" }, changed: ["body"] }); }, files: { "/repo/sub/notes.md": "From a file" } });
  await main(["edit", "1", "--body-file", "notes.md"], w.io);
  assert.deepEqual(args, { ticket: "1", body: "From a file" });
  const p = world({ answer: (r) => { args = r.args; return okReply(r.id, { ticket: { number: 1, title: "T" } }); }, stdin: "Piped" });
  await main(["create", "--title", "T", "--body-file", "-"], p.io);
  assert.deepEqual(args, { title: "T", body: "Piped" });
  const missing = world();
  assert.equal(await main(["edit", "1", "--body-file", "nope.md"], missing.io), EXIT.usage);
  assert.match(missing.err[0], /Can't read nope\.md/);
});

test("usage errors and help never touch the mailbox", async () => {
  const w = world({ answer: () => assert.fail("nothing is sent") });
  assert.equal(await main(["merge", "12"], w.io), EXIT.usage);
  assert.deepEqual(w.err, ["herdr-tasks: merge can't be undone from here: add --yes to do it.", "Usage: herdr-tasks merge <ticket> --yes"]);
  assert.equal(await main(["--help"], w.io), EXIT.ok);
  assert.match(w.out[0], /^herdr-tasks: GitHub Tasks/);
  assert.equal(w.fs.size, 0);
});

test("a request nothing takes is withdrawn, saying Herdr isn't answering", async () => {
  const w = world();
  assert.equal(await main(["list"], w.io), EXIT.noAnswer);
  assert.match(w.err[0], /Herdr didn't take the request\. Is the Herdr app open, with the Tasks sidebar/);
  assert.equal(w.fs.size, 0, "the request was taken back");
});

test("when herdr-app can't even be asked, that is said, and sooner", async () => {
  const w = world({ poke: { ok: false, error: "no window is open" } });
  const started = w.io.now();
  assert.equal(await main(["list"], w.io), EXIT.noAnswer);
  assert.match(w.err[0], /herdr-app said: no window is open/);
  assert.ok(w.io.now() - started < CLAIM_WAIT);
});

test("a request taken but not answered in time is left to Herdr, which goes on with it", async () => {
  const w = world({ answer: () => "claim" });
  assert.equal(await main(["start", "12", "--timeout", "30"], w.io), EXIT.noAnswer);
  assert.match(w.err[0], /Herdr is still working on it after 30s/);
  assert.equal(w.sent().length, 1, "the taken request stays for the bridge");
  assert.ok(w.sent()[0][0].endsWith(".json.claimed"));
});

test("a long command waits longer by default", async () => {
  let timeout;
  const w = world({ answer: (r) => { timeout = r.timeout; return okReply(r.id, { investigation: { id: "inv-1", label: "x", branch: "b" } }); } });
  await main(["new-task", "make", "it", "faster"], w.io);
  assert.equal(timeout, 600);
});
