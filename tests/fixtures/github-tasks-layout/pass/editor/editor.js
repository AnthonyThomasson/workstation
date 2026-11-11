import { start } from "../runs/index.js";
import { fs } from "node:fs";
export const editor = () => [start, fs, import("../lib/index.js")];
