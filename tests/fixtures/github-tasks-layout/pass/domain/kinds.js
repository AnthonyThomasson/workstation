import { shared } from "herdr";
import { Text } from "gpui-kit";
import { auth } from "../adapter/index.js";
const starter = new URL("../starters/bug.yml", import.meta.url);
export const kinds = [auth, starter, shared, Text];
