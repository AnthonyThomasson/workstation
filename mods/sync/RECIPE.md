# Sync

A Herdr tab-bar button and side panel that keep `~/.config/herdr-app` in step with a clone of this repo, one way and automatically. Running `mods/sync/sync.sh` from a clone installs the repo into Herdr and links that clone to the mod through `sync.json`; the mod then syncs the clone's picked branch or worktree on its own once files stop changing, or on **Force sync**. There are no settings, no Push, and no git network calls.

![Sync](preview.png)

## What you see

- The default role is a right-aligned 34×30px button with 6px corners in a `theme().chrome` tab-bar strip. Its 16px circular-arrow icon is `theme().dim` when no repo is linked, muted normally, foreground when its panel is selected, `theme().blocked` when the last sync failed, and spins once every 900ms while syncing. It has no badge or arrows.
- Clicking the button opens **Sync** in the host layout's shared side panel: a full-size `theme().background` card with 10px corners, a 1px `theme().border`, a 42px title bar with Close, and a scrolling body with 14px horizontal padding.
- With no repo linked the body is exactly one line: "No repo linked. Run mods/sync/sync.sh from your clone."
- Otherwise it shows, top to bottom: the branch row (chevron, `Branch <name>`, or `Detached HEAD`), with a **Force sync** button on its right; the picked folder (`~` for home); `origin: <remote>` (omitted when `sync.json` has no remote); and a status line: `Synced 12s ago · watching for changes`, `Syncing…`, `Not synced yet · watching for changes`, `not watching (<reason>)` if the watcher cannot start, or the last error in `theme().blocked`.
- Expanding the branch row shows the picker: a search box, then **Recent worktrees** (the 5 whose HEAD reflog has the newest entry; a worktree with no reflog sorts last) and **Recent branches** (the 5 local branches most recently checked out: the newest `checkout: moving from X to <branch>` entry across the HEAD reflogs of the repo and every worktree wins, same-second entries go by position in the reflog; a branch checked out in a worktree without such an entry counts from that worktree's newest reflog entry; branches never checked out come after, by tip commit date then name). Typing in the search box filters **all** worktrees (case-insensitive, every word must match the branch or the folder name) and **all** local branches (by name), showing up to 50 of each with a "N more" note. Picking a worktree syncs that checkout; picking a branch runs `git switch` in the picked folder and syncs; a branch checked out in another worktree is greyed out. The picker is drawn by `picker-ui.js` alone; ordering and filtering are the pure functions in `targets.js`.

## How it behaves

- **This computer only.** The button role reads `<appHome()>/sync.json` (`$HERDR_APP_HOME` or `~/.config/herdr-app`) every 5 seconds and when the panel opens. It follows no space's machine and has no per-machine state. `{"repo": "<clone>", "remote": "<origin url or empty>"}` is written by `sync.sh`; a missing, unreadable or repo-less file, or a `repo` folder that is gone (or is not a git repository), means unlinked: the icon is dim, the watcher is off and Force sync does nothing.
- **The link.** The linked repo is the one the mod remembers, as long as `sync.json` names it or one of its worktrees (also one the repo still lists but whose folder has been deleted). Running the script from a worktree rewrites `sync.json` to that worktree, and this keeps the link, and the picked worktree, intact. `sync.json` naming any other clone moves the link to that clone and resets the pick. `ops.js` `LINK` decides this with `git worktree list`.
- **The pick.** The picked worktree is shared state (`sync.pick.v2`, `{repo, dir}`; `dir` empty means the repo itself), reset when the linked repo changes, and ignored once it is no longer a worktree of the repo. The worktree and branch lists are read from the linked repo every 20 seconds while the panel is shown.
- **Sync** runs the picked folder's `mods/sync/sync.sh` from that folder as a detached, polled job (an exec stops after 30 s), then `herdr-app check mods/<mod>` for every mod the folder owns and `herdr-app status` must show no errors (a missing `herdr-app`, or one that is not answering, only says the check was skipped). Success updates "Synced … ago"; failure turns the icon red, shows the script's last words in the panel and raises an error notification. A successful Force sync raises a success notification; automatic ones are silent.
- **The watcher** is `watchFolder(<picked folder>)` on this computer, restarted when the picked folder changes (retrying every 15 s if it rejects). Batches go through filters before they count: paths inside any `.git` are dropped; paths git ignores are dropped (`git check-ignore`, one batch at a time); and when the quiet period ends, the folder's content fingerprint (`cksum` of every file git would not ignore, `skillshare/` left out) must differ from the baseline, so touching a file or saving it unchanged syncs nothing. `queue.js` (pure, tested with fake time) does the rest: each change restarts a 3 second timer; when it fires, one sync runs. A burst is one sync.
- **Baseline and no self-trigger.** The fingerprint is taken just before the script runs and is the baseline for the next check, and again right after it. The script writes into the repo only under `skillshare/` (it rewrites `$HOME/` to `~/` in `skillshare/config.yaml`, and Skillshare reinstalls recorded skills into `skillshare/skills/<name>/` and rewrites `.metadata.json`); that folder is not in the fingerprint and is never copied to Herdr, so the script's own writes cannot look like changes, and events under it while a sync runs are ignored. Edits to `skillshare/` therefore do not sync by themselves; Force sync does.
- **Follow-ups.** Events that arrive during a sync are not a reason to sync again by themselves: a branch switch's files are reported after the sync began and the sync already copied them. They only ask for a content check once the sync ends (quiet period first), which compares the folder with the fingerprint taken before the script ran. If the two fingerprints around the script differ, something was edited during the copy: that is one more sync after a quiet period, which no check can cancel (even if the edit was reverted) and which later events do not lose. Force sync pressed during a sync does one more at once, however often it is pressed. Syncs never run in parallel. Switching branch or worktree starts one sync of the new checkout directly (and the watcher moves to it), not two.
- The picker's `git switch` is the only git command the mod runs that writes anything, and only on the person's click.

## Sync script

`mods/sync/sync.sh` is the script this mod runs. It is POSIX `sh` (`#!/bin/sh`, `set -eu`, executable), lives inside the mod, and is copied to Herdr with the rest of the mod, so `mods/sync/sync.sh` in a clone is also the one setup command. Its test is `mods/sync/sync.test.sh` (`sh mods/sync/sync.test.sh`); both are copied to Herdr like any other file in the mod folder.

### Purpose

Copy the repo's Herdr setup (mods, the Tony layout, themes, workflows) into the Herdr config folder, link Skillshare to the repo, and record which clone did it. The Herdr config folder is `${HERDR_APP_HOME:-$HOME/.config/herdr-app}` and must exist (Herdr must have been started once); the Skillshare folder is `${SKILLSHARE_HOME:-$HOME/.config/skillshare}`. The clone is `git rev-parse --show-toplevel` of the script's folder (two folders above the script when git is not available). Exit 1 if there is no `mods/` or `layouts/` folder there, if the Herdr config folder is missing, or if it lies inside the clone.

### Flags

| Flags | Meaning |
| --- | --- |
| none | Repo to Herdr, with prune; writes `sync.json`. |
| `--dry-run` | Write nothing (not `sync.json`, not links, not reinstalls); print what a real run would do. |
| `--check` | Stands alone; write nothing; exit 1 and name each line when `skillshare/config.yaml` holds an absolute home path. |
| `-h`, `--help` | Print usage, exit 0. Any other argument, or `--check` with `--dry-run`: usage to stderr, exit 2. |

There is no `--push`, `--pull` or `--prune`, and no two-way mode: Herdr-side edits are overwritten and never copied back.

### Output

One line per change, `<what>: <path>` with `<path>` relative to the Herdr config folder:

- `to Herdr (new): <path>` and `to Herdr: <path>`: a file copied (or, with `--dry-run`, that would be copied) to Herdr.
- `removed from Herdr: <path>`: a file deleted by the prune.

Then summary lines: `copied: <n> to Herdr, <m> removed from Herdr; <k> already the same` (`would copy` with `--dry-run`), `linked: <config>/sync.json` (`would link` with `--dry-run`), `skillshare: linked <n>, <m> already linked` (`would link` with `--dry-run`), and, for recorded skills, `reinstalled: <name>`, `would reinstall: <name>` and `skillshare: could not reinstall <name>: <reason>`. A caller that only needs the result reads the exit code and the `copied:` summary.

### What goes where (repo to the Herdr config folder)

- `mods/<mod>/` to `mods/<mod>/` for every mod, including `mods/sync/sync.sh` and `mods/sync/sync.test.sh`. Herdr does not load a mod's assets through a symlink, so Herdr holds real copies (a symlink left by an older version is replaced with a copy first).
- `layouts/Tony.json` to `layouts/Tony.json`.
- The root `preview.png` to `layouts/Tony.png`: Tony's preview, which Herdr's layout picker shows.
- `personal/herdr-app/themes/<file>` to `themes/<file>`, and `personal/herdr-app/workflows/<file>` to `workflows/<file>`: only files the repo has.
- Never copied: each mod's `RECIPE.md` and `preview.png`, Herdr's top-level `keys.json` and `settings.json` (Herdr writes them; a mod's own `keys.json` is copied), `.DS_Store`, `gpui-kit.d.ts`, `jsconfig.json`, `layouts/.state/*`.
- The repo always wins: a differing file in Herdr is overwritten, whichever is newer. Nothing is copied from Herdr to the repo (the one write into the repo is the `~/` normalising of `skillshare/config.yaml`, below), and nothing is backed up (no `.workstation-backup/`, no `.sync-backup/`).
- Prune: a file inside a repo-owned mod folder in Herdr (`mods/<mod>/` for a mod the repo has) that the repo does not have is deleted, and a folder that leaves empty goes with it. Other Herdr files, themes, workflows and mods the repo does not own are never removed.

### sync.json

Every real run writes `<config>/sync.json` last-run-wins, as one JSON line (written to a temporary file and moved into place): `{"repo": "<git rev-parse --show-toplevel>", "remote": "<git remote get-url origin>"}`. `remote` is an empty string when there is no `origin` (or no git). Both values are JSON-escaped. This is how the Sync mod, on any machine, finds the clone to watch.

### Skillshare

`~/.config/skillshare/{config.yaml,agents,skills}` become symlinks to `skillshare/<name>` in the clone. A real file or folder in the way is moved to `<name>.backup-<timestamp>` first (the one backup that stays); a link that is already right is left alone (`link ok: <path>`); a link elsewhere is repointed. A name the repo does not have is skipped. `skillshare/config.yaml` sets `preserve_tilde_on_save: true`, and each real run rewrites `$HOME/` to `~/` there so the username never reaches a commit (`--check` fails if an absolute home path remains).

Only `skillshare/skills/mine/` and `skillshare/skills/.metadata.json` are committed; every other top-level folder under `skillshare/skills/` is ignored by git, and installed skills are recorded in `.metadata.json` (`repo_url`, `subdir`, `commit` per entry).

### Reinstall recorded skills

After linking, every real run reinstalls each recorded skill whose folder is missing under `${SKILLSHARE_HOME:-$HOME/.config/skillshare}/skills`, so a fresh clone gets them back at the recorded commit:

- Per entry, parse `.metadata.json` with `awk` (no `jq` or `node`): entries are indented 4 spaces and their fields 6. Run `skillshare install <source> --name <entry> --branch <commit> -y -g`, where `<source>` is `repo_url` without `https://` and `.git`, plus `/<subdir>` (for an `ssh` `git@` URL, `//<subdir>`). `--branch` pins the recorded commit (a full SHA); a plain `skillshare install -g` would install an entry without a recorded branch from its latest commit.
- Skillshare ignores `SKILLSHARE_HOME`: it installs where the config's `sources.skills` says, and the repo's config says `~/.config/skillshare/skills`, which expands from `HOME`. So when `SKILLSHARE_HOME` is set, run Skillshare with `SKILLSHARE_CONFIG` pointing at a temporary copy of `$SKILLSHARE_HOME/config.yaml` whose `sources:` section is replaced by `skills: $SKILLSHARE_HOME/skills` and `agents: $SKILLSHARE_HOME/agents`.
- Reinstalling rewrites the entry's `source`, `branch` and `installed_at` in `.metadata.json`. Copy the file first and put it back afterwards, also from the exit trap (the script traps `INT`, `TERM` and `HUP`), so an interrupted install leaves the committed record untouched.
- Print `reinstalled: <name>` after a successful install (the folder must exist afterwards). `--dry-run` prints `would reinstall: <name>` instead and does not need the CLI; when the skills link would still be created, it looks in `skillshare/skills` in the clone. `--check` never reinstalls. The script does not run `skillshare sync`; run it afterwards to link the skills into your tools.
- Never fatal. An entry without `repo_url`, a missing `skillshare` CLI, or a failed install (offline) prints `skillshare: could not reinstall <name>: <reason>` (the last non-empty line `skillshare` printed with `\r` and ANSI colour codes removed, or `no repo_url is recorded for it`, or `the skillshare CLI was not found`); the rest of the run finishes and the exit status stays 0. Skipped when `.metadata.json` does not exist.

To reinstall one entry by hand: `skillshare install <repo_url-without-https-and-.git>/<subdir> --name <name> --branch <commit> -y -g`, then `git checkout skillshare/skills/.metadata.json`. To try an install without touching the real Skillshare folder, point Skillshare at a scratch one (it reads `XDG_CONFIG_HOME`, or `SKILLSHARE_CONFIG` with absolute scratch `sources`; it does not read `SKILLSHARE_HOME`).

## Built from

- Install `mods/sync/`. `RECIPE.md` and `preview.png` sit inside `mods/sync/`, and an installing agent leaves them out. Its `mod.json` is `{ "place": "none", "title": "sync" }`; there are no key bindings. The host layout must mount the always-present default/`button` role and should place a `details` role as child `sync` in stack `panel-body` inside column `panel`. The button calls `layout.select`, `layout.show` and `layout.hide` on those ids.
- `main.js` owns the roles, the link, the watcher, shared state and every sync. `model.js` contains `sync.json` parsing, the pick rule, the status line and path helpers. `queue.js` is the pure debounce/follow-up logic. `targets.js` is the pure ordering and filtering of the picker's lists (`orderTargets`, `pickerView`). `ops.js` contains the link, sync, snapshot, ignore-check, list and switch shell scripts; the list script reads each worktree's `logs/HEAD` in one pass. `jobs.js` runs the sync as a detached, polled job; `channel.js` carries the panel's requests (`force`, `pick`, `switch`) to the button.
- `details.js` composes `repo-ui.js` (the panel) and `picker-ui.js` (the list under the branch row). `ui.js` supplies the themed controls.
- Shared state: `sync.link.v2` (`{linked, repo, remote, dir, branch}`), `sync.pick.v2`, `sync.run.v2` (`{syncing, ok, message, at, watching, watchError}`) and the request value `sync.request.v2`.
- Herdr APIs include `exec`, `run`, `layout`, `theme`, `shared`/`setShared`, `notify`, `readTextFile`, `watchFolder`, `appHome`, `home`, timers (`cx.timer.every`, `cx.sleep`, `cx.spawn`) and `props`. App actions include `layout.select`, `layout.show` and `layout.hide`.
- Programs and shell utilities include `sh`, `git` (`rev-parse` incl. `--absolute-git-dir`, `worktree list`, `symbolic-ref`, `ls-files`, `check-ignore`, `for-each-ref`, `switch`), `herdr-app`, `mktemp`, `rm`, `xargs`, `cksum`, `grep`, `awk`, `tail`, `basename`, `find`, `cat`, `ps`, `kill`, `sleep`. Long jobs detach with `setsid` where available or shell job control otherwise, clear `HC_SCOPE`, poll files in a temporary directory, and time out after 15 minutes.
- Network access: none. The mod makes no `git fetch`, `pull` or `push` calls, and `sync.sh` does not either (Skillshare reinstalls of recorded skills may reach their sources). It reads the linked repo, runs `mods/sync/sync.sh` in the picked folder (which writes `~/.config/herdr-app` and `sync.json`), and writes temporary job files.
- Art is `icons/sync.svg`, `chevron-down.svg`, `chevron-right.svg`, `close.svg` and `search.svg`, referenced as `mods/sync/icons/<name>.svg` and tinted with theme colors.

## Watch out

- **Real side effects:** every sync runs the picked folder's `mods/sync/sync.sh` for real: Herdr files are overwritten and pruned without a backup, Skillshare links are changed and recorded skills are reinstalled. A watched folder syncs by itself; the mod does not stop at a draft.
- The button role must remain mounted even while the panel is closed; it owns the link, the watcher and the syncs. A Details panel by itself is not enough. The `panel`/`panel-body`/`sync` ids must match the host layout or the toggle must be adapted.
- The script is run from the picked folder, so a worktree on an old branch runs its own (possibly old) `sync.sh`; a folder without `mods/sync/sync.sh` fails with "mods/sync/sync.sh was not found".
- `sync.json` is rewritten by every sync to the picked folder's top level, so it names a worktree after a worktree is synced; the mod's link logic (above) is what keeps the repo linked. A worktree that is deleted and no longer listed by the repo leaves `sync.json` pointing at nothing: the panel says no repo is linked until the script is run from a clone again.
- On Linux the watcher skips ignored directories and rejects trees of more than 4096 folders; the status line then says "not watching (…)" and Force sync still works. macOS watches ignored directories too, which is why ignored paths are filtered here.
- A sync that changes this mod's own files makes Herdr reload the mod while the sync's job is still running. The new instance clears "Syncing…" (it cannot see that sync's result) and takes a new baseline, so at most one extra sync can follow.
- The content fingerprint reads every non-ignored file in the folder (outside `skillshare/`) before and after each sync and before each quiet-period sync; a repo with very large tracked files makes that slow.
- `git`, `sh` and `mods/sync/sync.sh` are required; `herdr-app` is needed for the loaded-in-Herdr check (a sync still runs without it and says it did not check). Renaming the mod requires updating all `mods/sync/` asset paths and `SCRIPT` in `model.js`.

## Done when

- `herdr-app check mods/sync` passes.
- With no `sync.json`, or one whose `repo` folder is gone, the panel shows only "No repo linked. Run mods/sync/sync.sh from your clone.", the icon is dim, and nothing syncs. After running `mods/sync/sync.sh` from a clone, the panel shows that clone's branch, folder and `origin` with no setup.
- Editing a file in a repo mod shows up in Herdr about 3 seconds after the last save; a burst of edits is one sync; saving a file unchanged, changing only git-ignored files, or the script's own `skillshare/` writes start no sync; a branch switch is exactly one sync, and an edit made during a sync is not lost. Force sync works at any time and, pressed during a sync, runs exactly one more after it.
- Picking a worktree or switching a branch syncs that checkout once. Running the script from a worktree keeps the repo linked and the pick.
- The panel never fetches, pulls, pushes or commits, and shows no behind/up arrows, Settings, Push row or Generate button.
- `node --test mods/sync`, `sh mods/sync/sync.test.sh` and `sh tests/entries.test.sh` pass.
