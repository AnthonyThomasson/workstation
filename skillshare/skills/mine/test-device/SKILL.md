---
name: test-device
description: "Run a repo's tests or a command on the Test device (a Herdr machine bound in Task settings) with herdr-tasks. Use when a build or test needs another OS or machine than this one, such as Windows, or the user says to run it on the test device."
---

# Test device

The Test device is one Herdr machine that the Tasks mod (github-tasks) has bound in its Task settings. It is where a commit can be built and tested on another OS than this computer's. The machine is whatever is bound: never name or hard-code one, and never read a hostname, user or key (none is stored). `herdr-tasks` finds it for you.

Needs Herdr open with the Tasks sidebar, and `herdr-tasks` on the PATH (`~/.config/herdr-app/mods/github-tasks/bin/herdr-tasks`). Run every command from inside the repo (or pass `--cwd <repo>`).

## When to use it

- The tests or build must run on the other OS, or on a machine with a toolchain this one lacks.
- You have a commit (committed work, not a dirty tree) and want its exit code and log.

Don't use it for GUI or interactive tests (commands run headless), for runs longer than 10 minutes (Herdr ends a command at 600s), or to deploy anything.

## 1. Check it before you rely on it

```
herdr-tasks device
```

Prints the bound machine, its light, the repo's folder on it and each failing check with a fix. Green: go. Yellow: usable, and the lines say what is degraded (for example the machine's `gh` can't reach the project). Red, or nothing bound: it exits 5 (below), and what to fix is printed. `--json` gives the binding (`machine`, `os`, `repoRoots`, `light`, ...), so a script reads the device name from there. When nothing is bound or the light is red, `--json` prints the error wrapper instead (`{ "error": …, "code": "not-ready", "data": { …the binding and light… } }`) and exits 5, so read the binding from `.data` there, and `.data.machine` is null when nothing is bound. The same wrapper comes with `device check --json` and `device run --json` for exits 5 and 6.

The light is cheap (it only asks Herdr which machines are connected). To look on the device itself, run `herdr-tasks device check`: one script there, a minute on a slow machine. Run it when the light is yellow "Not checked yet", after the machine changed, or when a run said something is wrong with it. Don't run it in a loop.

## 2. Run a command against a commit

```
herdr-tasks device run -- <command...>
herdr-tasks device run --commit <rev> -- <command...>
```

- Runs against `HEAD` (or `--commit <rev>`) of this repo. Uncommitted changes are not sent; a note on stderr says so. Commit first.
- The commit travels as a git bundle into a private ref and a detached worktree on the device. Nothing is pushed and no branch is made on either side. The worktree, bundle and log are removed afterwards (`--keep` leaves the worktree and log there and prints their paths).
- One argument is a shell line (`"npm ci && npm test"`); several arguments are an argv, run as given.
- It prints the command's log, then exits 0 when the command passed and 1 when it failed or ran past 600s. `--json` prints `{ device, commit, exitCode, log, durationMs, timedOut }`. Notes (dirty tree, cleanup trouble) go to stderr.
- It waits up to 720s by default (`--timeout <seconds>` changes it) and a desktop can take over a minute before the command even starts.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | The command passed (or `device`/`device check` found nothing red). | Use the log. |
| 1 | The command failed or timed out (`timedOut: true`). | Read the log; it is a real result, not a device problem. |
| 2 | Usage: a bad option, no command after `--`, or a commit that doesn't resolve. | Fix the call. |
| 4 | Herdr didn't answer. | Open Herdr with the Tasks sidebar, then try again. |
| 5 | The device isn't bound or can't be used: nothing bound, no repo folder for this repo on it, the machine isn't connected, or a check is red. | Run `herdr-tasks device`, read what it says, and tell the user what to fix (Task settings has the card). It is not a test failure. Don't fall back to pushing. |
| 6 | The device is busy: another run holds it (`busy: run <id> since <time>`). A run left behind by a crash is taken over after 15 minutes. | Wait and run again. |

## Never push a branch to get code there

The device gets your commit through `device run`. Don't `git push` a branch, open a PR, or copy files onto the machine just to test something there. If `device run` can't reach the device (exit 5), say so and stop: that is the answer.
