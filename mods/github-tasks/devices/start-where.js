// The opt-in "Start this repo's tickets on the Test device": which `where` a Start uses. Pure: the binding, the repo, the selected
// space's `where` ({ cwd, on }) and the cheap light (cheapHealth over `hc machine ls --json`) go in, the plan comes out.
//
//   toggle off, or the space is on another machine, or no folder   -> where unchanged, on: null (nothing about Start changes)
//   toggle on, space on this computer, light not red               -> where = { cwd: repoRoots[repo], on: machine }, on: machine
//   toggle on, space on this computer, light red (or unknown)      -> refusal: the reason. NEVER a fallback to this computer.
//
// The swap happens AFTER the workflows are loaded (loadWorkflows keeps reading the repo's workflows from the local checkout): only
// startRun gets the device's where, so the run folder stays on this computer and the worktree and agents go on the device.
import { failing, repoRootFor, startsHere } from "./test-device.js";

const UNCHANGED = (where) => ({ where, on: null });

// -> { where, on, refusal? }. light: cheapHealth's { level, checks } for the binding, or null when it is not known (refused).
export function startWhere({ binding, repo, where, light }) {
  if (!startsHere(binding, repo) || where?.on || !where?.cwd) return UNCHANGED(where);
  const machine = binding.machine;
  if (!light) return { where, on: null, refusal: refuse(machine, `Couldn't tell whether \`${machine}\` is connected.`) };
  if (light.level === "red") {
    const reasons = failing({ checks: light.checks }).filter((c) => c.level === "red");
    const text = reasons.map((c) => [c.message, c.fix].filter(Boolean).join(" ")).join(" ") || `\`${machine}\` isn't ready.`;
    return { where, on: null, refusal: refuse(machine, text) };
  }
  return { where: { cwd: repoRootFor(binding, repo), on: machine }, on: machine };
}

const refuse = (machine, reason) => `Can't start on ${machine}: ${reason} Turn off "Start this repo's tickets on ${machine}" in Task settings to start here.`;

// The play button's tooltip: a refusal says why it won't start, a device Start says where, else the plain "Start".
export const startTip = (plan) => plan?.refusal ?? (plan?.on ? startsOnText(plan.on) : "Start");

// The Start dialog's line: the same words, or null when nothing about Start changed.
export const startNote = (plan) => plan?.refusal ?? (plan?.on ? startsOnText(plan.on) : null);

export const startsOnText = (machine) => `Starts on ${machine}`;
