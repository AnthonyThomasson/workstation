// The project's fixed statuses, how their spellings match, and how tickets group by stage.
import { newestFirst } from "./tickets.js";

// The project's statuses, fixed: backlog (to be groomed), groomed (ready to pick up), then the stages a workflow run moves a ticket through,
// and Won't Do for a ticket that will not be done (only the ticket window's Won't Do button sets it).
export const STATUSES = { backlog: "To Do", groomed: "Up Next", inProgress: "In Progress", inReview: "In Review", done: "Done", wontDo: "Won't Do" };

// Status names match ignoring case, spaces and punctuation: GitHub's own default is "Todo", not "To Do".
export const statusKey = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const sameStatus = (a, b) => statusKey(a) === statusKey(b);

// A status as the project spells it ("Todo" for "To Do"); the name itself when the project has no such option.
// options: the Status field's options, [{ name }].
export const spelled = (options, name) => (options ?? []).find((o) => sameStatus(o.name, name))?.name ?? name;

// A status picker's options without Won't Do: the Won't Do button is the only way to set it. options: [{ name }].
export const pickableStatuses = (options) => (options ?? []).filter((o) => !sameStatus(o.name, STATUSES.wontDo));

// The project's Won't Do option, the exact spelling first, else a loose one ("Wont Do"); null when it has none.
export const wontDoOption = (options) =>
  (options ?? []).find((o) => o.name === STATUSES.wontDo) ?? (options ?? []).find((o) => sameStatus(o.name, STATUSES.wontDo)) ?? null;

export const WONT_DO_NEEDS_OPTION = "Add a Won't Do status to the project; see Task settings";

// Why the Won't Do button is disabled, or null when it is not. The first reason that applies wins.
//   draft: a draft not created as an issue yet   saving: a save is running   dirty: unsaved edits
//   statusOptions: the project's Status field options [{ name }]; none (or no field) means the option is missing
export function wontDoDisabledReason({ draft = false, saving = false, dirty = false, statusOptions } = {}) {
  if (draft) return "Create the ticket first";
  if (saving) return "Saving…";
  if (dirty) return "Save or revert first";
  if (!wontDoOption(statusOptions)) return WONT_DO_NEEDS_OPTION;
  return null;
}

// The open tickets by stage, newest first: { inProgress, inReview, groomed, backlog }. A ticket in any other status is left out.
export function groupByStage(open) {
  const pick = (name) => (open ?? []).filter((t) => sameStatus(t.status, name)).sort(newestFirst);
  return { inProgress: pick(STATUSES.inProgress), inReview: pick(STATUSES.inReview), groomed: pick(STATUSES.groomed), backlog: pick(STATUSES.backlog) };
}
