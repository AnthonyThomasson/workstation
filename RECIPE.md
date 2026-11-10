# Tony

Tony is a full Herdr window layout with a 268px navigation sidebar, icon-rich draggable tabs, framed terminal panes, a shared right-hand tool panel and a compact status bar. It combines Herdr's built-in workspace mods with Usage, Sync, Skills, GitHub Tasks (which includes workflow and refactor type editing and run pages), Status Bar and Tabs Icons, each kept in its own folder under `mods/`.

![Tony](preview.png)

## What you see

- The window has no system title bar. On macOS, traffic lights sit at `[12, 16]`. The root uses `theme().canvas`, 1px `theme().border` dividers, and terminal padding of 14px vertically and 12px horizontally. Tony sets no theme or fonts, so the person's settings and theme choices supply them.
- At left, a drag-resizable `theme().chrome` sidebar starts at 268px wide, with a 44px minimum and 480px maximum. Its `resizable: false` covers only the boundaries between its own children; the sidebar/work boundary belongs to the root row, which keeps the default `resizable: true`. A 46px **workspace-chrome** brand/window-drag strip sits on top. Below it, built-in **Spaces**, **GitHub Tasks** and built-in **Agents** share the flexible height equally, each with a 90px minimum. A fixed 100px **Usage** block sits beneath them, followed by a 69px **workspace-chrome** footer (`footer: true`).
- The work area starts with a 42px tab row. [`tabs-icons`](mods/tabs-icons/RECIPE.md) fills the flexible width and receives no props; separate 42px blocks at the right hold the Sync and Skills toggle buttons. GitHub Tasks has no toggle.
- The main work body has 8px padding and an 8px gap. The active tab's terminal panes always have frames, even when alone: 10px corners, `theme().background`, a 1px border, an accent focus border, 8px between panes, and an always-visible 30px built-in **pane** header at the top.
- A right-hand panel column is initially hidden. When opened it is 368px wide, with 280px minimum and 900px maximum, and one visible card selected from built-in **Files**, built-in **Changes**, **Skills**, **Task settings** and **Sync**. The Tasks ticket list itself stays in the left sidebar, and **Task settings** opens only from the gear in the Tasks sidebar. A 28px **Status Bar** spans the bottom of the work area.

## How it behaves

- Built-in Spaces, Agents, Files, Changes, pane headers and workspace chrome retain Herdr's shipped behavior. Custom Usage, Status Bar, Skills, GitHub Tasks (including workflows), Sync and Tabs Icons behavior is defined by their own recipes; Tony supplies their layout positions and props rather than reimplementing them.
- The separate Sync and Skills toggles select their own child in `panel-body` and show `panel`, or hide it if already selected. Tasks has no toggle: **Task settings** opens only from the gear in the Tasks sidebar, and GitHub Tasks itself handles workflow editing and run pages.

## Built from

### Layout tree

Copy `layouts/Tony.json` and the mod code and assets from every folder under `mods/`. The repository root is the Tony layout: there is one copy of each mod and no nested Tony folder or duplicate mod tree. An installing agent leaves the root `RECIPE.md` and every mod's own `RECIPE.md` and `preview.png` out of `~/.config/herdr-app`, and copies the root `preview.png` to `~/.config/herdr-app/layouts/Tony.png`, the picture Herdr's layout picker shows. The JSON records `cloned_from: { "name": "main", "version": "0.1.12" }` and has this exact structure:

