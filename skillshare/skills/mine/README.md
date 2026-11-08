# mine

Your own skills live here. To add one, create a folder with a `SKILL.md` in it:

```
mine/my-skill/SKILL.md
```

## What is committed

Only `skills/mine/` (this folder) and `skills/.metadata.json` are tracked by git. The repo's `.gitignore` ignores every other top-level folder under `skillshare/skills/` (`skillshare/skills/*/` except `mine/`), so a skill that Skillshare installs, and `synced/` (skills synced from claude.ai), are never committed by accident. An installed skill lives at the top level of `skills/` and is recorded only in `.metadata.json`, which keeps its source and commit; `scripts/sync/sync.sh` reinstalls the recorded ones that are missing (see the README's Skillshare skills section). Keep your own work in `mine/` so it is never mixed up with them, and add each skill to the README's "My skills" list so it can be installed by URL.

`add-own-skill/` is a real skill, not a sample: Skillshare's doctor warns "Skills: 1 without SKILL.md" about a top-level folder with no skill in it, and there is no ignore setting that silences that check. Keep it until `mine/` holds a skill of your own.
