import { shared } from "herdr";
export function get(k) { return shared(k); }
export default function def(k) { return shared(k); }
export const arrow = (k) => shared(k);
