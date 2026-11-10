import { a } from "/Users/x/lib/main.js";
import { b } from "file:///tmp/x.js";
export const dyn = () => import("/abs.js");
export const ok = [a, b];
