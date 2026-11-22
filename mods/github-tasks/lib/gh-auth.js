// What `gh auth status` says and what is wrong with it: the doctor's gh-auth and gh-scope issues, shared with the Test device's deep
// check (devices/), which reads the same output from another machine. Pure.

// What gh auth status said: { installed, signedIn, scopes }. signedIn is false only when gh says there is no account at all or
// the active account's token is invalid; a network failure, a validation error, or a stale second account is not known to be
// a problem (null). scopes: those of the active, logged-in account; null when gh lists none (a GH_TOKEN, say).
export function parseAuthStatus({ code, stdout = "", stderr = "" }) {
  if (code === 127) return { installed: false, signedIn: false, scopes: null };
  const text = `${stdout}\n${stderr}`;
  // One block per account: gh starts each with "✓ Logged in to <host> account <name>" or "X Failed to log in to <host> account <name>".
  const blocks = text.split(/(?=^.*\b(?:Logged in to|Failed to log in to) \S+ account)/m).filter((b) => /(?:Logged in to|Failed to log in to) \S+ account/.test(b));
  const active = blocks.filter((b) => /Active account:\s*true/i.test(b));
  const judged = active.length ? active : blocks;
  const good = judged.find((b) => /Logged in to /.test(b) && !/Failed to log in/.test(b));
  if (good) {
    const line = good.match(/Token scopes:\s*(.*)/i)?.[1] ?? "";
    const scopes = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    return { installed: true, signedIn: true, scopes: scopes.length ? scopes : null };
  }
  const none = { installed: true, scopes: null };
  if (/not logged in(to)? any/i.test(text)) return { ...none, signedIn: false };
  if (judged.length) {
    const invalid = /token .{0,40}\binvalid\b|bad credentials|HTTP 401|has been revoked|expired/i.test(judged.join("\n"));
    return { ...none, signedIn: invalid ? false : null };
  }
  return { ...none, signedIn: code === 0 ? true : null };
}

// The doctor's issues for gh's state (auth: { installed, signedIn, scopes } | undefined): [{ kind: "gh-auth" | "gh-scope", message }].
export function authIssues(auth) {
  if (!auth) return [];
  if (!auth.installed) return [{ kind: "gh-auth", message: "gh isn't installed or can't run, so Tasks can't reach GitHub." }];
  if (auth.signedIn === false) return [{ kind: "gh-auth", message: "gh isn't signed in to GitHub." }];
  if (Array.isArray(auth.scopes) && !auth.scopes.includes("project")) {
    return [{ kind: "gh-scope", message: 'gh\'s token is missing the "project" scope, so Tasks can\'t read or edit GitHub Projects.', scopes: auth.scopes }];
  }
  return [];
}
