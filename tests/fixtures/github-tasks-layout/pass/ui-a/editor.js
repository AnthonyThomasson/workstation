import { start } from "../service/index.js";
import { fs } from "node:fs";
export const editor = () => [start, fs, import("../core/index.js")];
