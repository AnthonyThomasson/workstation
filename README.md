# workstation

My [Herdr](https://herdr.dev) setup: the **Tony** layout, the mods it uses, my keybindings and my Skillshare skills.

## Layout of this repo

- `herdr/` one folder per Herdr gallery entry. Each holds `mods/<mod>/` and nothing personal.
  - `herdr/usage/` the `usage` mod
  - `herdr/status-bar/` the `status-bar` mod
  - `herdr/skills/` the `skills` mod (a modified copy of the MIT-licensed `skillshare` mod from [runkids/skillshare](https://github.com/runkids/skillshare); see its `LICENSE`)
  - `herdr/github-workflows/` the `github-tasks` and `workflows` mods, plus starter workflows `workflows/bug.yaml` and `workflows/story.yaml`
  - `herdr/sync/` the `sync` mod: a button in the tab bar that shows how far Herdr and the repo are apart, with Pull and Push (see its README)
  - `herdr/tony/` the Tony layout (`layouts/Tony.json`) with real copies of every custom mod it uses in `mods/`, including `tabs-icons`, which lives only here. The other copies are made from the entry folders above; edit those, not Tony's copies.
- `personal/herdr-app/` my own files: `keys.json`, `settings.json`, `themes/` and `workflows/`
- `skillshare/` Skillshare config and skills: `config.yaml`, `agents/`, and `skills/` (installed skills at the top level, tracked in `.metadata.json`; my own in `skills/mine/`)
- `sync.sh` copies the mods, layout, themes and workflows between this repo and Herdr's config folder (`~/.config/herdr-app`), refreshes Tony's copies, and links Skillshare's config into this repo (see below)
- `tests/sync.test.sh` tests `sync.sh` against scratch folders: `sh tests/sync.test.sh`

## Install the Tony layout

The layout needs the mods it references. `sync.sh` keeps the repo and `~/.config/herdr-app` in step:

```sh
git clone https://github.com/AnthonyThomasson/workstation.git
cd workstation
./sync.sh --dry-run   # preview
./sync.sh
```

Any file it replaces is first saved in a backup folder. Herdr picks up changed layouts and mods without a restart; then pick **Tony** in the layout picker.

Tony also uses Herdr's built-in `spaces`, `agents`, `changes`, `files`, `pane` and `workspace-chrome` mods.
The `github-tasks`, `skills` and `workflows` mods expect the `gh` and `skillshare` CLIs to be installed.

## What `sync.sh` does

```sh
./sync.sh             # two-way: the newer copy of each file wins
./sync.sh --push      # repo -> Herdr only
./sync.sh --pull      # Herdr -> repo only
./sync.sh --dry-run   # show what would change, write nothing (combine with --push or --pull)
./sync.sh --check     # write nothing; exit 1 and name each file that is out of step
```

| Repo | Herdr (`~/.config/herdr-app`) |
| --- | --- |
| `herdr/<entry>/mods/<mod>/` (every entry except `tony`) | `mods/<mod>/` |
| `herdr/tony/mods/tabs-icons/` | `mods/tabs-icons/` |
| `herdr/tony/layouts/Tony.json` | `layouts/Tony.json` |
| `personal/herdr-app/themes/*` | `themes/` |
| `personal/herdr-app/workflows/*` | `workflows/` |

`keys.json` and `settings.json` are not synced, because Herdr writes to them. A pull always goes back to the entry folder that owns the mod. Nothing is deleted: a file you remove on one side comes back from the other, so delete it on both. Overwritten files are saved first, in `~/.config/herdr-app/.workstation-backup/<timestamp>/` (Herdr's copy) or `.sync-backup/<timestamp>/` (the repo's). Set `HERDR_APP_HOME` to use a config folder other than `~/.config/herdr-app`.

**Tony's copies.** After the sync, every run (not `--dry-run`) makes `herdr/tony/mods/<mod>/` an exact copy of the mod in its entry folder: files are added, overwritten and removed to match. Edit the entry folder, never Tony's copy. `./sync.sh --check` fails and names each Tony file that is missing, extra or changed, so it can run before a commit.

**Skillshare.** `sync.sh` links `~/.config/skillshare/config.yaml`, `agents` and `skills` to `skillshare/` in this repo. A real file or folder in the way is moved to `<name>.backup-<timestamp>`; a link that is already right is left alone. Set `SKILLSHARE_HOME` to use a folder other than `~/.config/skillshare`.

**No usernames in the repo.** Skillshare normally saves absolute paths, which would put your home folder, with your username in it, into `skillshare/config.yaml`. The config sets `preserve_tilde_on_save: true`, so Skillshare keeps `~/` paths when it saves. Paths it already had stay absolute, so `sync.sh` also rewrites `$HOME/` to `~/` in that file on every real run, and `--check` fails if an absolute home path (a macOS or Linux home folder) is left.
