import test from "node:test";
import assert from "node:assert/strict";
import { wontDoFooter, wontDoPrompt, retryAfterSignIn } from "./wontdo.js";
import { WONT_DO_NEEDS_OPTION } from "./model.js";

const OPTIONS = [{ name: "To Do" }, { name: "Won't Do" }];
const idle = { draft: false, saving: false, dirty: false, statusOptions: OPTIONS, startable: true, confirming: false, busy: false };
const footer = (over) => wontDoFooter({ ...idle, ...over });

test("a clean, saved ticket can be marked Won't Do and nothing else changes", () => {
  const f = footer({});
  assert.equal(f.wontDo.disabled, false);
  assert.equal(f.wontDo.tip, null);
  assert.equal(f.confirm, false);
  assert.equal(f.start.disabled, false);
  assert.equal(f.revert.disabled, true); // nothing to revert
  assert.equal(f.save.disabled, true);
});

test("the button is disabled with the reason as its tooltip", () => {
  assert.deepEqual(footer({ draft: true }).wontDo, { disabled: true, tip: "Create the ticket first" });
  assert.deepEqual(footer({ saving: true }).wontDo, { disabled: true, tip: "Saving…" });
  assert.deepEqual(footer({ dirty: true }).wontDo, { disabled: true, tip: "Save or revert first" });
  assert.deepEqual(footer({ statusOptions: [{ name: "To Do" }] }).wontDo, { disabled: true, tip: WONT_DO_NEEDS_OPTION });
  assert.deepEqual(footer({ statusOptions: undefined }).wontDo, { disabled: true, tip: WONT_DO_NEEDS_OPTION });
});

test("the confirm strip shows while confirming, and goes back to the buttons when edits make the button unavailable", () => {
  assert.equal(footer({ confirming: true }).confirm, true);
  assert.equal(footer({ confirming: true, dirty: true }).confirm, false);
  assert.equal(footer({ confirming: false }).confirm, false);
});

test("while the call runs, every footer button is disabled and the strip stays", () => {
  const f = footer({ confirming: true, busy: true, dirty: false });
  assert.equal(f.confirm, true);
  for (const b of [f.wontDo, f.start, f.revert, f.save, f.cancel, f.ok]) assert.equal(b.disabled, true);
  // even if the person types meanwhile, the strip does not flip away mid-call
  assert.equal(footer({ confirming: true, busy: true, dirty: true }).confirm, true);
  assert.equal(footer({ busy: true, dirty: true }).save.disabled, true);
});

test("the confirm strip's buttons work when idle", () => {
  const f = footer({ confirming: true });
  assert.equal(f.cancel.disabled, false);
  assert.equal(f.ok.disabled, false);
});

test("Start, Revert and Save keep their own rules when idle", () => {
  assert.equal(footer({ dirty: true }).start.disabled, true);
  assert.equal(footer({ startable: false }).start.disabled, true);
  assert.equal(footer({ dirty: true }).save.disabled, false);
  assert.equal(footer({ dirty: true }).revert.disabled, false);
  assert.equal(footer({ dirty: true, saving: true }).save.disabled, true);
});

test("the confirm question names the ticket and what happens", () => {
  assert.equal(wontDoPrompt({ number: 39 }), "Close #39 as not planned and set it to Won't Do?");
});

test("an edit that makes the button unavailable withdraws the question, so Revert does not bring it back", () => {
  assert.equal(footer({ confirming: true, dirty: true }).dropConfirm, true);
  assert.equal(footer({ confirming: true, draft: true }).dropConfirm, true);
  assert.equal(footer({ confirming: true }).dropConfirm, false);
  assert.equal(footer({ confirming: true, dirty: true, busy: true }).dropConfirm, false); // never mid-call
  assert.equal(footer({ confirming: false, dirty: true }).dropConfirm, false);
});

test("after signing in again, a failed Won't Do is run again, anything else is a save", () => {
  assert.equal(retryAfterSignIn("wontdo"), "wontdo");
  assert.equal(retryAfterSignIn(null), "save");
  assert.equal(retryAfterSignIn(undefined), "save");
  assert.equal(retryAfterSignIn(null, { wontDoDisabled: true }), "save");
});

test("a failed Won't Do is not re-run after sign-in if the button is unavailable by then (edits would be lost)", () => {
  assert.equal(retryAfterSignIn("wontdo", { wontDoDisabled: true }), "none");
  assert.equal(retryAfterSignIn("wontdo", { wontDoDisabled: false }), "wontdo");
  // the flag comes from the footer: edits typed during sign-in turn it on
  assert.equal(retryAfterSignIn("wontdo", { wontDoDisabled: footer({ dirty: true }).wontDo.disabled }), "none");
  assert.equal(retryAfterSignIn("wontdo", { wontDoDisabled: footer({}).wontDo.disabled }), "wontdo");
});
