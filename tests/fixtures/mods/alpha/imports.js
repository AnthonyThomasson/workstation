import { x } from "../beta/x.js";
export { y } from "../beta/y.js";
import { own } from "./own.js";
export const load = (name) => import(name);
export const fine = () => import("./own.js");
export const unused = [x, own];
