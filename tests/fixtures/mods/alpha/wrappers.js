import { shared, setShared } from "herdr";
import { makeChannel, makeBadChannel, makeLostChannel } from "./channel.js";
export const good = makeChannel({ get: (k) => shared(k), set: (k, v) => setShared(k, v) });
export const bad = makeBadChannel({ get: (k) => shared(k) });
export const lost = makeLostChannel({ get: (k) => shared(k) });
