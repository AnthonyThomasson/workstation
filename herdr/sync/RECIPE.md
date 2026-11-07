# Sync

A Herdr tab-bar button and side panel that keep a Git configuration repository and `~/.config/herdr-app` in step. **Sync** brings Herdr in line with the repository (one way) and checks the running Herdr loaded it; **Push** sends Herdr's changes to the repository (from `main` only). A picker chooses which worktree or branch is synced.

![Sync](preview.png)

## What you see

- The default role is a right-aligned 34×30px button with 6px corners in a `theme().chrome` tab-bar strip. Its 16px circular-arrow icon is dimmed until a repository is configured, muted normally, foreground when its panel is selected, `theme().blocked` on an error, and spins once every 900ms while busy. A 9px yellow down arrow means the repository is behind its upstream; an up arrow counts changed files. Both sit at the button's top-right, with no numbers.
- Clicking the button opens **Sync · <machine>** in the host layout's shared side panel: a full-size `theme().background` card with 10px corners, a 1px `theme().border`, a 42px title bar with Close, and a scrolling body with 14px horizontal padding. Sections: **Repo**, then a collapsible **Settings** (the only section, forced open, until a repository is set).
- Repo shows, top to bottom: the branch and folder being synced (expands to the repo's worktrees and local branches; picking a worktree changes the folder, picking a branch runs `git switch` in it), a **Sync** row, and a **Push** row that expands to the changed files and an editable commit message. Disabled actions are dimmed and inert.

## How it behaves

- The button follows the active space's machine; repository path, sync script, picked worktree, state and locks are per machine. The button role owns all polling and work; the Details panel sends requests through persisted shared state.
- The local check runs every 20 seconds and `git fetch` every five minutes, plus on opening the panel or switching machine. It reads branch/upstream, up to 200 incoming and outgoing commits, uncommitted files, and a two-way sync-script dry run. Files the dry run would copy to the repository count as Herdr changes; files it would copy to Herdr are repository-newer and block Push. `.sync-backup/` is excluded.
- **Sync** is one way, repository to Herdr: fast-forward the repository to its upstream if behind (`--autostash`), run the sync script with `--push --prune` (files in a repo-owned mod folder that the repo lacks are moved to the backup folder), then `herdr-app check mods/<mod>` for each mod the repository owns and `herdr-app status` must show no errors. It never commits or pushes.
- **Push** runs only on `main` (checked in the UI and in the script). It refuses while repository-newer files exist, runs the script with `--pull`, restores and refuses if that would overwrite an uncommitted repository edit, commits everything except `.sync-backup`, fetches, rebases onto the upstream (aborting and pushing nothing if it does not apply cleanly), re-runs `--push` if commits came in, and pushes. There is no conflict resolution.
- The one setting is **Config repo** (empty by default; Browse is local-only). The script is always `./sync.sh` in the repository. When it is missing and the repository has a `RECIPE.md`, **Generate sync.sh** opens an agent in a new tab to write it from that recipe.

### Sync script contract

The script is one quoted path, not a command line: absolute, `~/…`, or relative to the repository (`sync.sh` and `./sync.sh` are equivalent); spaces are allowed, arguments are not. It runs from the repository's top-level folder and must accept:

- `--push`: copy repository files to Herdr, with the repository winning.
- `--pull`: copy Herdr files to the repository, with Herdr winning.
- `--dry-run`: write nothing. With no direction flag, perform a two-way comparison and print one line per pending copy: `to repo: <path>` or `to repo (new): <path>` for Herdr-to-repository copies, and `to Herdr: <path>` or `to Herdr (new): <path>` for repository-to-Herdr copies. The mod parses those exact prefixes.

## Built from

- Install `mods/sync/`. Its `mod.json` is `{ "place": "none", "title": "sync" }`; there are no key bindings. The host layout must mount the always-present default/`button` role and should place a `details` role as child `sync` in stack `panel-body` inside column `panel`. The button calls `layout.select`, `layout.show` and `layout.hide` on those ids. Other props roles are `text`, `upgrade` and `srcboth` dialogs, opened by the mod itself.
- `main.js` owns roles, machine context, polling, shared state, locks and operations. `model.js` contains settings, output parsers, badge/count logic and the main-only rule. `ops.js` contains the check, sync, push, list and switch shell scripts. `jobs.js` runs slow work as detached, polled jobs; `channel.js` serializes work per machine.
- `details.js` composes `repo-ui.js` and `settings-ui.js`. `ui.js` supplies the themed controls.
- Herdr APIs include `exec`, `run`, `spaces`, `machines`, `focused`, `layout`, `theme`, `shared`/`setShared`, `knownAgents`, `pickFolder`, `openOverlay`/`closeOverlay`, `notify`, `readTextFile`, timers and `props`. App actions include `layout.select`, `layout.show`, `layout.hide` and `tab.new`.
- Programs and shell utilities include `sh`, `git`, `herdr-app`, `hostname`, `mktemp`, `rm`, `cp`, `mkdir`, `find`, `cat`, `grep`, `sed`, `awk`, `cut`, `paste`, `head`, `tail`, `tr`, `cmp`, `ps`, `kill`, `sleep` and `date`. Long jobs detach with `setsid` where available or shell job control otherwise, clear `HC_SCOPE`, poll files in a temporary directory, and time out after 15 minutes.
- Network access is through `git fetch`, `git pull` and `git push`. It reads and writes the chosen config repository and causes `sync.sh` to read/write `~/.config/herdr-app`; it also writes temporary job files.
- Art is `icons/sync.svg`, `arrow-up.svg`, `arrow-down.svg`, `ring.svg`, `alert.svg`, `check.svg`, `chevron-down.svg`, `chevron-right.svg`, `close.svg`, `folder.svg` and `settings.svg`, referenced as `mods/sync/icons/<name>.svg` and tinted with theme colors.

## Watch out

- **Real side effects:** Sync and Push run the configured script and perform Git commits, rebases, network fetches and pushes. None of these is a simulated gallery preview.
- The button role must remain mounted even while the panel is closed; it owns the locks, timers and background work. A Details panel by itself is not enough. The `panel`/`panel-body`/`sync` ids must match the host layout or the toggle must be adapted.
- The sync script's dry-run output is an interface, not incidental logging. Missing prefixes or a script that writes during `--dry-run` produce wrong badges or unsafe Push decisions. The repository branch needs an upstream for Push.
- Sync removes files only inside repo-owned mod folders (to the backup folder); other Herdr files, mods and layouts are never removed.
- The check reads at most 200 commits in each direction; expanded UI lists are capped at 50 pull entries and 100 push files. Source state retains at most 300 uncommitted files and displays 40. Renaming the mod requires updating all `mods/sync/` asset paths and its self-opened mod name.
- `git`, `sh` and the sync script are required; `herdr-app` is needed for the loaded-in-Herdr check (Sync still runs without it and says it did not check).

## Done when

- `herdr-app check mods/sync` passes. With no repository configured, only open Settings appears; saving a test repository path, script and agent enables the button and panel for that machine.
- A two-way `--dry-run` produces the exact four recognized line prefixes, and the down/up arrows track incoming commits and changed files without numbers. Opening the panel fetches; closing it stops the panel-only reads.
- In throwaway repositories, Sync makes Herdr match the repository, backing up replacements through the script. Push copies Herdr changes, commits, rebases and pushes; repository-newer files block it, and it is refused off `main`.
- A push that cannot rebase or would overwrite an uncommitted repository edit pushes nothing and says why. Picking a worktree or switching a branch changes which folder Sync, Push and the check use.
- `node --test mods/sync` passes after a rebuild.
