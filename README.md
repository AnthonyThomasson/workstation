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
- **`skillshare/`** — Skillshare's `config.yaml`, `agents/` and `skills/`. Only `skills/mine/` (my own skills) and `skills/.metadata.json` are committed; installed skills are recorded in `.metadata.json` and reinstall from their source. See [Skillshare skills](#skillshare-skills).
- **`scripts/sync/`** — the sync script and its rebuild recipe.
- **`tests/`** — `sh tests/sync.test.sh` exercises synchronization in scratch folders; `sh tests/entries.test.sh` checks the Tony/mod gallery structure, mod references and Tony's preview dimensions; `sh tests/skills.test.sh` checks that git tracks only `skillshare/skills/mine/` and `.metadata.json` there.

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

## Skillshare skills

**What is committed.** Under `skillshare/skills/` only `mine/` (my own skills) and `.metadata.json` are tracked. One `.gitignore` rule ignores every other top-level folder there (`skillshare/skills/*/` except `mine/`), so a skill that Skillshare installs, and `synced/` (skills synced from claude.ai), never reach a commit by accident. `git status` stays clean after an install except for `.metadata.json`, which records each installed skill's source and commit.

**Restore on a fresh clone.** Installed skills (`herdr`, `skillshare`) are not in the clone. `./scripts/sync/sync.sh` reinstalls every recorded skill whose folder is missing, on each real run (two-way, `--push`, `--pull`), at the commit recorded in `.metadata.json`. `--dry-run` prints `would reinstall: <name>`; `--check` never does it. Without the `skillshare` CLI, or offline, it prints `skillshare: could not reinstall <name>: <reason>`, finishes the sync and exits 0. It leaves `.metadata.json` as committed; run `skillshare sync` afterwards to link the skills into your tools.

To do the same by hand, once per entry in `skillshare/skills/.metadata.json` (its `repo_url`, `subdir` and `commit`):

```sh
skillshare install github.com/herdrdev/herdr/skills/herdr --name herdr --branch 2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01 -y -g
skillshare install github.com/runkids/skillshare/skills/skillshare --name skillshare --branch c19ff80611c20e9b69392ad4e4aeaf491d5036b7 -y -g
git checkout skillshare/skills/.metadata.json   # the installs rewrite each entry's source and branch fields
```

A plain `skillshare install -g` also restores every recorded skill, but one with no recorded branch (`skillshare`) comes back at its latest commit, not the recorded one.

### My skills

Each skill in `skillshare/skills/mine/` installs by URL (add `-g` for the global source):

| Skill | What it does | Install |
| --- | --- | --- |
| `add-own-skill` | Add a personal skill to this workstation's Skillshare source. | `skillshare install github.com/AnthonyThomasson/workstation/skillshare/skills/mine/add-own-skill` |

To try an install without touching your real Skillshare folder, point Skillshare at a scratch one. It does not read `SKILLSHARE_HOME`; it reads `XDG_CONFIG_HOME` (or `SKILLSHARE_CONFIG`, but then give the config absolute scratch `sources`, because this repo's config points them at `~/.config/skillshare`):

```sh
scratch=$(mktemp -d)
mkdir -p "$scratch/skillshare/skills"
printf 'mode: merge\ntargets: {}\n' > "$scratch/skillshare/config.yaml"
XDG_CONFIG_HOME=$scratch XDG_DATA_HOME=$scratch/data XDG_CACHE_HOME=$scratch/cache XDG_STATE_HOME=$scratch/state \
  skillshare install github.com/AnthonyThomasson/workstation/skillshare/skills/mine/add-own-skill -g -y
ls "$scratch/skillshare/skills"   # add-own-skill
```

When you add a skill to `mine/`, add a row here with its one-line description and its install command (`skillshare install github.com/AnthonyThomasson/workstation/skillshare/skills/mine/<name>`). The `add-own-skill` skill does this as one of its steps.

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

**Skillshare.** The script links `~/.config/skillshare/config.yaml`, `agents` and `skills` to `skillshare/` in this repo. An existing real file/folder is first moved to `<name>.backup-<timestamp>`; an existing wrong link is repointed. Set `SKILLSHARE_HOME` to use a different Skillshare folder (the script then installs recorded skills into it through a temporary copy of its config). After linking, it also reinstalls recorded skills whose folder is missing (see [Skillshare skills](#skillshare-skills)).

**Home paths stay private.** `skillshare/config.yaml` sets `preserve_tilde_on_save: true`, and each real run rewrites `$HOME/` to `~/` there. `--check` fails if an absolute home path remains. Commit after a pull or two-way run because pulled files are repository edits.
