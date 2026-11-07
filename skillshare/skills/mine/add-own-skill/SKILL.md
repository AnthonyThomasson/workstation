---
name: add-own-skill
description: "Add a personal skill to this workstation's Skillshare source. Use only when the user asks to create or add a skill of their own."
---

# Add your own skill

Personal skills live in `skillshare/skills/mine/` in the workstation repo (`~/.config/skillshare/skills/mine/` once mounted), one folder per skill, kept apart from skills Skillshare installs at the top level of `skills/`.

1. Create `mine/<skill-name>/SKILL.md` with `name` and `description` front matter, then the instructions.
2. Run `skillshare sync` to link it into every target.
3. Run `skillshare doctor -g` to confirm it is clean.

This skill also keeps `mine/` from being an empty folder: Skillshare's doctor warns "without SKILL.md" about a top-level folder that holds no skill. Do not delete it unless `mine/` holds another skill.
