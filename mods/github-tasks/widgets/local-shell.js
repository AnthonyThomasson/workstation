// This computer's shell, for the Herdr-facing code: what OS Herdr's window says this is (lib/shell.js localOs), and sh scripts and
// Unix tools run here as that OS runs them: sh and the tool itself on the Mac and Linux, as before; Git Bash on Windows, where Herdr's
// exec finds no sh, mv, rm, mkdir or chmod. window() is null while `herdr-app check` loads the mod; that reads as Unix.
import { exec, window } from "herdr";
import { localOs, shArgv, toolArgv } from "../lib/index.js";

// "unix" | "windows", asked each time (no window yet reads as Unix).
export const hereOs = () => localOs(window()?.platform);

// Runs a sh script here; $1... are args.
export const localSh = (script, ...args) => { const [cmd, argv] = shArgv(hereOs(), script, args); return exec(cmd, argv); };

// Runs a Unix tool here (mv, rm, mkdir, chmod).
export const localTool = (cmd, args = []) => { const [c, argv] = toolArgv(hereOs(), cmd, args); return exec(c, argv); };
