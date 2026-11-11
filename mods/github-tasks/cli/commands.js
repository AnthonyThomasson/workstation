// herdr-tasks' commands: what each is called, what it takes and what it does, and the parser that turns the words typed into a
// request's { op, args } (protocol.js). Pure: client.js reads files and the mailbox. Each command does what a button of the Tasks UI
// does, so the help names the button.

const SECTIONS = ["next", "backlog", "progress", "review", "investigations"];
const MOVE_TO = ["next", "backlog"];
const LONG_OPS = ["start", "merge", "new-task", "refactor", "project-create", "investigation-done"]; // these wait longer by default

// type: "string" (takes a value), "list" (takes a value, may be repeated), "bool" (takes none).
export const GLOBAL_FLAGS = {
  cwd: { type: "string", about: "the folder to act from, as if the Tasks sidebar were looking at it (default: this one)" },
  on: { type: "string", about: "the machine that folder is on (`hc machine ls`; default: this computer)" },
  project: { type: "string", about: "the GitHub Project, by id or title (default: the one the sidebar picked for the repo)" },
  json: { type: "bool", about: "print the answer as JSON" },
  timeout: { type: "string", about: "seconds to wait for Herdr (default: 120; 600 for start, merge, new-task, refactor)" },
  help: { type: "bool", about: "show help" },
};

// The commands, in the order help lists them. words: what is typed (one or two words). args: positional arguments (rest: the rest of
// the words, joined). flags: per command. confirm: needs --yes. check(args): a usage error, or null.
export const COMMANDS = [
  { group: "Tickets" },
  { words: ["list"], op: "list", flags: { section: "string" }, usage: "list [--section next|backlog|progress|review|investigations]",
    about: "The sidebar's sections and their tickets, with each ticket's run.",
    check: (a) => (a.section && !SECTIONS.includes(a.section) ? `--section is one of ${SECTIONS.join(", ")}.` : null) },
  { words: ["show"], op: "show", args: ["ticket"], usage: "show <ticket>",
    about: "One ticket: its status, labels and description, the workflows Start would choose from, and its run (agents, pull request, Merge)." },
  { words: ["create"], op: "create", flags: { title: "string", body: "string", "body-file": "string", label: "list", status: "string", draft: "bool" },
    usage: "create --title <title> [--body <text> | --body-file <file|->] [--label <label>]... [--status <status>] [--draft]",
    about: "Makes a ticket on the project: an issue (or, --draft, a draft), in To Do unless --status says otherwise.",
    check: (a) => (!a.title?.trim() ? "create needs --title." : a.body !== undefined && a.bodyFile !== undefined ? "Give --body or --body-file, not both." : a.draft && a.label?.length ? "A draft has no labels." : null) },
  { words: ["edit"], op: "edit", args: ["ticket"], flags: { title: "string", body: "string", "body-file": "string", status: "string", "add-label": "list", "remove-label": "list" },
    usage: "edit <ticket> [--title <title>] [--body <text> | --body-file <file|->] [--status <status>] [--add-label <label>]... [--remove-label <label>]...",
    about: "The ticket editor's Save: sends only what changed.",
    check: (a) => (a.body !== undefined && a.bodyFile !== undefined ? "Give --body or --body-file, not both."
      : [a.title, a.body, a.bodyFile, a.status].every((v) => v === undefined) && !a.addLabel?.length && !a.removeLabel?.length ? "Say what to change: --title, --body, --body-file, --status, --add-label or --remove-label." : null) },
  { words: ["move"], op: "move", args: ["ticket"], flags: { to: "string", first: "bool", last: "bool", before: "string" },
    usage: "move <ticket> [--to next|backlog] [--first | --last | --before <ticket>]",
    about: "Dragging an Up Next or Backlog row: to another section (--to), first (the default), last, or above another ticket.",
    check: (a) => (a.to && !MOVE_TO.includes(a.to) ? "--to is next or backlog."
      : [a.first, a.last, a.before !== undefined].filter(Boolean).length > 1 ? "Give one of --first, --last and --before."
        : !a.to && !a.first && !a.last && a.before === undefined ? "Say where: --to, --first, --last or --before." : null) },
  { words: ["wontdo"], op: "wontdo", args: ["ticket"], confirm: true, usage: "wontdo <ticket> --yes",
    about: "The editor's Won't Do: sets the status to Won't Do and closes the issue as not planned." },
  { words: ["open"], op: "open", args: ["ticket"], usage: "open <ticket>", about: "Opens the ticket's editor popup in Herdr, as a click on its row does." },
  { group: "Runs" },
  { words: ["start"], op: "start", args: ["ticket"], flags: { workflow: "string" }, usage: "start <ticket> [--workflow <id|name>]",
    about: "The play button: starts the workflow the ticket's labels match (with several, --workflow picks one) and opens its run tab. A ticket whose run is going is shown instead." },
  { words: ["view"], op: "view", args: ["ticket"], usage: "view <ticket>", about: "The eye button: brings the ticket's run tab to the front, reopening it if it was closed." },
  { words: ["runs"], op: "runs", usage: "runs", about: "Every workflow run Herdr knows of: its ticket, orchestrator and who needs you." },
  { words: ["merge"], op: "merge", args: ["ticket"], confirm: true, usage: "merge <ticket> --yes",
    about: "The run page's Merge (opens the pull request if needed, squash-merges it, sets Done, removes the worktree and closes the run's space), or, after a failed Merge, its red button, which hands the error to the Task Orchestrator." },
  { group: "New tasks and refactors" },
  { words: ["new-task"], op: "new-task", rest: "description", usage: "new-task <description...>",
    about: "The + button: starts a New Task Orchestrator with the description, which writes the ticket with you." },
  { words: ["refactor"], op: "refactor", flags: { type: "string", focus: "string" }, usage: "refactor [--type <id|name>] [--focus <text>]",
    about: "The broom: starts a refactor session of that type. Without --type, lists the types.",
    check: (a) => (a.focus !== undefined && !a.type ? "--focus needs --type." : null) },
  { words: ["investigations"], op: "investigations", usage: "investigations", about: "The Investigations section: New Task and refactor sessions." },
  { words: ["investigation", "view"], op: "investigation-view", args: ["id"], usage: "investigation view <id>", about: "Opens a session's tab, as a click on its row does." },
  { words: ["investigation", "done"], op: "investigation-done", args: ["id"], confirm: true, usage: "investigation done <id> --yes",
    about: "The session page's Done: ends its agents, closes its space, removes its worktree and deletes its branch." },
  { group: "Project and settings" },
  { words: ["projects"], op: "projects", usage: "projects", about: "The repo, its linked projects, and which one Tasks uses." },
  { words: ["project", "use"], op: "project-use", args: ["project"], usage: "project use <id|title>", about: "Picks the project Tasks shows for the repo, as the sidebar's project chips do." },
  { words: ["project", "create"], op: "project-create", usage: "project create", about: "Create Project: makes a project linked to the repo and sets up its statuses and labels." },
  { words: ["workflows"], op: "workflows", flags: { refactors: "bool" }, usage: "workflows [--refactors]", about: "The workflows (or refactor types) this folder can start, and the files that can't be read." },
  { words: ["doctor"], op: "doctor", usage: "doctor", about: "What the doctor last found for the folder the Tasks sidebar shows." },
  { words: ["refresh"], op: "refresh", usage: "refresh", about: "Reloads the Tasks sidebar's list." },
];

