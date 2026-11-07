# sync

Keeps Herdr's config folder (`~/.config/herdr-app`) and your config repo in step, from one icon in the tab bar. It works with any config repo: nothing about a particular repo is written into the mod.

The button is a circular-arrow icon (dimmed until a repo is set, spinning while it works, red on an error). A small yellow arrow at its top-right corner means something is waiting: down is commits the repo is behind its remote, up is files changed in Herdr (or uncommitted in the repo) that Push would send. No numbers.

## The panel

Click the icon to open the Sync panel in Tony's right-hand column. It has **Repo** and **Settings** (collapsed once a repo is set).

- **Branch / worktree**: the first row shows the branch and folder being synced. Expand it to pick another worktree of the repo, or to switch the current folder to another local branch (a branch checked out in another worktree is greyed out). Everything below, the check, Sync and Push, then works on that folder.
- **Sync**: one way, repo to Herdr. It fast-forwards the repo to its remote when behind (uncommitted edits are kept), runs the sync script with `--push --prune` (the repo wins; the script moves each Herdr file it replaces, or removes, under `~/.config/herdr-app/.workstation-backup/`). Files in a repo-owned mod folder that the repo no longer has are removed from Herdr; mods the repo does not own are left alone, then asks the running Herdr whether it loaded the result: every mod the repo owns is loaded once with `herdr-app check`, and `herdr-app status` must list no errors. Herdr picks up changed files by itself; no restart.
- **Push**: Herdr to repo. It runs the sync script with `--pull`, commits everything (editable message), rebases onto the remote and pushes. **Only from `main`**: on any other branch the button is disabled and the script refuses. It is also refused while the repo has files newer than Herdr's copies (Sync first), and if copying Herdr would overwrite an uncommitted repo edit or the rebase does not apply cleanly; in those cases nothing is pushed and the message says why. There is no conflict resolution: fix it in the repo and push again.

## Settings

Per machine (this computer, and each machine from `hc machine ls`); stored with Herdr's persisted shared values.

| Setting | Default |
| --- | --- |
| Config repo (folder path on that machine; this computer has a Browse button) | empty; the panel shows only Settings |
| Sync script: a path relative to the repo, absolute or `~/…`; spaces are fine, arguments are not | `./sync.sh` |

The picked worktree is remembered per machine and cleared when the repo path changes. The sync script must take `--push`, `--pull` and `--dry-run`, and with `--dry-run` alone print `to repo: <path>` / `to repo (new): <path>` for each file it would copy to the repo and `to Herdr: <path>` / `to Herdr (new): <path>` for each it would copy to Herdr. This repo's `sync.sh` does.

`git fetch` runs every 5 minutes and when the panel opens; the local check (the script's dry run plus `git status`) every 20 seconds.

Sync removes files from Herdr only inside mod folders the repo owns, and always keeps a backup.

## Files

- `model.js` pure logic: settings, parsing what the scripts print, the badge, the main-only rule
- `ops.js` the check, sync, push, list and switch shell scripts and the functions that run them
- `channel.js` how the panel hands work to the button (shared values, one lock per machine); `jobs.js` runs slow work as detached, polled jobs
- `details.js` the panel frame; `repo-ui.js` the Repo section; `settings-ui.js` the Settings section; `ui.js` the shared look
- `main.js` the views: the button and the Details panel
- `*.test.js` run with `node --test herdr/sync/mods/sync` (`ops.test.js` uses throwaway git repositories from `scratch-repos.js`, this repo's `sync.sh`, and a stub `herdr-app`)
