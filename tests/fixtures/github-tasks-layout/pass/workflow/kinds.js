import { auth } from "../github/index.js";
const starter = new URL("../starters/bug.yml", import.meta.url);
export const kinds = [auth, starter];
