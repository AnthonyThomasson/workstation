# sync.sh recipe

The Sync mod runs `./scripts/sync/sync.sh` from this repo's top folder. If the file is missing, the mod offers to generate it: an agent reads `scripts/sync/RECIPE.md` and writes `scripts/sync/sync.sh` to match. Write POSIX `sh` (`#!/bin/sh`, `set -eu`), make it executable (`chmod +x`), and keep it free of Bash-only features.

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
| `--check` | Stands alone; write nothing; exit 1 and name each file when `skillshare/config.yaml` holds an absolute home path. |
| `-h`, `--help` | Print usage, exit 0. Any other argument: print usage to stderr, exit 2. |

## Output (a parser reads these exact prefixes)

One line per file change, `<what>: <path>` with `<path>` relative to the Herdr config folder:

- `to repo: <path>` and `to repo (new): <path>`: a file copied (or that would be copied) from Herdr to the repo.
- `to Herdr: <path>` and `to Herdr (new): <path>`: copied (or would be) from the repo to Herdr.
- `removed from Herdr: <path>`: moved to the backup folder by `--prune`.

Then summary lines: `copied: <n> to Herdr, <m> to the repo; <k> already the same` (`would copy` with `--dry-run`, plus `; <p> removed from Herdr` when pruning), `replaced Herdr files were saved to <folder>` and `replaced repo files were saved to <folder>` when backups were made, `skillshare: linked <n>, <m> already linked`, and, for recorded skills (see "Reinstall recorded skills"), `reinstalled: <name>` / `would reinstall: <name>` / `skillshare: could not reinstall <name>: <reason>`. A `--dry-run` with no direction flag must be a faithful preview of a real two-way run.

## What goes where (repo to the Herdr config folder)

- `mods/<mod>/` to `mods/<mod>/` for every mod. A new file inside a mod folder on either side is carried over, except for the repository-only files below.
- `layouts/Tony.json` to `layouts/Tony.json`.
- `personal/herdr-app/themes/<file>` to `themes/<file>`: only the theme files the repo has.
- `personal/herdr-app/workflows/` to `workflows/`: new files on either side are carried over.
- Never synced: each mod's `RECIPE.md` and `preview.png`. These stay in the repo; a pull never removes them, and `--prune` never treats their Herdr-side namesakes as extra files.
- Never synced: `keys.json` and `settings.json` (Herdr writes them), `.DS_Store`, `gpui-kit.d.ts`, `jsconfig.json`, `layouts/.state/*`.
- Herdr does not load a mod's assets through a symlink, so both sides hold real copies; replace any symlink left in the config folder with a real copy first.
- With both directions, a differing file goes to whichever side is newer by modification time.

## Backups and deletion

A file a run overwrites (or prunes) is first saved at the same relative path in `<config>/.workstation-backup/<timestamp>/` (Herdr's copy) or `<repo>/.sync-backup/<timestamp>/` (the repo's), with `<timestamp>` from `date +%Y%m%d-%H%M%S`. Nothing is ever deleted from the repo. Never refuse to run because backups exist.

## Skillshare

`~/.config/skillshare/{config.yaml,agents,skills}` become symlinks to `skillshare/<name>` in this repo. A real file or folder in the way is moved to `<name>.backup-<timestamp>` first; a link that is already right is left alone (`link ok: <path>`); a link elsewhere is repointed. Skip a name the repo does not have. After a real run, rewrite `$HOME/` to `~/` in `skillshare/config.yaml` so the username never reaches a commit.

## Reinstall recorded skills

Only `skillshare/skills/mine/` and `skillshare/skills/.metadata.json` are committed; every other skill under `skillshare/skills/` is ignored by git and recorded in `.metadata.json` (`repo_url`, `subdir`, `commit` per entry). After linking, every run (two-way, `--push`, `--pull`, with or without `--prune`) reinstalls each recorded skill whose folder is missing under `${SKILLSHARE_HOME:-$HOME/.config/skillshare}/skills`, so a fresh clone gets them back:

- Per entry, parse `.metadata.json` with `awk` (no `jq` or `node`): entries are indented 4 spaces and their fields 6. Run `skillshare install <source> --name <entry> --branch <commit> -y -g`, where `<source>` is `repo_url` without `https://` and `.git`, plus `/<subdir>` (for an `ssh` `git@` URL, `//<subdir>`). `--branch <commit>` pins the recorded commit; `skillshare install` with no argument does not, because it installs a skill that has no recorded branch from its latest commit.
- `--branch` takes the full commit SHA (Skillshare accepts a branch, tag or commit SHA there).
- Skillshare ignores `SKILLSHARE_HOME`: it installs where the config's `sources.skills` says, and the repo's config says `~/.config/skillshare/skills`, which expands from `HOME`. So when `SKILLSHARE_HOME` is set, run Skillshare with `SKILLSHARE_CONFIG` pointing at a temporary copy of `$SKILLSHARE_HOME/config.yaml` (in the script's temp folder) whose `sources:` section is replaced by `skills: $SKILLSHARE_HOME/skills` and `agents: $SKILLSHARE_HOME/agents`, so the install always lands in the folder the script checked. Without `SKILLSHARE_HOME` the folder is Skillshare's default and no config override is needed.
- Reinstalling rewrites the entry's `source`, `branch` and `installed_at` in `.metadata.json`. Copy the file first and put it back afterwards, so a restore leaves the committed record untouched. Put it back from the exit trap as well (the script traps `INT`, `TERM` and `HUP` and exits), so an interrupted install does not leave it rewritten.
- Print `reinstalled: <name>` after a successful install (the folder must exist afterwards).
- `--dry-run` prints `would reinstall: <name>` instead of installing, and does not need the CLI. An entry without `repo_url` gets its warning in a dry run too, so the preview matches a real run. When the skills link would still be created, look in `skillshare/skills` in the repo instead of the Skillshare folder.
- `--check` never reinstalls.
- Never fatal. An entry without `repo_url`, a missing `skillshare` CLI, or a failed install (offline) prints `skillshare: could not reinstall <name>: <reason>` (the last non-empty line `skillshare` printed, with `\r` and ANSI colour codes removed, or `no repo_url is recorded for it`, or `the skillshare CLI was not found`); the rest of the sync finishes and the exit status stays 0.
- Skip it when `skillshare/skills/.metadata.json` does not exist. It does not run `skillshare sync`.

## Safety

The repo root is two folders above the script (`scripts/sync/sync.sh` -> the repo root). Refuse to run (exit 1) if the Herdr config folder does not exist, or lies inside this repo. Exit 1 with a message if there is no `mods/` or `layouts/` folder at the repo root.
