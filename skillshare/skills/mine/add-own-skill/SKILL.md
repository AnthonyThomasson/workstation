---
name: add-own-skill
description: "Add a personal skill to this workstation's Skillshare source. Use only when the user asks to create or add a skill of their own."
---

# Add your own skill

Personal skills live in `skillshare/skills/mine/` in the workstation repo (`~/.config/skillshare/skills/mine/` once mounted), one folder per skill, kept apart from skills Skillshare installs at the top level of `skills/`.

1. Create `mine/<skill-name>/SKILL.md` with `name` and `description` front matter, then the instructions.
2. Add it to the "My skills" table in the workstation README (`### My skills`): its name, its one-line description, and its install command, `skillshare install github.com/AnthonyThomasson/workstation/skillshare/skills/mine/<skill-name>`.
3. Run `skillshare sync` to link it into every target.
4. Run `skillshare doctor -g` to confirm it is clean.

Only `mine/` and `.metadata.json` are committed under `skillshare/skills/`; every other top-level folder there is gitignored. Never create a skill outside `mine/`.

This skill also keeps `mine/` from being an empty folder: Skillshare's doctor warns "without SKILL.md" about a top-level folder that holds no skill. Do not delete it unless `mine/` holds another skill.