const camel = (name) => name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
const commands = () => COMMANDS.filter((c) => c.words);

// The help: every command, or one.
export function usage(command = null) {
  const flagLines = Object.entries(GLOBAL_FLAGS).map(([name, f]) => `  --${name}${f.type === "bool" ? "" : " <value>"}`.padEnd(22) + f.about);
  if (command) {
    return [`Usage: herdr-tasks ${command.usage}`, "", command.about, ...(command.confirm ? ["", "It changes things that can't be undone from here, so it needs --yes."] : []), "", "Options for every command:", ...flagLines].join("\n");
  }
  const lines = ["herdr-tasks: GitHub Tasks from the command line. Each command does what a button of the Tasks UI does, in the Herdr app.",
    "", "Usage: herdr-tasks <command> [options]", "",
    "A <ticket> is its number (12 or #12), its project item key (PVTI_…) or its title."];
  for (const c of COMMANDS) {
    if (c.group) { lines.push("", c.group); continue; }
    lines.push(`  ${c.usage}`, `      ${c.about}`);
  }
  lines.push("", "Options for every command:", ...flagLines, "",
    "Herdr must be open with the Tasks sidebar in its layout: the commands run there, in the github-tasks mod.",
    "Exit codes: 0 done, 1 failed, 2 usage, 3 a choice is needed (start with several workflows), 4 Herdr didn't answer.");
  return lines.join("\n");
}