```json
{
  "id": "root",
  "cloned_from": {
    "name": "main",
    "version": "0.1.12"
  },
  "type": "row",
  "titlebar": "none",
  "traffic_lights": [
    12,
    16
  ],
  "background": "canvas",
  "terminal_padding": [
    14,
    12
  ],
  "divider": {
    "width": 1,
    "color": "border"
  },
  "children": [
    {
      "id": "sidebar",
      "type": "column",
      "size": {
        "px": 268
      },
      "min": 44,
      "max": 480,
      "background": "chrome",
      "resizable": false,
      "children": [
        {
          "id": "brand",
          "type": "block",
          "size": {
            "px": 46
          },
          "window_drag": true,
          "content": {
            "mod": "workspace-chrome"
          }
        },
        {
          "id": "sidebar-lists",
          "type": "column",
          "children": [
            {
              "id": "spaces",
              "type": "block",
              "size": {
                "weight": 1
              },
              "min": 90,
              "content": {
                "mod": "spaces"
              }
            },
            {
              "id": "tasks",
              "type": "block",
              "size": {
                "weight": 1
              },
              "min": 90,
              "content": {
                "mod": "github-tasks"
              }
            },
            {
              "id": "agents",
              "type": "block",
              "size": {
                "weight": 1
              },
              "min": 90,
              "content": {
                "mod": "agents"
              }
            },
            {
              "id": "usage",
              "type": "block",
              "size": {
                "px": 100
              },
              "min": 90,
              "content": {
                "mod": "usage"
              }
            }
          ]
        },
        {
          "id": "sidebar-footer",
          "type": "block",
          "size": {
            "px": 69
          },
          "content": {
            "mod": "workspace-chrome",
            "props": {
              "footer": true
            }
          }
        }
      ]
    },
    {
      "id": "work",
      "type": "column",
      "resizable": false,
      "children": [
        {
          "id": "tabs-row",
          "type": "row",
          "size": {
            "px": 42
          },
          "resizable": false,
          "children": [
            {
              "id": "tabs",
              "type": "block",
              "size": {
                "weight": 1
              },
              "window_drag": true,
              "content": {
                "mod": "tabs-icons"
              }
            },
            {
              "id": "sync-toggle",
              "type": "block",
              "content": {
                "mod": "sync",
                "props": {
                  "role": "button"
                }
              },
              "size": {
                "px": 42
              }
            },
            {
              "id": "skills-toggle",
              "type": "block",
              "content": {
                "mod": "skills",
                "props": {
                  "role": "toggle"
                }
              },
              "size": {
                "px": 42
              }
            }
          ]
        },
        {
          "id": "work-body",
          "type": "row",
          "padding": 8,
          "gap": 8,
          "children": [
            {
              "id": "main",
              "type": "block",
              "content": {
                "tab": "active",
                "pane": {
                  "gap": 8,
                  "radius": 10,
                  "background": "background",
                  "lone": true,
                  "border": {
                    "width": 1,
                    "color": "border"
                  },
                  "focus": {
                    "width": 1,
                    "color": "accent"
                  },
                  "header": {
                    "content": {
                      "mod": "pane"
                    },
                    "height": 30,
                    "position": "top",
                    "reveal": "always"
                  }
                }
              }
            },
            {
              "id": "panel",
              "type": "column",
              "hidden": true,
              "size": {
                "px": 368
              },
              "min": 280,
              "max": 900,
              "children": [
                {
                  "id": "panel-body",
                  "type": "stack",
                  "active": "files",
                  "children": [
                    {
                      "id": "files",
                      "type": "block",
                      "content": {
                        "mod": "files"
                      }
                    },
                    {
                      "id": "changes",
                      "type": "block",
                      "content": {
                        "mod": "changes"
                      }
                    },
                    {
                      "id": "skills",
                      "type": "block",
                      "content": {
                        "mod": "skills"
                      }
                    },
                    {
                      "id": "github-tasks",
                      "type": "block",
                      "content": {
                        "mod": "github-tasks",
                        "props": {
                          "role": "settings"
                        }
                      }
                    },
                    {
                      "id": "sync",
                      "type": "block",
                      "content": {
                        "mod": "sync",
                        "props": {
                          "role": "details"
                        }
                      }
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "id": "status",
          "type": "block",
          "size": {
            "px": 28
          },
          "content": {
            "mod": "status-bar"
          }
        }
      ]
    }
  ],
  "preview": "layouts/Tony.png"
}
```

The built-in mods Tony uses are **`spaces`, `agents`, `changes`, `files`, `pane`, and `workspace-chrome`**. It also invokes built-in `menu` and `new-menu` from the tab bar.

### Custom mods

All six custom mods have their own recipes and previews in the same folders that hold their code. Tony only lists their placement and props in the layout above.

