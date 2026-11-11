// Dragging a ticket within and between Up Next and Backlog, as pure maths: where a drop lands in the GitHub Project's item order, what the
// local list looks like after it, and the Status a move between the two needs. main.js wires the drag and sends it to GitHub (github/loader.js
// moveItem); node --test checks this.
//
// The project's position is global, across every status, not per section: a ticket is placed by the item it goes AFTER (`afterId`, null for
// the very top). So every maths here works on the full open list in project order (normalizeItems' / groupTickets' `open`, each ticket
// { key, status, ... }), and always with the dragged ticket taken out of it first, else dragging a row down would land it after itself.
import { STATUSES, sameStatus, spelled } from "./statuses.js";

// The two sections that drag, and the status of the tickets in each.
const SECTION_STATUS = { next: STATUSES.groomed, backlog: STATUSES.backlog };

// Whether a section shows the project's item order as it is (Up Next and Backlog), so nothing moves a row within it: not even the bell.
export const projectOrdered = (section) => Object.hasOwn(SECTION_STATUS, section);

// "next", "backlog", or null for a ticket in any other stage (those neither drag nor take a drop).
export const sectionOf = (ticket) => Object.keys(SECTION_STATUS).find((id) => sameStatus(ticket?.status, SECTION_STATUS[id])) ?? null;

const previous = (list, i) => (i > 0 ? list[i - 1].key : null);

// The `afterId` for dropping the ticket `key` on `target`, one of:
//   { kind: "row", key }        above that row: after the ticket before it
//   { kind: "header", section } first in that section: above its first ticket
//   { kind: "end", section }    last in that section: after its last ticket
//   { kind: "top" }             the very top of the project
// as an item key, or null for the very top of the project. A section with nothing in it (the dragged ticket not counted) has no ticket to
// go above or after: Up Next then goes above the first Backlog ticket, Backlog after the last Up Next ticket, and with both empty it is the top.
// undefined when the drop means nothing: a ticket or a row that isn't there, the ticket on itself, or any stage but Up Next and Backlog
// (dragged from or dropped on).
export function dropAfterId(open, key, target) {
  const dragged = (open ?? []).find((t) => t.key === key);
  if (!dragged || !sectionOf(dragged) || !target) return undefined;
  const rest = open.filter((t) => t.key !== key);
  const first = (section) => rest.findIndex((t) => sectionOf(t) === section);
  const last = (section) => rest.findLastIndex((t) => sectionOf(t) === section);
  const empty = (section) => (section === "next" ? previous(rest, first("backlog")) : last("next") < 0 ? null : rest[last("next")].key);
  switch (target.kind) {
    case "top": return null;
    case "row": {
      const i = rest.findIndex((t) => t.key === target.key);
      return i < 0 || !sectionOf(rest[i]) ? undefined : previous(rest, i);
    }
    case "header": case "end": {
      if (!SECTION_STATUS[target.section]) return undefined;
      const i = target.kind === "header" ? first(target.section) : last(target.section);
      if (i < 0) return empty(target.section);
      return target.kind === "header" ? previous(rest, i) : rest[i].key;
    }
    default: return undefined;
  }
}

// The list with the ticket `key` moved to just after `afterId` (first when null), taking `status` when one is given. The list given isn't
// changed; a ticket or afterId that isn't in it (or the ticket after itself) leaves it as it was.
export function applyMove(open, key, afterId, status) {
  const list = open ?? [];
  const ticket = list.find((t) => t.key === key);
  if (!ticket || afterId === key) return list;
  const rest = list.filter((t) => t.key !== key);
  const at = afterId === null || afterId === undefined ? 0 : rest.findIndex((t) => t.key === afterId) + 1;
  if (afterId !== null && afterId !== undefined && at === 0) return list;
  return [...rest.slice(0, at), status ? { ...ticket, status } : ticket, ...rest.slice(at)];
}

// The Status a move from one section to another needs: the target's status as the project spells it (options: the Status field's
// [{ name }]), or null when the section doesn't change or either isn't Up Next / Backlog (no status change within a section).
export function moveStatus(from, to, options) {
  if (from === to || !SECTION_STATUS[from] || !SECTION_STATUS[to]) return null;
  return spelled(options, SECTION_STATUS[to]);
}

// Where a drop of the ticket `key` on `target` (dropAfterId's) goes: { afterId, section, status }, the section it ends up in and the status
// to set (null when it stays in its section). null when nothing would change: a drop that means nothing, or one that leaves its section
// reading the same (above the row below it, first when it already is, past only tickets of other stages).
export function planMove(open, key, target, options) {
  const afterId = dropAfterId(open, key, target);
  if (afterId === undefined) return null;
  const from = sectionOf(open.find((t) => t.key === key));
  const rest = open.filter((t) => t.key !== key);
  const section = target.kind === "row" ? sectionOf(rest.find((t) => t.key === target.key)) : target.kind === "top" ? from : target.section;
  const status = moveStatus(from, section, options);
  if (!status && from === section) {
    const read = (list) => list.filter((t) => sectionOf(t) === section).map((t) => t.key).join("\n");
    if (read(applyMove(open, key, afterId)) === read(open)) return null;
  }
  return { afterId, section, status };
}
