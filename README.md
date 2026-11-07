# workstation

My [Herdr](https://herdr.dev) setup: the **Tony** layout, reusable gallery mods, my own keys, settings, themes and workflows, and my Skillshare skills.

## Repository layout

Each folder under `herdr/` is a standalone gallery entry:

- **`herdr/usage/`** — Claude and Kimi session/weekly usage in a compact sidebar block.
- **`herdr/status-bar/`** — repository, machine and workspace status along the bottom of the window.
- **`herdr/skills/`** — a Skillshare panel for resources, installs, updates, audits, hooks and doctor checks. It is a modified copy of runkids's MIT-licensed [skillshare mod](https://github.com/runkids/skillshare); its license is included with the mod.
- **`herdr/github-workflows/`** — the cooperating `github-tasks` and `workflows` mods, plus Bug and Story starter YAML files for `~/.config/herdr-app/workflows/`.
- **`herdr/sync/`** — a tab-bar button and panel that compare Herdr with a config repository, pull and push, synchronize Skillshare, and help resolve conflicts. See [its README](herdr/sync/README.md) for the full interface.
- **`herdr/tony/`** — the complete Tony layout in `layouts/Tony.json`, with real copies of every custom mod it references. `tabs-icons` lives only here. Tony also uses Herdr's built-in `spaces`, `agents`, `changes`, `files`, `pane` and `workspace-chrome` mods.

Other folders:

- **`personal/`** — my own keys, settings, themes and workflows. Keys and settings are not synchronized because Herdr writes those files itself.
- **`skillshare/`** — Skillshare's `config.yaml`, `agents/` and `skills/`. Installed skills live directly under `skills/` and are tracked in `.metadata.json`; my own skills live under `skills/mine/`.
- **`sync.sh`** — synchronizes the public entries, Tony and selected personal themes/workflows with `~/.config/herdr-app`, refreshes Tony's copies, and links Skillshare's config into this repo.
- **`tests/`** — `sh tests/sync.test.sh` exercises synchronization in scratch folders; `sh tests/entries.test.sh` checks gallery entry structure and Tony's preview dimensions.

Every entry has a `RECIPE.md` from which another agent can rebuild it. The custom mods duplicated inside Tony belong to the standalone entries above; edit those owning entries, not Tony's copies.

## Add one gallery entry

Give a Herdr agent the gallery line, replacing `<entry>` with `usage`, `status-bar`, `skills`, `github-workflows`, `sync` or `tony`:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/AnthonyThomasson/workstation/tree/main/herdr/<entry>
```

For `tony`, say **“add this layout”** instead of **“add this mod”**. The agent reads the recipe and source, explains any network/program/file access, installs without overwriting existing names, runs Herdr's checks, and leaves your current layout alone until you switch.

## Clone the whole setup

Start Herdr once so its config folder exists, then:

```sh
git clone https://github.com/AnthonyThomasson/workstation.git
cd workstation
./sync.sh --dry-run   # preview both directions; write nothing
./sync.sh             # synchronize and refresh Tony's copies
```

Herdr picks up changed layouts and mods without a restart. Choose **Tony** in the layout picker. The GitHub Tasks and Workflows features need `gh`; Skills and Sync's Skillshare features need the `skillshare` CLI.

To use the **Sync** mod afterward, open its tab-bar button, expand **Settings**, and set:

- **Config repo** to this clone's path on the current machine.
- **Sync script** to `./sync.sh` (the default).
- **Agent for conflicts** to an installed agent.

Sync then uses the same script for Pull and Push. Its down badge means incoming commits; its up badge means changed files or commits to push. The panel also exposes target, source, machine and conflict controls.

## `sync.sh` reference

```sh
./sync.sh             # two-way: the newer copy of each file wins
./sync.sh --push      # repo -> Herdr only; the repo wins
./sync.sh --pull      # Herdr -> repo only; Herdr wins
./sync.sh --dry-run   # show changes and write nothing; combine with --push or --pull
./sync.sh --check     # write nothing; fail on stale Tony copies or absolute home paths
```

| Repository source | Herdr destination (`~/.config/herdr-app`) |
| --- | --- |
| `herdr/<entry>/mods/<mod>/`, except Tony | `mods/<mod>/` |
| `herdr/tony/mods/tabs-icons/` | `mods/tabs-icons/` |
| `herdr/tony/layouts/Tony.json` | `layouts/Tony.json` |
| Theme files stored under `personal/`; only files already in the repo | `themes/` |
| Workflow files stored under `personal/` | `workflows/` |

Set `HERDR_APP_HOME` to use a different Herdr config folder. A pull returns each mod to its owning entry folder, never to Tony's duplicate (except `tabs-icons`). Herdr's built-in mods and generated files are not pulled. For ordinary synced files, nothing is deleted: removing one side's copy brings it back on the next run, so delete it on both sides. Every replaced file is backed up under `~/.config/herdr-app/.workstation-backup/<timestamp>/` or the repo's `.sync-backup/<timestamp>/`.

**Tony's copies.** Every synchronization run except `--dry-run` (and not the standalone `--check`) makes each `herdr/tony/mods/<mod>/` an exact copy of its owning entry: files are added, changed and removed, and unowned copies other than `tabs-icons` are removed. These generated copies are not backed up because Git tracks them. `./sync.sh --check` names every missing, extra or changed copy.

**Skillshare.** The script links `~/.config/skillshare/config.yaml`, `agents` and `skills` to `skillshare/` in this repo. An existing real file/folder is first moved to `<name>.backup-<timestamp>`; an existing wrong link is repointed. Set `SKILLSHARE_HOME` to use a different Skillshare folder.

**Home paths stay private.** `skillshare/config.yaml` sets `preserve_tilde_on_save: true`, and each real run rewrites `$HOME/` to `~/` there. `--check` fails if a macOS or Linux absolute home path remains. Commit after a pull or two-way run: pulled files and refreshed Tony copies are repository edits.
