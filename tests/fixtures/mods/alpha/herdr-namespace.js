import * as h from "herdr";
const { shared } = h;
h["shared"]("beta.a");
const api = h;
api.shared("beta.b");
h.shared("alpha.fine");
const grab = h.shared;
export const keep = [shared, grab];
