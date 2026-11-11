import test from "node:test";
import assert from "node:assert/strict";
import { applyMove, dropAfterId, moveStatus, planMove, projectOrdered } from "./reorder.js";

// The open tickets in project order, across statuses: a In Progress ticket (p1) sits between the Up Next and Backlog ones.
const t = (key, status) => ({ key, status, title: key });
const OPEN = [t("n1", "Up Next"), t("n2", "Up Next"), t("p1", "In Progress"), t("n3", "Up Next"), t("b1", "Todo"), t("b2", "To Do"), t("b3", "To Do")];
const keys = (list) => list.map((x) => x.key);

test("a drop on a row lands above it: the ticket before it, the dragged one taken out first", () => {
  assert.equal(dropAfterId(OPEN, "b2", { kind: "row", key: "n2" }), "n1");
  assert.equal(dropAfterId(OPEN, "b2", { kind: "row", key: "b3" }), "b1");
  assert.equal(dropAfterId(OPEN, "b3", { kind: "row", key: "n3" }), "p1", "the neighbour is the project's, even from another section");
});

test("a drop on the first row of the project moves to the very top (null)", () => {
  assert.equal(dropAfterId(OPEN, "b2", { kind: "row", key: "n1" }), null);
  assert.equal(dropAfterId(OPEN, "b2", { kind: "top" }), null);
});

test("dragging down, the dragged ticket is out of the list first, so a row never lands after itself", () => {
  // n1 dropped above n3: n1 is removed, n3's predecessor is then p1
  assert.equal(dropAfterId(OPEN, "n1", { kind: "row", key: "n3" }), "p1");
  assert.equal(dropAfterId(OPEN, "n1", { kind: "row", key: "b1" }), "n3");
  // dropping on the row right below it: lands above that row, i.e. where it is (after n1's own predecessor, none)
  assert.equal(dropAfterId(OPEN, "n1", { kind: "row", key: "n2" }), null);
});

test("a drop on a header is first in that section: above its first ticket", () => {
  assert.equal(dropAfterId(OPEN, "b2", { kind: "header", section: "next" }), null);
  assert.equal(dropAfterId(OPEN, "n2", { kind: "header", section: "backlog" }), "n3", "the first Backlog ticket's predecessor");
});

test("a header's first ticket is found with the dragged one removed", () => {
  // n1 is the first of Up Next; with it out the first is n2, whose predecessor is none
  assert.equal(dropAfterId(OPEN, "n1", { kind: "header", section: "next" }), null);
  // b1 first of Backlog; with it out the first is b2, preceded by nothing but b1 (gone) and n3
  assert.equal(dropAfterId(OPEN, "b1", { kind: "header", section: "backlog" }), "n3");
});

test("the end zone is after the section's last ticket, the dragged one removed first", () => {
  assert.equal(dropAfterId(OPEN, "b1", { kind: "end", section: "next" }), "n3");
  assert.equal(dropAfterId(OPEN, "n1", { kind: "end", section: "backlog" }), "b3");
  assert.equal(dropAfterId(OPEN, "b3", { kind: "end", section: "backlog" }), "b2", "dragging the last one to the end");
});

test("a drop into an empty section: Up Next goes above the first Backlog ticket, Backlog after the last Up Next ticket", () => {
  const onlyBacklog = [t("p1", "In Progress"), t("b1", "To Do"), t("b2", "To Do")];
  assert.equal(dropAfterId(onlyBacklog, "b2", { kind: "header", section: "next" }), "p1", "above the first Backlog ticket left (b1)");
  assert.equal(dropAfterId(onlyBacklog, "b1", { kind: "end", section: "next" }), "p1", "above b2, the first Backlog ticket left");
  const onlyNext = [t("n1", "Up Next"), t("p1", "In Progress"), t("n2", "Up Next")];
  assert.equal(dropAfterId(onlyNext, "n2", { kind: "header", section: "backlog" }), "n1", "after the last Up Next ticket left");
  assert.equal(dropAfterId([t("n1", "Up Next")], "n1", { kind: "header", section: "backlog" }), null, "both sections empty: the top of the project");
});

