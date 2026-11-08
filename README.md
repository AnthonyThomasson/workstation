# workstation

My [Herdr](https://herdr.dev) setup: the **Tony** layout, one copy of each reusable mod, my own keys, settings, themes and workflows, and my Skillshare skills.

## Repository layout

The repository root is the Tony gallery layout:

- **`RECIPE.md` and `preview.png`** — Tony's rebuild recipe and preview.
- **`layouts/Tony.json`** — the complete window layout. Tony also uses Herdr's built-in `spaces`, `agents`, `changes`, `files`, `pane` and `workspace-chrome` mods, which are not copied into this repo.
- **`mods/usage/`** — Claude and Kimi session/weekly usage in a compact sidebar block.
- **`mods/status-bar/`** — repository, computer and workspace status along the bottom of the window.
- **`mods/skills/`** — a Skillshare panel for resources, installs, updates, audits, hooks and doctor checks. It is a modified copy of runkids's MIT-licensed [skillshare mod](https://github.com/runkids/skillshare); its license is included with the mod and the runkids credit is preserved in its recipe.
- **`mods/github-tasks/`** — GitHub Project tickets, editing, grooming and label-matched workflow starts.
- **`mods/workflows/`** — workflow editing and run views, companion to GitHub Tasks. `starters/` contains Bug and Story starter YAML files for `~/.config/herdr-app/workflows/`.
- **`mods/sync/`** — a tab-bar button and panel for one-way Sync with prune and main-only Push. See [its README](mods/sync/README.md) for the full interface.
- **`mods/tabs-icons/`** — program icons, agent status and window controls in the tab bar.

Every mod has its own `RECIPE.md`, `preview.png` and `mod.json` beside its code. There are no second copies inside Tony.

Other folders:

- **`personal/`** — my own keys, settings, themes and workflows. Keys and settings are not synchronized because Herdr writes those files itself.
- **`skillshare/`** — Skillshare's `config.yaml`, `agents/` and `skills/`. Installed skills live directly under `skills/` and are tracked in `.metadata.json`; my own skills live under `skills/mine/`.
- **`scripts/sync/`** — the sync script and its rebuild recipe.
- **`tests/`** — `sh tests/sync.test.sh` exercises synchronization in scratch folders; `sh tests/entries.test.sh` checks the Tony/mod gallery structure, mod references and Tony's preview dimensions.

## Add the layout or one mod

For the complete Tony layout, give a Herdr agent this line:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this layout: https://github.com/AnthonyThomasson/workstation
```

For one mod, replace `<name>` with `usage`, `status-bar`, `skills`, `github-tasks`, `workflows`, `sync` or `tabs-icons`:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/AnthonyThomasson/workstation/tree/main/mods/<name>
```

The agent reads the recipe and source, explains any network/program/file access, installs without overwriting existing names, runs Herdr's checks, and leaves recipes, previews and workflow starters out of the installed mod folders.

## Clone the whole setup

Start Herdr once so its config folder exists, then:

```sh
git clone https://github.com/AnthonyThomasson/workstation.git
cd workstation
./scripts/sync/sync.sh --dry-run   # preview both directions; write nothing
./scripts/sync/sync.sh             # synchronize with the installed config
```

Herdr picks up changed layouts and mods without a restart. Choose **Tony** in the layout picker. The GitHub Tasks and Workflows features need `gh`; Skills and Sync's Skillshare features need the `skillshare` CLI.

To use the **Sync** mod afterward, open its tab-bar button, expand **Settings**, and set **Config repo** to this clone's path on the current computer. See [the Sync mod README](mods/sync/README.md) for its panel and behavior.

## `scripts/sync/sync.sh` reference

```sh
./scripts/sync/sync.sh             # two-way: the newer copy of each file wins
./scripts/sync/sync.sh --push      # repo -> Herdr only; the repo wins
./scripts/sync/sync.sh --pull      # Herdr -> repo only; Herdr wins
./scripts/sync/sync.sh --push --prune
./scripts/sync/sync.sh --dry-run   # write nothing; combine with the direction flags above
./scripts/sync/sync.sh --check     # write nothing; fail on absolute home paths in skillshare/config.yaml
./scripts/sync/sync.sh --help      # print usage
```

`--prune` is valid only with `--push`. It moves files inside repo-owned mod folders in Herdr that the repo no longer has into the backup folder; other Herdr files and mods are never removed. Unknown arguments print usage and exit 2.

| Repository source | Herdr destination (`~/.config/herdr-app`) |
| --- | --- |
| `mods/<mod>/`, excluding recipes, previews and `workflows/starters/` | `mods/<mod>/` |
| `layouts/Tony.json` | `layouts/Tony.json` |
| Theme files stored under `personal/herdr-app/themes/`; only files already in the repo | `themes/` |
| Workflow files stored under `personal/herdr-app/workflows/` | `workflows/` |

Set `HERDR_APP_HOME` to use a different Herdr config folder. Herdr's built-in mods and generated files are not pulled. Every replaced or pruned Herdr file is backed up under `~/.config/herdr-app/.workstation-backup/<timestamp>/`; replaced repo files go under `.sync-backup/<timestamp>/`. Nothing is deleted from the repo.

**Skillshare.** The script links `~/.config/skillshare/config.yaml`, `agents` and `skills` to `skillshare/` in this repo. An existing real file/folder is first moved to `<name>.backup-<timestamp>`; an existing wrong link is repointed. Set `SKILLSHARE_HOME` to use a different Skillshare folder.

**Home paths stay private.** `skillshare/config.yaml` sets `preserve_tilde_on_save: true`, and each real run rewrites `$HOME/` to `~/` there. `--check` fails if an absolute home path remains. Commit after a pull or two-way run because pulled files are repository edits.
