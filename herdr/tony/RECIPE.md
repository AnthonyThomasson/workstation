# Tony

Tony is a full Herdr window layout with a 268px navigation sidebar, icon-rich draggable tabs, framed terminal panes, a shared right-hand tool panel and a compact status bar. It combines Herdr's built-in workspace mods with Usage, Sync, Skills, GitHub Tasks, Workflows and Status Bar; its custom `tabs-icons` mod is included only in this entry.

![Tony](preview.png)

## What you see

- The window has no system title bar. On macOS, traffic lights sit at `[12, 16]`. The root uses `theme().canvas`, 1px `theme().border` dividers, and terminal padding of 14px vertically and 12px horizontally. Tony sets no theme or fonts, so the person's settings and theme choices supply them.
- At left, a fixed, non-drag-resizable `theme().chrome` sidebar is 268px wide, with a 44px minimum and 480px maximum. A 46px **workspace-chrome** brand/window-drag strip sits on top. Below it, built-in **Spaces** and **Agents** share the flexible height equally, each with a 90px minimum. A fixed 100px **Usage** block sits beneath them, followed by a 69px **workspace-chrome** footer (`footer: true`).
- The work area starts with a 42px tab row. `tabs-icons` fills the flexible width; separate 42px blocks at the right hold the Sync, GitHub Tasks, Skills and Workflows toggle buttons.
- The tab row's `theme().chrome` background has a bottom border and 10px horizontal padding. Tabs are nonstretching 29px-high pills with 10px horizontal padding, 7px internal gaps, 7px corners, 12.8px text and 3px between tabs. The active pill has a `theme().raised` fill, `theme().border` outline and foreground text; inactive pills use chrome fill, chrome outline and muted text. All gain `theme().hover` on hover.
- A tab can show its 14px program icon, a name truncated to 170px, and ` Z` when zoomed. Working agents add a 12px spinner; blocked and done agents add a 6px status dot. The active tab has a 12px close icon. A right-aligned **+**, optional Files and Changes buttons, and platform window controls follow the scrolling tab list.
- The main work body has 8px padding and an 8px gap. The active tab's terminal panes always have frames, even when alone: 10px corners, `theme().background`, a 1px border, an accent focus border, 8px between panes, and an always-visible 30px built-in **pane** header at the top.
- A right-hand panel column is initially hidden. When opened it is 368px wide, with 280px minimum and 900px maximum, and one visible card selected from built-in **Files**, built-in **Changes**, **Skills**, **GitHub Tasks**, **Workflows** and **Sync**. A 28px **Status Bar** spans the bottom of the work area.

## How it behaves

- Built-in Spaces, Agents, Files, Changes, pane headers and workspace chrome retain Herdr's shipped behavior. Custom Usage, Status Bar, Skills, GitHub Tasks, Workflows and Sync behavior is defined by their own entry recipes; Tony supplies their layout positions and props rather than reimplementing them.
- `tabs-icons` chooses a tab's first agent program icon, falling back to its first pane's program. A generated name matching `tb<number>` displays that program's name (or `Terminal`); a manually assigned tab name stays unchanged. Working status spins once every 900ms using `theme().working`; blocked and done dots use their matching theme colors; idle and unreported statuses add no status marker.
- Click a tab to select it. Double-click its label to run `tab.rename`. Press one tab and release over another to move it to that position. Right-click opens the built-in `menu` popup for that tab and space. Vertical wheel scrolling over the tab row runs `tab.prev` or `tab.next`. The active tab's close icon runs `tab.close` without also selecting the tab.
- **+** opens the built-in `new-menu` popup at 250×512. Files and Changes buttons appear when listed in shared `workspace.panels` (default `['files', 'changes']`). Each selects its child in `panel-body` and shows `panel`, or hides the panel if already selected. The Sync, Tasks, Skills and Workflows buttons select their own panel children in the same stack.
- `tabs-icons` remembers the selected open side panel per space in its own `localStorage` under `panels`. Switching spaces restores that space's enabled panel, or closes it; a panel outside `workspace.panels` is not restored. A one-second pending window prevents the restore from being saved over before it lands.
- Where Herdr reports native window buttons, the row adds minimize, maximize/restore and close controls. Windows uses the included vector art; other platforms use text symbols and the built-in pane close asset. On macOS with the title bar hidden and not fullscreen, left padding grows to keep tabs clear of the configured traffic lights, including when the sidebar is hidden or narrow.

## Built from

### Layout tree

Copy `layouts/Tony.json` and every folder under `mods/`. The JSON records `cloned_from: { "name": "main", "version": "0.1.12" }` and has this exact structure:

```text
root (row; titlebar none, traffic_lights [12,16], canvas, terminal padding [14,12])
├─ sidebar (column, 268px, min 44, max 480, chrome, resizable false)
│  ├─ brand (46px, window_drag; mod workspace-chrome)
│  ├─ sidebar-lists (column)
│  │  ├─ spaces (weight 1, min 90; built-in spaces)
│  │  ├─ agents (weight 1, min 90; built-in agents)
│  │  └─ usage (100px, min 90; mod usage)
│  └─ sidebar-footer (69px; mod workspace-chrome, props {footer:true})
└─ work (column, resizable false)
   ├─ tabs-row (row, 42px, resizable false)
   │  ├─ tabs (weight 1, window_drag; mod tabs-icons)
   │  ├─ sync-toggle (42px; mod sync, props {role:"button"})
   │  ├─ github-tasks-toggle (42px; mod github-tasks, props {role:"toggle"})
   │  ├─ skills-toggle (42px; mod skills, props {role:"toggle"})
   │  └─ workflows-toggle (42px; mod workflows, props {role:"toggle"})
   ├─ work-body (row, padding 8, gap 8)
   │  ├─ main (active tab; pane frames and built-in pane header described above)
   │  └─ panel (column, hidden, 368px, min 280, max 900)
   │     └─ panel-body (stack, initially files)
   │        ├─ files (built-in files)
   │        ├─ changes (built-in changes)
   │        ├─ skills (mod skills)
   │        ├─ github-tasks (mod github-tasks)
   │        ├─ workflows (mod workflows)
   │        └─ sync (mod sync, props {role:"details"})
   └─ status (28px; mod status-bar)
```

