// Herdr's side of the place lookup: the selected space's main checkout (worktree.js placeInfo), on this computer or on the
// space's machine.
import { exec } from "herdr";
import { placeInfo } from "../runs/index.js";

const gitOn = (on) => (cwd, ...args) => exec("git", ["-C", cwd, ...args], { on });

// ctx: { folder, on }. cache: the last answer's .cache, or null for a fresh look.
export const readPlace = (ctx, cache) => placeInfo(ctx, cache, { git: gitOn });
