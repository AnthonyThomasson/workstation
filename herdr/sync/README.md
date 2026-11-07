# sync

Keeps Herdr's config folder (`~/.config/herdr-app`) and your config repo in step, from one icon in the tab bar. It works with any config repo: nothing about a particular repo is written into the mod.

The button is a plain circular-arrow icon (dimmed until a repo is set, spinning while sync works, red on a conflict or an error). When something is waiting, small yellow counts sit at its top-right corner:

- `↓N` commits the repo is behind its remote
- `↑M` files changed in Herdr's config that are not in the repo yet (the files the sync script's two-way dry run would copy to the repo), plus anything uncommitted in the repo (skills included)

No counts mean both are zero. The button follows the shown space's machine and uses that machine's settings.

## The panel

Click the icon: it opens or closes the Sync panel in Tony's right-hand panel column, like the Skills, GitHub tasks and Workflows icons beside it (opening also fetches). The panel has these sections, top to bottom: Repo, Targets, Source (only for a source that is its own repo), Machines, Conflicts and Settings (collapsed).

### Repo

The branch line, then:

| Row | Button | What it does |
| --- | --- | --- |
| Behind by N commits, or N repo files newer than Herdr (expands to list them) | **Pull** | `git pull --rebase` (only when behind; if an uncommitted edit clashes with the pulled commits the pull is undone and the repo is left as it was), then the sync script with `--push` (the repo wins; the script backs up any Herdr file it overwrites), then `skillshare sync --all -g` if skillshare is installed. |
| N files changed in Herdr (expands to list the files, with an editable commit message and "N commits not pushed") | **Push** | Refused ("Pull first: the repo has newer files than Herdr") while the sync script's two-way dry run would copy any file to Herdr, because the copy would revert those repo files. Otherwise: the sync script with `--pull`, commit everything, `git pull --rebase`, push to the branch's upstream. If the rebase brought in remote commits, the sync script runs with `--push` afterwards so Herdr matches. |
| Skillshare: N need sync | **Sync targets** | `skillshare sync --all` and `skillshare sync plugins`, for global and project scope. |

## The other sections

- **Targets**: what skillshare's targets still need (items "missing" or changed since the last sync, native hook files, hook plan notices), with a per-item **Diff** and **Sync targets**.
- **Source**: the skillshare source folder comes from `skillshare status --json -g`. When it lies inside the config repo, the section is one line saying Push and Pull under Repo cover it. When it is its own git repo, the section shows the repo path and remote, uncommitted / to push / to pull tags, the changed files, and the guidance "Pull blocked while uncommitted changes" and "Push rejected, origin has newer commits". Actions: a commit message (generated, editable), **Commit and push**, **Pull**, and **Both ways** (`skillshare push --pull`, which commits, pulls, pushes and links the targets). After a pull the targets are linked again.
- **Machines**: a card for this computer and each Herdr machine: skillshare version (an "update" pill, or "skillshare not found"), the source's git state, target count, "Needs sync" count, doctor errors and warnings, "Checked N ago". The cards refresh every 60 seconds while the panel is shown. **Pull and sync** pulls that machine's own source repo, or else its config repo, or else just links the targets. **Update to <version>** asks first, then runs `skillshare upgrade --cli --force` there.
- **Conflicts**: see below.

`git fetch` runs every 5 minutes and whenever the panel opens. The local check, the sync script's two-way `--dry-run` plus `git status`, runs every 20 seconds. Files the dry run would copy to the repo are Herdr changes (↑); files it would copy to Herdr are "repo newer than Herdr" (a `git pull` in a terminal, an agent's commit, an edit made in the repo): they don't count toward ↑ and they block Push until Pull has applied them.

## Conflicts

When a push's rebase, or its copy of Herdr's files, meets a conflict, sync undoes the half-done rebase and pushes nothing. It opens the conflict agent in a new tab in the repo folder with a brief naming each conflicting file and what each side changed. The button and panel show "Conflict, resolving" until the repo is clean: no rebase or merge in progress, no unmerged files, and the remote's commits contained in the repo.

### Choosing a side

A pull of the skillshare source, and a repo Pull or Push that hit a conflict, stop with nothing changed. The Conflicts section shows both sides of each conflicting file (the lines the other side lacks are marked) and a **Keep this** button per side, plus **Keep all local** and **Keep all remote**. `.metadata.json` is merged entry by entry without asking: an entry changed on one side takes that side; changed on both, the later `installed_at` wins and an edit beats a delete. **Apply choices** replays the merge, takes the chosen side of each file and commits it; then the targets are linked again (source), or the sync script runs with `--push` and, for a stopped Push, the merge is pushed (repo). Before applying, sync fetches again: if the remote moved since you looked, or other files conflict now, nothing is applied and you are asked again. **Hand it to the agent** opens the conflict agent instead, with a brief naming each file.

A copy conflict means Herdr's copy of a file would overwrite an uncommitted edit in the repo. The repo's edit is put back and Herdr's version is saved under `.sync-backup/conflict-<time>/herdr/` in the repo. Herdr's other files were copied into the repo but not committed. Sync never commits or lists `.sync-backup/` (it leaves the repo's own ignore files alone).

## Settings

Per machine: this computer, and each machine from `hc machine ls`. The Settings section of the panel edits the machine the shown space is on. With no repo path yet it is the only section, shown open; once a repo is set it is last and collapsed. They are stored with Herdr's persisted shared values.

| Setting | Default |
| --- | --- |
| Config repo (folder path on that machine; this computer has a Browse button) | empty; the panel shows only Settings |
| Sync script: a path, relative to the repo (`sync.sh` and `./sync.sh` are the same), absolute or `~/…`; spaces are fine, arguments are not | `./sync.sh` (a saved `./mount.sh` or `mount.sh`, the old name, counts as the default) |
| Agent for conflicts (an installed agent from Herdr's list) | Claude Code |

The sync script must take `--push` (repo to Herdr), `--pull` (Herdr to repo) and `--dry-run`, and, with `--dry-run` alone, print `to repo: <path>` or `to repo (new): <path>` for each file it would copy to the repo and `to Herdr: <path>` or `to Herdr (new): <path>` for each file it would copy to Herdr. This repo's `sync.sh` does.

## Files

- `model.js` pure logic: settings, parsing what the scripts print, the badge, the conflict brief
- `ops.js` the check, pull and push shell scripts and the functions that run them
- `channel.js` how the panel and dialogs hand work to the button (shared values, one lock per machine)
- `details.js` the panel frame and its sections
- `repo-ui.js` the Repo section (Pull, Push, skillshare sync); `settings-ui.js` the Settings section
- `targets.js`, `targets-ops.js`, `targets-ui.js` the Targets section: reading skillshare, sync and diff
- `source.js`, `source-ui.js` the skillshare source's own git repo: state, pull, push, both ways
- `conflicts.js`, `conflicts-ui.js` choosing a side per file on a stopped pull; the per-entry `.metadata.json` merge
- `machines.js`, `machines-ui.js` the Machines cards, "Pull and sync" and the CLI upgrade
- `ui.js` the shared look
- `main.js` the views: the button (icon), the Details panel, and the text, upgrade and srcboth dialogs
- `*.test.js` run with `node --test herdr/sync/mods/sync` (`ops.test.js`, `conflicts.test.js` and `source.test.js` use throwaway git repositories, `scratch-repos.js` builds them; `ops.test.js` also runs this repo's `sync.sh`). The real skillshare CLI is never run by the tests.
