import { shared } from "herdr";
function loop(get, pairs = [["alpha.a"]]) {
  for (const [k] of pairs) get(k);
}
loop(shared, [["beta.leak"]]);
loop(shared);
loop(shared, [["alpha.b"]]);
function each(get, items = ["alpha.x"]) {
  for (const k of items) get(k);
}
each(shared, props.items);
