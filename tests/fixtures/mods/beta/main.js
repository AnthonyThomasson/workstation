import { shared } from "herdr";
import { x } from "./x.js";
export const read = () => shared("beta.value") ?? x;
