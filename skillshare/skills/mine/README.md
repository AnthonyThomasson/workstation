# mine

Your own skills live here. To add one, create a folder with a `SKILL.md` in it:

```
mine/my-skill/SKILL.md
```

## What is committed

Only `skills/mine/` (this folder) and `skills/.metadata.json` are tracked by git. The repo's `.gitignore` ignores every other top-level folder under `skillshare/skills/` (`skillshare/skills/*/` except `mine/`), so a skill that Skillshare installs, and `synced/` (skills synced from claude.ai), are never committed by accident. An installed skill lives at the top level of `skills/` and is recorded only in `.metadata.json`, which keeps its source and commit; `mods/sync/sync.sh` reinstalls the recorded ones that are missing (see the Sync script section of `mods/sync/RECIPE.md`). Keep your own work in `mine/` so it is never mixed up with them, and add each skill to the "My skills" list below so it can be installed by URL.

`add-own-skill/` is a real skill, not a sample: Skillshare's doctor warns "Skills: 1 without SKILL.md" about a top-level folder with no skill in it, and there is no ignore setting that silences that check. Keep it until `mine/` holds a skill of your own.

## My skills

Each skill in `skillshare/skills/mine/` installs by URL (add `-g` for the global source):

| Skill | What it does | Install |
| --- | --- | --- |
| `add-own-skill` | Add a personal skill to this workstation's Skillshare source. | `skillshare install github.com/AnthonyThomasson/workstation/skillshare/skills/mine/add-own-skill` |

When you add a skill to `mine/`, add a row here with its one-line description and its install command (`skillshare install github.com/AnthonyThomasson/workstation/skillshare/skills/mine/<name>`). The `add-own-skill` skill does this as one of its steps.