test("a drop that means nothing answers undefined", () => {
  assert.equal(dropAfterId(OPEN, "n1", { kind: "row", key: "n1" }), undefined, "on itself");
  assert.equal(dropAfterId(OPEN, "n1", { kind: "row", key: "ghost" }), undefined, "on a row that isn't there");
  assert.equal(dropAfterId(OPEN, "ghost", { kind: "row", key: "n2" }), undefined, "a ticket that isn't there");
  assert.equal(dropAfterId(OPEN, "n1", { kind: "row", key: "p1" }), undefined, "on an In Progress row");
  assert.equal(dropAfterId(OPEN, "n1", { kind: "header", section: "progress" }), undefined, "on In Progress's header");
  assert.equal(dropAfterId(OPEN, "n1", { kind: "end", section: "investigations" }), undefined);
  assert.equal(dropAfterId(OPEN, "p1", { kind: "row", key: "n2" }), undefined, "dragging an In Progress ticket");
  assert.equal(dropAfterId(OPEN, "n1", { kind: "outside" }), undefined);
  assert.equal(dropAfterId(OPEN, "n1", null), undefined);
});

test("applyMove puts the ticket after afterId, or first when afterId is null, and changes its status when told", () => {
  assert.deepEqual(keys(applyMove(OPEN, "n1", "n3")), ["n2", "p1", "n3", "n1", "b1", "b2", "b3"]);
  assert.deepEqual(keys(applyMove(OPEN, "b3", null)), ["b3", "n1", "n2", "p1", "n3", "b1", "b2"]);
  const moved = applyMove(OPEN, "b1", "n1", "Up Next");
  assert.deepEqual(keys(moved), ["n1", "b1", "n2", "p1", "n3", "b2", "b3"]);
  assert.equal(moved[1].status, "Up Next");
  assert.equal(OPEN[4].status, "Todo", "the list given isn't changed");
});

test("applyMove leaves the list as it is for a ticket or afterId that isn't there", () => {
  assert.deepEqual(keys(applyMove(OPEN, "ghost", "n1")), keys(OPEN));
  assert.deepEqual(keys(applyMove(OPEN, "n1", "ghost")), keys(OPEN));
  assert.deepEqual(keys(applyMove(OPEN, "n1", "n1")), keys(OPEN));
});

test("moveStatus: the Status a move between Up Next and Backlog needs, in the project's spelling; none within a section", () => {
  const options = [{ name: "Todo" }, { name: "Up Next" }, { name: "Done" }];
  assert.equal(moveStatus("backlog", "next", options), "Up Next");
  assert.equal(moveStatus("next", "backlog", options), "Todo");
  assert.equal(moveStatus("next", "backlog", [{ name: "To Do" }]), "To Do");
  assert.equal(moveStatus("next", "backlog"), "To Do", "no options: the fixed name");
  assert.equal(moveStatus("next", "next", options), null);
  assert.equal(moveStatus("backlog", "backlog", options), null);
  assert.equal(moveStatus("next", "progress", options), null, "only Up Next and Backlog take a drop");
  assert.equal(moveStatus("progress", "next", options), null);
});

test("planMove answers where a drop goes: afterId, the section, and the status to set when the section changes", () => {
  const options = [{ name: "Todo" }, { name: "Up Next" }];
  assert.deepEqual(planMove(OPEN, "b2", { kind: "row", key: "n2" }, options), { afterId: "n1", section: "next", status: "Up Next" });
  assert.deepEqual(planMove(OPEN, "n1", { kind: "end", section: "backlog" }, options), { afterId: "b3", section: "backlog", status: "Todo" });
  assert.deepEqual(planMove(OPEN, "n3", { kind: "row", key: "n1" }, options), { afterId: null, section: "next", status: null });
});

test("planMove is null when nothing would change: a drop that means nothing, or one that leaves the order and status as they are", () => {
  assert.equal(planMove(OPEN, "n1", { kind: "row", key: "n1" }), null);
  assert.equal(planMove(OPEN, "n1", { kind: "row", key: "n2" }), null, "dropped above the row below it");
  assert.equal(planMove(OPEN, "n1", { kind: "header", section: "next" }), null, "already first");
  assert.equal(planMove(OPEN, "b3", { kind: "end", section: "backlog" }), null, "already last");
  assert.equal(planMove(OPEN, "n2", { kind: "row", key: "p1" }), null, "In Progress isn't a target");
  assert.equal(planMove(OPEN, "n2", { kind: "row", key: "n3" }), null, "only past an In Progress ticket: the section reads the same");
  assert.deepEqual(planMove(OPEN, "n1", { kind: "row", key: "n3" }), { afterId: "p1", section: "next", status: null });
});

test("only Up Next and Backlog show the project's order as it is", () => {
  assert.deepEqual(["investigations", "next", "backlog", "progress", "review"].filter(projectOrdered), ["next", "backlog"]);
});
