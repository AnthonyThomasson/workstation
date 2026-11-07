# workstation

My [Herdr](https://herdr.dev) setup: the **Tony** layout, the mods it uses, and my keybindings.

![Tony layout](herdr-app/layouts/Tony.png)

## Install the Tony layout

The layout needs the mods it references, so copy both into your Herdr config folder (`~/.config/herdr-app`):

```sh
git clone https://github.com/AnthonyThomasson/workstation.git
cd workstation
cp herdr-app/layouts/Tony.json herdr-app/layouts/Tony.png ~/.config/herdr-app/layouts/
cp -R herdr-app/mods/{github-tasks,skillshare,status-bar,tabs-icons,usage,workflows} ~/.config/herdr-app/mods/
```

Restart Herdr, then pick **Tony** in the layout picker.

Tony also uses Herdr's built-in `spaces`, `agents`, `changes`, `files`, `pane` and `workspace-chrome` mods.
The `github-tasks`, `skillshare` and `workflows` mods expect the `gh` and `skillshare` CLIs to be installed.

## Contents

- `herdr-app/layouts/` the Tony layout
- `herdr-app/mods/` custom mods
- `herdr-app/keys.json`, `settings.json` keybindings and settings (optional)
- `skillshare/` Skillshare config and skills
