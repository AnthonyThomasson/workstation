# workstation

My [Herdr](https://herdr.dev) setup: the **Tony** layout, the mods it uses, my keybindings and my Skillshare skills.

## Layout of this repo

- `herdr/` one folder per Herdr gallery entry. Each holds `mods/<mod>/` and nothing personal.
  - `herdr/usage/` the `usage` mod
  - `herdr/status-bar/` the `status-bar` mod
  - `herdr/skills/` the `skills` mod (a modified copy of the MIT-licensed `skillshare` mod from [runkids/skillshare](https://github.com/runkids/skillshare); see its `LICENSE`)
  - `herdr/github-workflows/` the `github-tasks` and `workflows` mods, plus starter workflows `workflows/bug.yaml` and `workflows/story.yaml`
  - `herdr/sync/` placeholder for the sync mod
  - `herdr/tony/` the Tony layout (`layouts/Tony.json`) with real copies of every custom mod it uses in `mods/`, including `tabs-icons`, which lives only here. The other copies are made from the entry folders above; edit those, not Tony's copies.
- `personal/herdr-app/` my own files: `keys.json`, `settings.json`, `themes/` and `workflows/`
- `skillshare/` Skillshare config and skills: `config.yaml`, `agents/`, and `skills/` (installed skills at the top level, tracked in `.metadata.json`; my own in `skills/mine/`)
- `mount.sh` copies the mods, layout, themes and workflows between this repo and Herdr's config folder (`~/.config/herdr-app`)

## Install the Tony layout

The layout needs the mods it references. `mount.sh` keeps the repo and `~/.config/herdr-app` in step:

```sh
git clone https://github.com/AnthonyThomasson/workstation.git
cd workstation
./mount.sh --dry-run   # preview
./mount.sh
```

Any file it replaces is first saved in a backup folder. Herdr picks up changed layouts and mods without a restart; then pick **Tony** in the layout picker.

Tony also uses Herdr's built-in `spaces`, `agents`, `changes`, `files`, `pane` and `workspace-chrome` mods.
The `github-tasks`, `skills` and `workflows` mods expect the `gh` and `skillshare` CLIs to be installed.
