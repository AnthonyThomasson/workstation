# sync

Keeps Herdr's config folder (`~/.config/herdr-app`) in step with your clone of this repo, from one icon in the tab bar. It is one way (the repo wins) and automatic: there are no settings and nothing to push.

## Setup

Run the script from your clone. That installs everything and links the clone to the mod:

```sh
./mods/sync/sync.sh
```

Herdr has to have been started once. Every real run writes `~/.config/herdr-app/sync.json` (`$HERDR_APP_HOME` if set) with the clone's folder and its `origin` URL: `{"repo": "/path/to/clone", "remote": "git@…"}`. The last clone to run the script is the linked one. The mod reads only this computer's `sync.json`, so on another machine you run the script from that machine's clone.

## The icon and the panel

The tab-bar icon is a circular arrow: dim with no repo linked, muted normally, red when the last sync failed, spinning while it syncs. Click it to open the panel in Tony's right-hand column:

```
> Branch main                 [Force sync]
  ~/projects/workstation
  origin: git@github.com:you/workstation.git
  Synced 12s ago · watching for changes
```

With no `sync.json`, or when the folder it names is gone, the panel is one line, "No repo linked. Run mods/sync/sync.sh from your clone.", and nothing syncs.

- **Branch row**: the branch and folder being synced. Expand it to pick another worktree of the repo, or to switch the folder to another local branch (a branch checked out in another worktree is greyed out). It lists the 5 most recently checked-out worktrees (newest entry in each one's HEAD reflog first) and the 5 most recently checked-out local branches (by checkout order in the reflogs); the search box above them filters all worktrees (by branch or folder name) and all local branches as you type. Picking either syncs that checkout. The picked worktree is remembered and forgotten when the linked repo changes.
- **Force sync**: syncs the picked folder right away. Pressed during a sync, it runs one more sync straight after it, never two at once.
- **Origin**: the remote from `sync.json`, for information.

## When it syncs

A sync runs the picked folder's own `mods/sync/sync.sh` (repo to Herdr, files in repo-owned mod folders that the repo no longer has are removed, no backups), then asks the running Herdr whether it loaded the result: `herdr-app check` for each mod and `herdr-app status` must list no errors.

A watcher on the picked folder starts a sync once nothing has changed for 3 seconds, so a checkout, a save-all or a rebase is one sync. It ignores `.git/` and anything git ignores, and a change that leaves the files' content as it was does not count (the folder is compared with how it was just before the last sync). A sync's own writes into the repo (it rewrites `skillshare/config.yaml`, and Skillshare reinstalls into `skillshare/skills/`) do not start another sync; `skillshare/` is not copied to Herdr, so edits there sync only on Force sync. If you edit a file while a sync is running, one more sync follows it. Switching branch from the panel is one sync.

Running the script from a worktree of the linked repo rewrites `sync.json` to that worktree; the mod keeps the repo it already had, and your picked worktree, as long as `sync.json` names that repo or one of its worktrees. Running it from a different clone links that clone.

The mod never fetches, pulls, pushes or commits. Edits made on the Herdr side are overwritten without a backup.

## Files

- `sync.sh` the script (`sync.test.sh` is its test); `RECIPE.md` has its contract
- `model.js` pure logic: `sync.json`, what the scripts print, what the panel shows
- `queue.js` pure logic: when to sync (the 3 s quiet period, follow-ups, Force sync)
- `targets.js` pure logic: how the picker orders worktrees and branches and what a search keeps
- `ops.js` the shell scripts the mod runs (link, sync, snapshot, ignore check, list, switch) and the functions that run them
- `channel.js` how the panel hands work to the button; `jobs.js` runs the sync as a detached, polled job
- `details.js` the panel frame; `repo-ui.js` the panel content; `picker-ui.js` the branch / worktree list and its search box; `ui.js` the shared look
- `main.js` the views: the button (link, watcher, syncs) and the Details panel
- `*.test.js` run with `node --test mods/sync` (`ops.test.js` uses throwaway git repositories from `scratch-repos.js`, the real `sync.sh` and a stub `herdr-app`)
