# sync

Keeps Herdr's config folder (`~/.config/herdr-app`) and your config repo in step, from one button in the tab bar. It works with any config repo: nothing about a particular repo is written into the mod.

The button shows a badge:

- `↓N` commits the repo is behind its remote
- `↑M` files changed in Herdr's config that are not in the repo yet, plus anything uncommitted in the repo (skills included)

No badge means both are zero. The button follows the shown space's machine and uses that machine's settings.

## The popover

Click the button.

| Row | Button | What it does |
| --- | --- | --- |
| Behind by N commits (expands to list them) | **Pull** | `git pull --rebase`, then the sync script with `--push` (the repo wins; the script backs up any Herdr file it overwrites), then `skillshare sync --all -g` if skillshare is installed. |
| N files changed in Herdr (expands to list the files, with an editable commit message and "N commits not pushed") | **Push** | The sync script with `--pull`, commit everything, `git pull --rebase`, push to the branch's upstream. If the rebase brought in remote commits, the sync script runs with `--push` afterwards so Herdr matches. |
| Skillshare | Sync targets | Placeholder; targets are in Details. |

`Details…` opens a tab with Targets, Source, Machines and Conflicts. The gear opens the settings dialog.

`git fetch` runs every 5 minutes and whenever the popover opens. The local check, the sync script's `--pull --dry-run` plus `git status`, runs every 20 seconds.

## Conflicts

When a push's rebase, or its copy of Herdr's files, meets a conflict, sync undoes the half-done rebase and pushes nothing. It opens the conflict agent in a new tab in the repo folder with a brief naming each conflicting file and what each side changed. The button and popover show "Conflict, resolving" until the repo is clean: no rebase or merge in progress, no unmerged files, and the remote's commits contained in the repo.

A copy conflict means Herdr's copy of a file would overwrite an uncommitted edit in the repo. The repo's edit is put back and Herdr's version is saved under `.sync-backup/conflict-<time>/herdr/` in the repo (sync adds `.sync-backup/` to the repo's `.git/info/exclude`).

## Settings

Per machine: this computer, and each machine from `hc machine ls`. The dialog edits the machine the shown space is on. They are stored with Herdr's persisted shared values.

| Setting | Default |
| --- | --- |
| Config repo (folder path on that machine; this computer has a Browse button) | empty; the button reads "Set up" |
| Sync script, relative to the repo | `./mount.sh` |
| Agent for conflicts (an installed agent from Herdr's list) | Claude Code |

The sync script must take `--push` (repo to Herdr), `--pull` (Herdr to repo) and `--dry-run`, and print `to repo: <path>` or `to repo (new): <path>` for each file a `--pull` would copy. This repo's `mount.sh` does.

## Files

- `model.js` pure logic: settings, parsing what the scripts print, the badge, the conflict brief
- `ops.js` the check, pull and push shell scripts and the functions that run them
- `channel.js` how the popover and dialogs hand work to the button (shared values, one lock per machine)
- `details.js` the Details tab, one function per section
- `ui.js` the shared look
- `main.js` the views: button, popover, settings dialog, details tab
- `*.test.js` run with `node --test herdr/sync/mods/sync` (`ops.test.js` uses throwaway git repositories and this repo's `mount.sh`)
