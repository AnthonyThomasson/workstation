// How the panel talks to the button: the panel hands a request (force a sync, pick a worktree, switch a branch) to the
// button, which is always mounted and does the work. It lives in Herdr's shared values, because the panel is a separate
// view whose tasks end when it hides. No Herdr imports: main.js passes shared/setShared in, the tests a Map.
export const REQUEST = "sync.request.v2"; // { id, op, ... }

// createChannel({ get, set, now }): get(key) and set(key, value) read and write shared values.
//   request(op): hands op to the button.
//   listen(): for the button; returns next(), which gives each request made after listen() once, then null.
// Writes must not happen while a view renders; reads may.
export function createChannel({ get, set, now = Date.now }) {
  return {
    request(op) { set(REQUEST, { ...op, id: `${now()}-${Math.random().toString(36).slice(2, 7)}` }); },
    listen() {
      let last = get(REQUEST)?.id ?? null;
      return () => {
        const r = get(REQUEST);
        if (!r?.id || r.id === last) return null;
        last = r.id;
        return r;
      };
    },
  };
}
