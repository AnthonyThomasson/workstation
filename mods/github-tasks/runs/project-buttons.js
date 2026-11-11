// Project commands configured by the ticket worktree's .herdr/config.yaml. Pure, so node --test runs it.
import { parse } from "../lib/index.js";
import { shQuote } from "./run.js";

// Evaluate the configured command as its own quoted script, so its newlines and comments cannot consume the shell reopening.
export const projectButtonArgv = (command, shell) => [shell, "-lc", `eval ${shQuote(command)}; exec ${shQuote(shell)} -l`];

export function parseProjectButtons(source) {
  if (source == null) return { buttons: [], errors: [] };
  let doc;
  try { doc = parse(source); }
  catch (e) { return { buttons: [], errors: [`Invalid YAML: ${e?.message ?? e}`] }; }
  const configured = doc?.buttons;
  if (!Array.isArray(configured)) return { buttons: [], errors: [] };
  const buttons = [], errors = [];
  configured.forEach((button, i) => {
    const name = typeof button?.name === "string" && button.name.trim() ? button.name : null;
    const command = typeof button?.command === "string" && button.command.trim() ? button.command : null;
    if (!name) errors.push(`Button ${i + 1} has no name.`);
    if (!command) errors.push(`Button ${i + 1} has no command.`);
    if (name && command) buttons.push({ name, command });
  });
  return { buttons, errors };
}
