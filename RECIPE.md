# sync.sh recipe

The Sync mod runs `./sync.sh` from this repo's top folder. If the file is missing, the mod offers to generate it: an agent reads this recipe and writes `sync.sh` to match. Write POSIX `sh` (`#!/bin/sh`, `set -eu`), make it executable (`chmod +x`), and keep it free of Bash-only features.

## Purpose

Keep this repo's Herdr setup (mods, the Tony layout, themes, workflows) and its Skillshare config in step with the installed folders. The Herdr config folder is `${HERDR_APP_HOME:-$HOME/.config/herdr-app}`; the Skillshare folder is `${SKILLSHARE_HOME:-$HOME/.config/skillshare}`.

## Flags (the Sync mod depends on these exactly)

| Flags | Meaning |
| --- | --- |
| none | Two-way: the newer copy of each file wins, in either direction. |
| `--push` | Repo to Herdr only (the repo wins). |
| `--pull` | Herdr to repo only (Herdr wins). |
| `--prune` | Only with `--push`: files inside a repo-owned mod folder in Herdr that the repo does not have are moved to the backup folder (not deleted). Other Herdr files and mods are never removed. |
| `--dry-run` | Write nothing; combine with the flags above. |
| `--check` | Stands alone; write nothing; exit 1 and name each file when a Tony copy differs from its entry folder, or `skillshare/config.yaml` holds an absolute home path. |
| `-h`, `--help` | Print usage, exit 0. Any other argument: print usage to stderr, exit 2. |

## Output (a parser reads these exact prefixes)

One line per file change, `<what>: <path>` with `<path>` relative to the Herdr config folder:

- `to repo: <path>` and `to repo (new): <path>`: a file copied (or that would be copied) from Herdr to the repo.
- `to Herdr: <path>` and `to Herdr (new): <path>`: copied (or would be) from the repo to Herdr.
- `removed from Herdr: <path>`: moved to the backup folder by `--prune`.
- `Tony copy (new|changed|removed|extra): <path>`: a refresh of `herdr/tony/mods`.

Then summary lines: `copied: <n> to Herdr, <m> to the repo; <k> already the same` (`would copy` with `--dry-run`, plus `; <p> removed from Herdr` when pruning), `replaced Herdr files were saved to <folder>` and `replaced repo files were saved to <folder>` when backups were made, `refreshed Tony's copies: ...` and `skillshare: linked <n>, <m> already linked`. A `--dry-run` with no direction flag must be a faithful preview of a real two-way run.

## What goes where (repo to the Herdr config folder)

- `herdr/<entry>/mods/<mod>/` to `mods/<mod>/` for every entry folder except `tony`. A new file inside a mod folder on either side is carried over. A mod name must be unique across entries (exit 1 otherwise).
- `herdr/tony/mods/tabs-icons/` to `mods/tabs-icons/` (the one mod that lives only in `tony`).
- `herdr/tony/layouts/Tony.json` to `layouts/Tony.json`.
- `personal/herdr-app/themes/<file>` to `themes/<file>`: only the theme files the repo has.
- `personal/herdr-app/workflows/` to `workflows/`: new files on either side are carried over.
- Never synced: `keys.json` and `settings.json` (Herdr writes them), `.DS_Store`, `gpui-kit.d.ts`, `jsconfig.json`, `layouts/.state/*`.
- Herdr does not load a mod's assets through a symlink, so both sides hold real copies; replace any symlink left in the config folder with a real copy first.
- With both directions, a differing file goes to whichever side is newer by modification time.

## Backups and deletion

A file a run overwrites (or prunes) is first saved at the same relative path in `<config>/.workstation-backup/<timestamp>/` (Herdr's copy) or `<repo>/.sync-backup/<timestamp>/` (the repo's), with `<timestamp>` from `date +%Y%m%d-%H%M%S`. Nothing is ever deleted from the repo's entry folders. Never refuse to run because backups exist.

## Tony's copies

`herdr/tony/mods/<mod>/` is an exact copy of each entry folder's mod. After the sync, every real run (not `--dry-run`) makes it so: add, overwrite and remove files to match the entry, and remove mod folders no entry owns (except `tabs-icons`). `--dry-run` lists what the refresh would do, including files it would pull from Herdr. A pull goes back to the entry folder that owns the mod, never into Tony's copies (except `tabs-icons`). Tony's copies are not backed up: git has them.

## Skillshare

`~/.config/skillshare/{config.yaml,agents,skills}` become symlinks to `skillshare/<name>` in this repo. A real file or folder in the way is moved to `<name>.backup-<timestamp>` first; a link that is already right is left alone (`link ok: <path>`); a link elsewhere is repointed. Skip a name the repo does not have. After a real run, rewrite `$HOME/` to `~/` in `skillshare/config.yaml` so the username never reaches a commit.

## Safety

Refuse to run (exit 1) if the Herdr config folder does not exist, or lies inside this repo. Exit 1 with a message if there is no `herdr` folder next to the script.
