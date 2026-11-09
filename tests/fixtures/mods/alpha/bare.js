import { shared } from "herdr";
import { collect } from "../../elsewhere.js";
export const bag = { get: shared };
collect(shared);
const alias = shared;
alias("beta.alias");
alias("alpha.alias");