// Splits the words into flags and positional words. spec: { name: type }. Returns { flags, words } or { error }.
function split(argv, spec) {
  const flags = {}, words = [];
  for (let i = 0; i < argv.length; i++) {
    const word = String(argv[i]);
    if (word === "--") { words.push(...argv.slice(i + 1).map(String)); break; }
    if (word === "-h") { flags.help = true; continue; }
    if (!word.startsWith("--") || word === "-") { words.push(word); continue; }
    const eq = word.indexOf("=");
    const name = eq < 0 ? word.slice(2) : word.slice(2, eq);
    const type = spec[name];
    if (!type) return { error: `Unknown option --${name}.` };
    if (type === "bool") {
      if (eq >= 0) return { error: `--${name} takes no value.` };
      flags[name] = true;
      continue;
    }
    let value;
    if (eq >= 0) value = word.slice(eq + 1);
    else if (i + 1 < argv.length) value = String(argv[++i]);
    else return { error: `--${name} needs a value.` };
    if (type === "list") (flags[name] ??= []).push(value);
    else flags[name] = value;
  }
  return { flags, words };
}

// The command the words start with (two-word commands first), or null.
function commandOf(words) {
  return commands().find((c) => c.words.length === 2 && c.words[0] === words[0] && c.words[1] === words[1])
    ?? commands().find((c) => c.words.length === 1 && c.words[0] === words[0]) ?? null;
}

// The words typed after herdr-tasks, as { help } (text to print), { error, command? } (a usage error), or
// { command, op, args, global: { cwd, on, project, json, timeout } }. args' names are camelCase (--body-file is bodyFile).
export function parseArgv(argv) {
  const all = argv ?? [];
  // Which command it is, from the first words that aren't options (any option may come before it).
  const plain = [];
  for (let i = 0; i < all.length && plain.length < 2; i++) {
    const w = String(all[i]);
    if (w === "--") break;
    if (w.startsWith("-") && w !== "-") {
      const name = w.slice(2).split("=")[0];
      const type = GLOBAL_FLAGS[name]?.type ?? commands().map((c) => c.flags?.[name]).find(Boolean);
      if (type && type !== "bool" && !w.includes("=")) i++;
      continue;
    }
    plain.push(w);
  }
  if (!plain.length || plain[0] === "help") {
    const asked = plain[0] === "help" ? commandOf(all.slice(all.indexOf("help") + 1).map(String)) : null;
    return { help: usage(asked) };
  }
  const command = commandOf(plain);
  if (!command) {
    const group = commands().filter((c) => c.words[0] === plain[0]);
    return { error: group.length ? `"${plain[0]}" needs one of: ${group.map((c) => c.words[1]).join(", ")}.` : `Unknown command "${plain[0]}". Try herdr-tasks --help.` };
  }
  const spec = { ...Object.fromEntries(Object.entries(GLOBAL_FLAGS).map(([k, f]) => [k, f.type])), ...(command.flags ?? {}), ...(command.confirm ? { yes: "bool" } : {}) };
  const parts = split(all, spec);
  if (parts.error) return { error: parts.error, command };
  const { flags } = parts;
  if (flags.help) return { help: usage(command) };
  // The command's own words are taken out once, where they are.
  const words = [...parts.words];
  for (const w of command.words) words.splice(words.indexOf(w), 1);
  const args = {};
  for (const [name] of Object.entries(command.flags ?? {})) if (flags[name] !== undefined) args[camel(name)] = flags[name];
  const wanted = command.args ?? [];
  if (command.rest) {
    const text = words.join(" ").trim();
    if (!text) return { error: `${command.words.join(" ")} needs its ${command.rest}.`, command };
    args[command.rest] = text;
  } else {
    if (words.length < wanted.length) return { error: `${command.words.join(" ")} needs its ${wanted.slice(words.length).join(" and ")}.`, command };
    if (words.length > wanted.length) return { error: `${command.words.join(" ")} doesn't take "${words.slice(wanted.length).join(" ")}".`, command };
    wanted.forEach((name, i) => { args[name] = words[i]; });
  }
  if (command.confirm && !flags.yes) return { error: `${command.words.join(" ")} can't be undone from here: add --yes to do it.`, command };
  const bad = command.check?.(args);
  if (bad) return { error: bad, command };
  let timeout = LONG_OPS.includes(command.op) ? 600 : 120;
  if (flags.timeout !== undefined) {
    timeout = Number(flags.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) return { error: "--timeout is a number of seconds.", command };
  }
  return { command, op: command.op, args, global: { cwd: flags.cwd ?? null, on: flags.on ?? null, project: flags.project ?? null, json: Boolean(flags.json), timeout } };
}