- [`mods/usage/RECIPE.md`](mods/usage/RECIPE.md) fills the 100px sidebar Usage block.
- [`mods/status-bar/RECIPE.md`](mods/status-bar/RECIPE.md) fills the 28px bottom status block.
- [`mods/skills/RECIPE.md`](mods/skills/RECIPE.md) supplies the `toggle` and default panel roles.
- [`mods/github-tasks/RECIPE.md`](mods/github-tasks/RECIPE.md) covers tickets plus workflow and refactor type editing and run pages. Tony mounts Tasks' default ticket sidebar and its `settings` role in the right panel; there is no Tasks toggle and no separate Workflows mod. Starter files live under `mods/github-tasks/starters/`: Bug and Story for `~/.config/herdr-app/workflows`, and Redundant tests, Architecture and Isolation (refactor types) for `~/.config/herdr-app/refactors`.
- [`mods/sync/RECIPE.md`](mods/sync/RECIPE.md) supplies the always-running `button` role and its `details` panel. It has no settings: running `mods/sync/sync.sh` from a clone links that clone, and the mod syncs it to Herdr by itself.
- [`mods/tabs-icons/RECIPE.md`](mods/tabs-icons/RECIPE.md) is mounted in the flexible tab-row block with no props.

No `keys.json` belongs to the Tony layout: it supplies no layout-specific key bindings, and no mod ships key bindings the layout needs.

## Watch out

- Install all six custom mod folders, and the six listed built-ins must be available. A missing custom panel leaves a toggle without its intended content.
- The panel toggles depend on the exact ids `panel` and `panel-body`, and child ids `files`, `changes`, `skills`, `github-tasks` and `sync`. Changing them requires changing the custom mods too.
- The layout itself runs no external programs, reads no files outside Herdr's mod state and makes no network requests. Custom mod capabilities vary: Usage contacts Kimi on explicit refresh, Skills and GitHub Tasks (including workflows) run their CLIs and agents, and Sync runs Git (read-only, plus the branch switch you click) and the picked folder's `mods/sync/sync.sh`, which also drives Skillshare. Read their recipes before enabling those actions.
- Tony deliberately leaves theme and font choices unset. Do not add hard-coded colors where the source uses theme tokens. The preview image is a wireframe of the window (sidebar lists and usage meter, tab bar, terminal pane, right panel, status bar); it is a picker picture only, installed as `layouts/Tony.png` and not used by the layout itself.
- The sidebar's own `resizable: false` does not remove Herdr commands that hide or resize it. Tony's root sets the macOS traffic-light position to `[12, 16]`.
- Renaming any custom mod requires changing its layout reference and following the asset/self-overlay changes described in its own recipe.

## Done when

- `herdr-app check` passes for `mods/usage`, `mods/status-bar`, `mods/skills`, `mods/github-tasks` and `mods/sync`; then `layout.switch` to `Tony` succeeds without layout or mod errors.
- `node tests/mod-isolation.test.js` exits 0: no mod imports, opens, names a file of, or shares a key with another mod. It parses every `.js` file under `mods/` with a vendored, pinned acorn (`tests/vendor/acorn/`), needs no `npm install`, and prints `file:line`, the rule and the name found for each link. It also fails what it can't follow (shared/setShared/openOverlay passed on in an odd way, a `mods/` path built at run time, absolute imports, symlinks) and scans dot-folders. Mod code may name only itself and Herdr's built-ins (the allowlist at the top of the script); in `*.test.js` files only the names of other real mods fail. Its own test, `node --test tests/mod-isolation.fixtures.test.js`, runs it on the fake `tests/fixtures/mods/` tree.
- The window matches the tree and dimensions above, follows the selected theme/fonts, shows the six built-in mod roles, and frames even a lone terminal pane with its 30px header and focus border.
- Tabs Icons passes its own recipe checks.
- Tony's Sync and Skills toggles open their matching `panel-body` children; **Task settings** opens only from the Tasks sidebar gear.
- Usage and Status Bar render in their assigned blocks. Skills, Tasks (with workflows) and Sync pass their own recipes' checks, including Sync's always-mounted button and its "No repo linked" panel. No extra key bindings are required.
