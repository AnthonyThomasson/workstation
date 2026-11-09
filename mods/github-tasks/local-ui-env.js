// Herdr's side of the local-tasks panel: finds which source the selected place uses (local-ui.js placeInfo), on this
// computer or on the space's machine. Never runs git on tasks.json or a task file.
import { exec, readTextFile } from "herdr";
import { placeInfo } from "./local-ui.js";
import { tasksConfig } from "./local-tasks-env.js";
import { makeTasksConfig } from "./tasks-config.js";

const gitOn = (on) => (cwd, ...args) => exec("git", ["-C", cwd, ...args], { on });
// This computer's config is local-tasks-env's; another machine's is read from there.
const configOn = (on) => (on ? makeTasksConfig({ read: (path) => readTextFile(path, { on }) }) : tasksConfig);

// ctx: { folder, on }. cache: the last answer's .cache, or null for a fresh look.
export const readPlace = (ctx, cache) => placeInfo(ctx, cache, { git: gitOn, config: configOn });