The built-in mods Tony uses are **`spaces`, `agents`, `changes`, `files`, `pane`, and `workspace-chrome`**. It also invokes built-in `menu` and `new-menu` from the tab bar.

### Custom mods from their own entries

- `mods/usage/` comes from [`herdr/usage/`](../usage/); it fills the 100px sidebar Usage block.
- `mods/status-bar/` comes from [`herdr/status-bar/`](../status-bar/); it fills the 28px bottom status block.
- `mods/skills/` comes from [`herdr/skills/`](../skills/); Tony mounts its `toggle` and default panel roles.
- `mods/github-tasks/` and `mods/workflows/` come together from [`herdr/github-workflows/`](../github-workflows/); Tony mounts both toggles and both default panels. That entry also supplies optional Bug and Story starter workflows.
- `mods/sync/` comes from [`herdr/sync/`](../sync/); Tony mounts its always-running `button` role and its `details` panel. Its repository path, sync script and conflict agent are configured per machine in the panel.
- These folders in Tony are real copies so the layout is self-contained. In the workstation repository, `sync.sh` refreshes them from the entry folders above; edit the owning entry rather than Tony's copy.

### `tabs-icons` (included only here)

`mods/tabs-icons/mod.json` is:

```json
{
  "place": "none",
  "title": "Tabs",
  "cloned_from": { "name": "tabs", "version": "0.1.13" }
}
```

It is derived from Herdr's built-in **`tabs`** mod, licensed **Apache-2.0**. `main.js` is a `gpui-kit` `View` built with `div`, `h_flex`, `svg` and `image`. It uses Herdr's `spaces`, `panes`, `run`, `openOverlay`, `theme`, `window`, `shared`, `layout`, `settings` and per-copy `localStorage`. Commands are `tab.rename`, `tab.move`, `tab.select`, `tab.close`, `tab.prev`, `tab.next`, `layout.select`, `layout.show`, `layout.hide`, `window.minimize`, `window.maximize` and `window.close`.

Its own art is `win-min.svg`, `win-max.svg`, `win-restore.svg` and `win-close.svg`. It also references shipped assets `mods/workspace-chrome/spinner.svg`, `mods/pane/close.svg`, `mods/files/file.svg` and `mods/changes/changes.svg`. The horizontal tab list uses `overflow_x_scrollbar`; mouse-down stops propagation so pills and controls do not start a window drag.

No `keys.json` belongs to this entry: it supplies no layout-specific or mod-specific key bindings.

## Watch out

- Install all seven custom mod folders and the six listed built-ins must be available. `tabs-icons` additionally needs built-in `menu`, `new-menu` and the shipped icon assets named above. A missing custom panel leaves a toggle without its intended content.
- The panel toggles and per-space memory depend on the exact ids `panel` and `panel-body`, and child ids `files`, `changes`, `skills`, `github-tasks`, `workflows` and `sync`. Changing them requires changing the custom mods too.
- The layout itself and `tabs-icons` run no external programs, read no files outside Herdr's mod state and make no network requests. The other custom mods do: Usage contacts Kimi on explicit refresh, Skills and GitHub Workflows run their CLIs and agents, and Sync runs Git, Skillshare and the configured sync script. Read their recipes before enabling those actions.
- Tony deliberately leaves theme and font choices unset. Do not add hard-coded colors where the source uses theme tokens. The preview image is the supplied portrait, not an additional layout asset; it is not copied into `~/.config/herdr-app` during installation.
- The sidebar's own `resizable: false` does not remove Herdr commands that hide or resize it. `tabs-icons` compensates for the traffic lights from the current layout and sidebar width.
- Renaming `tabs-icons` requires changing the layout reference and its four `mods/tabs-icons/win-*.svg` paths. Renaming any other custom mod also requires its own asset/self-overlay changes described in its entry.

## Done when

- `herdr-app check` passes for `mods/tabs-icons`, `mods/usage`, `mods/status-bar`, `mods/skills`, `mods/github-tasks`, `mods/workflows` and `mods/sync`; then `layout.switch` to `Tony` succeeds without layout or mod errors.
- The window matches the tree and dimensions above, follows the selected theme/fonts, shows the six built-in mod roles, and frames even a lone terminal pane with its 30px header and focus border.
- Tabs show the correct program/name and working, blocked, done and idle treatments; select, double-click rename, drag reorder, right-click menu, wheel navigation, close and + all work. Window controls and macOS traffic-light spacing remain usable.
- Files/Changes visibility follows `workspace.panels`; every custom toggle opens its matching right panel; switching spaces restores only that space's remembered enabled panel.
- Usage and Status Bar render in their assigned blocks. Skills, Tasks, Workflows and Sync pass their own recipes' checks, including Sync's always-mounted button and Settings flow. No extra key bindings are required.
