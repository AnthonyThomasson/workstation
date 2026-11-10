import test from "node:test";
import assert from "node:assert/strict";
import { diagnose, fixPrompt, parseAuthStatus, doctorSignature, samePlace, doctorFor } from "./doctor.js";
import { STATUSES, REFRESH, LOGIN } from "./model.js";

const PROJECT = { id: "P1", title: "app", url: "https://github.com/users/me/projects/3" };
const ALL = Object.values(STATUSES).map((name) => ({ name }));
const role = (agent = "claude") => ({ agent, command: "", prompt: "", model: "", effort: "medium" });
const workflow = (name, agents = {}, labels = []) => ({
  id: name.toLowerCase(), name, trigger: { labels, match: "any" },
  orchestrator: role(agents.orchestrator), worker: role(agents.worker), reviewer: role(agents.reviewer), investigator: role(agents.investigator),
});
// Everything is fine unless a test says otherwise.
const healthy = (over = {}) => ({
  repo: "me/app", project: PROJECT, statuses: ALL,
  auth: { installed: true, signedIn: true, scopes: ["repo", "project"] },
  agents: [{ key: "claude", installed: true }, { key: "codex", installed: true }, { key: "gemini", installed: false }], groomerAgent: null,
  workflows: { items: [workflow("Story")], errors: [] },
  ...over,
});
const kinds = (issues) => issues.map((i) => i.kind);

test("a healthy setup has no issues", () => {
  assert.deepEqual(diagnose(healthy()), []);
});

test("a space that is not in a GitHub repo skips the project and status checks", () => {
  const issues = diagnose(healthy({ repo: null, project: undefined, statuses: undefined }));
  assert.deepEqual(issues, []);
  const withProblems = diagnose(healthy({ repo: null, project: null, statuses: [], auth: { installed: true, signedIn: false, scopes: null },
    groomerAgent: "gemini", workflows: { items: [], errors: ["a.yaml: bad"] } }));
  assert.deepEqual(kinds(withProblems).sort(), ["agent-missing", "gh-auth", "workflow-invalid"]);
});

test("a repo with no linked project is one issue and skips the status checks", () => {
  const issues = diagnose(healthy({ project: null, statuses: [] }));
  assert.deepEqual(kinds(issues), ["no-project"]);
  assert.match(issues[0].message, /me\/app/);
});

test("an unknown project or status list (gh could not answer) flags nothing about statuses", () => {
  assert.deepEqual(diagnose(healthy({ project: undefined, statuses: undefined })), []);
  assert.deepEqual(diagnose(healthy({ statuses: undefined })), []);
});

test("a status with no option, even loosely, is missing", () => {
  const issues = diagnose(healthy({ statuses: ALL.filter((o) => o.name !== "Up Next" && o.name !== "Done") }));
  assert.deepEqual(issues.map((i) => [i.kind, i.status]), [["status-missing", "Up Next"], ["status-missing", "Done"]]);
  assert.match(issues[0].message, /"Up Next"/);
});

test("a project with no Status field at all misses all six statuses", () => {
  const issues = diagnose(healthy({ statuses: [] }));
  assert.deepEqual(issues.map((i) => i.status), Object.values(STATUSES));
  assert.ok(issues.every((i) => i.kind === "status-missing"));
});

test("a project with no Won't Do status is flagged, and the existing options are fine", () => {
  const issues = diagnose(healthy({ statuses: ALL.filter((o) => o.name !== "Won't Do") }));
  assert.deepEqual(issues.map((i) => [i.kind, i.status]), [["status-missing", "Won't Do"]]);
  assert.match(issues[0].message, /"Won't Do"/);
});

test("a Won't Do spelled loosely is misnamed", () => {
  const issues = diagnose(healthy({ statuses: [...ALL.filter((o) => o.name !== "Won't Do"), { name: "Wont Do" }] }));
  assert.deepEqual(issues.map((i) => [i.kind, i.status, i.found]), [["status-misnamed", "Won't Do", "Wont Do"]]);
});

test("the fix prompt adds a missing Won't Do without removing or reordering the other options", () => {
  const prompt = fixPrompt(diagnose(healthy({ statuses: ALL.filter((o) => o.name !== "Won't Do") })), context);
  assert.match(prompt, /Create the status "Won't Do" on the project's Status field/);
  assert.match(prompt, /To Do, Up Next, In Progress, In Review, Done, Won't Do/);
  assert.match(prompt, /Don't remove or reorder the other options/);
});

test("a status that matches only loosely is misnamed, with both spellings", () => {
  const statuses = [{ name: "Todo" }, { name: "up next" }, { name: "In Progress" }, { name: "In-Review" }, { name: "Done" }, { name: "Won't Do" }];
  const issues = diagnose(healthy({ statuses }));
  assert.deepEqual(issues.map((i) => [i.kind, i.status, i.found]), [
    ["status-misnamed", "To Do", "Todo"], ["status-misnamed", "Up Next", "up next"], ["status-misnamed", "In Review", "In-Review"],
  ]);
  assert.match(issues[0].message, /"Todo".*"To Do"/);
});

test("an exact spelling wins over a loose one, and extra statuses are fine", () => {
  const statuses = [...ALL, { name: "Todo" }, { name: "Blocked" }];
  assert.deepEqual(diagnose(healthy({ statuses })), []);
});

test("gh that is not signed in is one issue, and it does not also report the scope", () => {
  const issues = diagnose(healthy({ auth: { installed: true, signedIn: false, scopes: null } }));
  assert.deepEqual(kinds(issues), ["gh-auth"]);
  assert.match(issues[0].message, /signed in/);
});

test("gh that cannot run is reported as gh", () => {
  const issues = diagnose(healthy({ auth: { installed: false, signedIn: false, scopes: null } }));
  assert.deepEqual(kinds(issues), ["gh-auth"]);
  assert.match(issues[0].message, /install/i);
});

test("a token without the project scope is an issue; read:project is not enough", () => {
  const issues = diagnose(healthy({ auth: { installed: true, signedIn: true, scopes: ["repo", "read:project"] } }));
  assert.deepEqual(kinds(issues), ["gh-scope"]);
  assert.match(issues[0].message, /project/);
});

test("a token whose scopes gh does not list is not accused", () => {
  assert.deepEqual(diagnose(healthy({ auth: { installed: true, signedIn: true, scopes: null } })), []);
});

test("a saved grooming agent that is not installed is an issue", () => {
  const issues = diagnose(healthy({ groomerAgent: "gemini" }));
  assert.deepEqual(issues.map((i) => [i.kind, i.agent]), [["agent-missing", "gemini"]]);
  assert.deepEqual(issues[0].usedBy, ["Task agent"]);
});

test("no saved grooming agent means nothing to check there", () => {
  assert.deepEqual(diagnose(healthy({ groomerAgent: null, workflows: { items: [], errors: [] } })), []);
});

test("each missing workflow agent is one issue listing every role that uses it", () => {
  const workflows = { errors: [], items: [
    workflow("Bug", { orchestrator: "gemini", worker: "codex", reviewer: "gemini" }),
    workflow("Story", { worker: "gemini", investigator: "gemini" }),
  ] };
  const issues = diagnose(healthy({ workflows, groomerAgent: "gemini" }));
  assert.deepEqual(issues.map((i) => i.agent), ["gemini"]);
  assert.deepEqual(issues[0].usedBy, ["Task agent", "Bug orchestrator", "Bug reviewer", "Story worker", "Story investigator"]);
});

test("an unknown project, repo or statuses carry the last check's project issues", () => {
  const carried = [{ kind: "no-project", message: "x" }, { kind: "status-missing", status: "Done", message: "y" }];
  assert.deepEqual(diagnose(healthy({ repo: undefined, project: undefined, statuses: undefined, carried })), carried);
  assert.deepEqual(diagnose(healthy({ project: undefined, statuses: undefined, carried })), carried);
  assert.deepEqual(diagnose(healthy({ statuses: undefined, carried })), [carried[1]]);
  assert.deepEqual(diagnose(healthy({ repo: null, carried })), []);
  assert.deepEqual(diagnose(healthy({ carried })), []); // a known, good project wins over what was carried
});

test("a custom agent is not checked", () => {
  const custom = { ...role("custom"), command: "my-agent --go" };
  const items = [{ ...workflow("Odd"), worker: custom }];
  assert.deepEqual(diagnose(healthy({ workflows: { items, errors: [] } })), []);
});

test("agents are not checked when the installed list is unknown", () => {
  assert.deepEqual(diagnose(healthy({ agents: null, groomerAgent: "gemini" })), []);
});

test("an agent knownAgents() does not know is run as a bare command and is not flagged", () => {
  assert.deepEqual(diagnose(healthy({ groomerAgent: "my-agent", workflows: { items: [workflow("W", { worker: "other-bin" })], errors: [] } })), []);
});

test("an unparseable workflow file is an issue that names the file and why", () => {
  const issues = diagnose(healthy({ workflows: { items: [], errors: ["story.yaml: Line 3: bad indent"] } }));
  assert.deepEqual(kinds(issues), ["workflow-invalid"]);
  assert.match(issues[0].message, /story\.yaml: Line 3: bad indent/);
});

test("a workflow with no labels or an empty prompt is valid", () => {
  const items = [workflow("Fallback", {}, []), { ...workflow("Quiet"), worker: { ...role(), prompt: "" } }];
  assert.deepEqual(diagnose(healthy({ workflows: { items, errors: [] } })), []);
});

test("diagnose does not change its inputs", () => {
  const inputs = healthy({ statuses: [{ name: "Todo" }], groomerAgent: "gemini" });
  const copy = JSON.parse(JSON.stringify(inputs));
  diagnose(inputs);
  assert.deepEqual(inputs, copy);
});

const ACTIVE_OK = "github.com\n  ✓ Logged in to github.com account me (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_****\n  - Token scopes: 'gist', 'project', 'read:org', 'repo'\n";
const STALE = "  X Failed to log in to github.com account old (keyring)\n  - Active account: false\n  - The token in keyring is invalid.\n";

test("parses gh auth status for sign-in and scopes", () => {
  assert.deepEqual(parseAuthStatus({ code: 0, stdout: ACTIVE_OK, stderr: "" }), { installed: true, signedIn: true, scopes: ["gist", "project", "read:org", "repo"] });
  // gh has printed this on stderr in some versions.
  assert.deepEqual(parseAuthStatus({ code: 0, stdout: "", stderr: ACTIVE_OK }).scopes, ["gist", "project", "read:org", "repo"]);
  assert.deepEqual(parseAuthStatus({ code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login" }), { installed: true, signedIn: false, scopes: null });
  assert.deepEqual(parseAuthStatus({ code: 127, stdout: "", stderr: "spawn gh ENOENT" }), { installed: false, signedIn: false, scopes: null });
});

test("a GH_TOKEN login with no scopes line is signed in, scopes unknown", () => {
  const env = "github.com\n  ✓ Logged in to github.com account me (GH_TOKEN)\n  - Active account: true\n  - Token: ghp_****\n";
  assert.deepEqual(parseAuthStatus({ code: 0, stdout: env, stderr: "" }), { installed: true, signedIn: true, scopes: null });
  assert.deepEqual(parseAuthStatus({ code: 0, stdout: "  ✓ Logged in to github.com account me\n", stderr: "" }), { installed: true, signedIn: true, scopes: null });
});

test("a stale second account does not make gh signed out, and its scopes are not used", () => {
  const both = `github.com\n${STALE}\n${ACTIVE_OK.replace("github.com\n", "")}`;
  assert.deepEqual(parseAuthStatus({ code: 1, stdout: both, stderr: "" }), { installed: true, signedIn: true, scopes: ["gist", "project", "read:org", "repo"] });
  const activeLast = `github.com\n  ✓ Logged in to github.com account other (keyring)\n  - Active account: false\n  - Token scopes: 'repo'\n${ACTIVE_OK.replace("github.com\n", "")}`;
  assert.deepEqual(parseAuthStatus({ code: 0, stdout: activeLast, stderr: "" }).scopes, ["gist", "project", "read:org", "repo"]);
});

test("an invalid active token is signed out", () => {
  const bad = "github.com\n  X Failed to log in to github.com account me (keyring)\n  - Active account: true\n  - The token in keyring is invalid.\n  - To re-authenticate, run: gh auth login -h github.com\n";
  assert.equal(parseAuthStatus({ code: 1, stdout: bad, stderr: "" }).signedIn, false);
});

test("a network or validation error is not known to be a problem", () => {
  const offline = "github.com\n  X Failed to log in to github.com account me (keyring)\n  - Active account: true\n  - error validating token: Get \"https://api.github.com/\": dial tcp: lookup api.github.com: no such host\n";
  assert.deepEqual(parseAuthStatus({ code: 1, stdout: offline, stderr: "" }), { installed: true, signedIn: null, scopes: null });
  assert.equal(parseAuthStatus({ code: 1, stdout: "", stderr: "error connecting to api.github.com" }).signedIn, null);
  assert.deepEqual(diagnose(healthy({ auth: { installed: true, signedIn: null, scopes: null } })), []);
});

test("the signature changes with what the check depends on, and only then", () => {
  const base = { place: { cwd: "/a/src", on: undefined, root: "/a" }, workflowsChanged: 1, groomer: { agent: "claude" } };
  const sig = doctorSignature(base);
  assert.equal(doctorSignature({ ...base, groomer: { agent: "claude" } }), sig);
  assert.equal(doctorSignature({ ...base, place: { ...base.place, cwd: "/a/other" } }), sig, "moving within one repo is not a change");
  assert.notEqual(doctorSignature({ ...base, place: { cwd: "/b", root: "/b" } }), sig);
  assert.notEqual(doctorSignature({ ...base, place: { ...base.place, on: "box" } }), sig);
  assert.notEqual(doctorSignature({ ...base, place: null }), sig);
  assert.notEqual(doctorSignature({ ...base, workflowsChanged: 2 }), sig);
  assert.notEqual(doctorSignature({ ...base, groomer: { agent: "codex" } }), sig);
  assert.notEqual(doctorSignature({ ...base, place: { cwd: "/a/src" } }), sig, "with no repo the folder itself counts");
  assert.equal(doctorSignature({ ...base, project: null }), sig, "no picked project is the same as none given");
  assert.notEqual(doctorSignature({ ...base, project: "P2" }), sig);
});

test("an answer is only for the place it was made for", () => {
  const found = { issues: [1], place: { cwd: "/a/src", on: null, root: "/a" } };
  assert.equal(doctorFor(found, { cwd: "/a/src" }), found);
  assert.equal(doctorFor(found, { cwd: "/a/deep/er", on: undefined }), found);
  assert.equal(doctorFor(found, { cwd: "/a" }), found);
  assert.equal(doctorFor(found, { cwd: "/ab" }), null, "a sibling folder with the same prefix");
  assert.equal(doctorFor(found, { cwd: "/b" }), null);
  assert.equal(doctorFor(found, { cwd: "/a/src", on: "box" }), null);
  assert.equal(doctorFor(found, null), null);
  assert.equal(doctorFor(null, { cwd: "/a" }), null);
  const noRepo = { issues: [], place: { cwd: "/tmp/x", root: null } };
  assert.equal(doctorFor(noRepo, { cwd: "/tmp/x/y" }), null);
  assert.equal(doctorFor({ issues: [], place: null }, null).issues.length, 0);
  assert.equal(samePlace(null, { cwd: "/a" }), false);
});

// ---- The prompt ------------------------------------------------------------------------------------

const context = { repo: "me/app", project: PROJECT };

test("the prompt names the repo, the project and the exact status names to create", () => {
  const issues = diagnose(healthy({ statuses: ALL.filter((o) => o.name !== "Up Next") }));
  const prompt = fixPrompt(issues, context);
  assert.match(prompt, /me\/app/);
  assert.match(prompt, /"app"/);
  assert.match(prompt, /https:\/\/github\.com\/users\/me\/projects\/3/);
  assert.match(prompt, /Create the status "Up Next"/);
  assert.match(prompt, /To Do, Up Next, In Progress, In Review, Done, Won't Do/);
});

test("the prompt tells how to rename a misnamed status without losing tickets", () => {
  const prompt = fixPrompt(diagnose(healthy({ statuses: [{ name: "Todo" }, ...ALL.slice(1)] })), context);
  assert.match(prompt, /Rename the status "Todo" to "To Do"/);
  assert.match(prompt, /rename.*(don't|do not|never).*(delete|recreate)|(don't|do not|never).*(delete|recreate).*rename/is);
});

test("the prompt tells how to link a project when there is none", () => {
  const prompt = fixPrompt(diagnose(healthy({ project: null, statuses: [] })), { repo: "me/app", project: null });
  assert.match(prompt, /No GitHub Project is linked/);
  assert.match(prompt, /gh project create/);
  assert.match(prompt, /gh project link/);
});

test("the prompt names the exact gh commands for sign-in and the scope", () => {
  const signedOut = fixPrompt(diagnose(healthy({ auth: { installed: true, signedIn: false, scopes: null } })), context);
  assert.ok(signedOut.includes(`gh ${LOGIN.join(" ")}`));
  const noScope = fixPrompt(diagnose(healthy({ auth: { installed: true, signedIn: true, scopes: ["repo"] } })), context);
  assert.ok(noScope.includes(`gh ${REFRESH.join(" ")}`));
});

test("the prompt covers agents and workflow files, and says what not to touch", () => {
  const issues = diagnose(healthy({ groomerAgent: "gemini", workflows: { items: [], errors: ["bug.yaml: Line 2: bad"] } }));
  const prompt = fixPrompt(issues, context);
  assert.match(prompt, /"gemini"/);
  assert.match(prompt, /Task agent/);
  assert.match(prompt, /bug\.yaml: Line 2: bad/);
  assert.match(prompt, /workflows/);
  assert.match(prompt, /Ask the person before/);
});

test("the prompt works without a repo or project, and is empty with no issues", () => {
  assert.equal(fixPrompt([], context), "");
  const issues = diagnose(healthy({ repo: null, project: undefined, statuses: undefined, groomerAgent: "gemini" }));
  const prompt = fixPrompt(issues, { repo: null, project: null });
  assert.doesNotMatch(prompt, /null|undefined/);
});

// ---- Local tasks -----------------------------------------------------------------------------------

const brokenGithub = { project: null, statuses: undefined, auth: { installed: true, signedIn: true, scopes: ["repo"] } };

test("local tasks skip the project, status and scope checks", () => {
  assert.deepEqual(kinds(diagnose(healthy({ ...brokenGithub, source: "local", githubRemote: true }))), [], "no project, no project scope: fine");
  const statuses = [{ name: "To Do" }, { name: "in progress" }];
  assert.deepEqual(diagnose(healthy({ source: "local", statuses, carried: [{ kind: "no-project" }] })), []);
  assert.deepEqual(kinds(diagnose(healthy({ ...brokenGithub, source: "github" }))), ["gh-scope", "no-project"], "github mode is unchanged");
  assert.deepEqual(kinds(diagnose(healthy({ ...brokenGithub }))), ["gh-scope", "no-project"], "no source is github");
});

test("local tasks skip the trigger-label check: their labels are typed freely", () => {
  const workflows = { items: [workflow("Story", {}, ["bug"])], errors: [] };
  assert.deepEqual(diagnose(healthy({ source: "local", workflows, labels: [] })), []);
  assert.deepEqual(kinds(diagnose(healthy({ workflows, labels: [] }))), ["label-missing"], "github mode still checks");
});

test("local tasks check gh-auth only when the origin is on GitHub", () => {
  const signedOut = { installed: true, signedIn: false, scopes: null };
  assert.deepEqual(kinds(diagnose(healthy({ source: "local", githubRemote: true, auth: signedOut }))), ["gh-auth"]);
  assert.deepEqual(kinds(diagnose(healthy({ source: "local", githubRemote: true, auth: { installed: false } }))), ["gh-auth"]);
  assert.deepEqual(diagnose(healthy({ source: "local", githubRemote: false, auth: signedOut })), []);
  assert.deepEqual(diagnose(healthy({ source: "local", auth: signedOut })), [], "an unknown remote is not accused");
});

test("local tasks still check agents and workflow files", () => {
  const issues = diagnose(healthy({
    source: "local", groomerAgent: "gemini", workflows: { items: [], errors: ["bug.yaml: Line 2: bad"] },
  }));
  assert.deepEqual(kinds(issues), ["agent-missing", "workflow-invalid"]);
});

test("the signature includes the task source", () => {
  const base = { place: { cwd: "/a", root: "/a" }, workflowsChanged: 1, groomer: { agent: "claude" } };
  const sig = doctorSignature(base);
  assert.equal(doctorSignature({ ...base, source: "github" }), sig, "no source is github");
  assert.notEqual(doctorSignature({ ...base, source: "local" }), sig);
});

test("the prompt for local tasks says the repo uses local tasks and names no project", () => {
  const issues = diagnose(healthy({
    source: "local", githubRemote: true, groomerAgent: "gemini", auth: { installed: true, signedIn: false, scopes: null },
  }));
  const prompt = fixPrompt(issues, { repo: "me/app", project: PROJECT, source: "local" });
  assert.match(prompt, /local tasks/);
  assert.doesNotMatch(prompt, /GitHub Project|projects\/3|"app"|Statuses:|gh project/);
  assert.match(prompt, /gh auth login|gh isn't signed in/);
  assert.match(prompt, /Agent: /);
  assert.match(fixPrompt(diagnose(healthy({ groomerAgent: "gemini" })), context), /GitHub Project "app"/, "github mode names the project");
});

// ---- Trigger labels -----------------------------------------------------------------------------------

test("a label a workflow triggers on and the repo lacks is one issue, listing the workflows; case is ignored", () => {
  const workflows = { items: [workflow("Story", {}, ["bug", "Feature"]), workflow("Fix", {}, ["BUG"]), workflow("Fallback")], errors: [] };
  const issues = diagnose(healthy({ workflows, labels: [{ name: "Bug" }, { name: "other" }] }));
  assert.deepEqual(issues.map((i) => [i.kind, i.label, i.usedBy]), [["label-missing", "Feature", ["Story"]]]);
  assert.match(issues[0].message, /"Feature".*me\/app.*Story/);
  const two = diagnose(healthy({ workflows, labels: [] }));
  assert.deepEqual(two.map((i) => [i.label, i.usedBy]), [["bug", ["Story", "Fix"]], ["Feature", ["Story"]]]);
});

test("labels the repo has, or workflows without trigger labels, are no issue", () => {
  const workflows = { items: [workflow("Story", {}, ["bug"]), workflow("Fallback")], errors: [] };
  assert.deepEqual(diagnose(healthy({ workflows, labels: [{ name: "bug" }] })), []);
  assert.deepEqual(diagnose(healthy({ labels: [] })), []);
});

test("unknown labels, or no repo, flag nothing; unknown labels keep the last label issues still triggered on", () => {
  const workflows = { items: [workflow("Story", {}, ["bug"])], errors: [] };
  assert.deepEqual(diagnose(healthy({ workflows })), []);
  assert.deepEqual(diagnose(healthy({ workflows, repo: null, labels: [] })), []);
  assert.deepEqual(diagnose(healthy({ workflows, repo: undefined, labels: [] })), []);
  const carried = [{ kind: "label-missing", label: "bug", usedBy: ["Story"], message: "x" }, { kind: "label-missing", label: "gone", usedBy: ["Old"], message: "y" }];
  assert.deepEqual(diagnose(healthy({ workflows, carried })), [carried[0]]);
  assert.deepEqual(diagnose(healthy({ workflows, labels: [{ name: "bug" }], carried })), []); // known labels win
});

test("fixPrompt tells how to create a missing label", () => {
  const workflows = { items: [workflow("Story", {}, ["bug", "good first"])], errors: [] };
  const prompt = fixPrompt(diagnose(healthy({ workflows, labels: [] })), { repo: "me/app", project: PROJECT });
  assert.match(prompt, /`gh label create bug -R me\/app`/);
  assert.match(prompt, /`gh label create 'good first' -R me\/app`/);
});

test("with the repo unknown the carried label issues are kept; with no repo at all they are not", () => {
  const workflows = { items: [workflow("Story", {}, ["bug"])], errors: [] };
  const carried = [{ kind: "label-missing", label: "bug", usedBy: ["Story"], message: "x" }, { kind: "label-missing", label: "gone", usedBy: ["Old"], message: "y" }];
  assert.deepEqual(diagnose(healthy({ workflows, repo: undefined, project: undefined, statuses: undefined, carried })), [carried[0]]);
  assert.deepEqual(diagnose(healthy({ workflows, repo: null, carried })), []);
});

test("a label starting with a dash is created after --, so gh does not read it as a flag", () => {
  const workflows = { items: [workflow("Story", {}, ["-wip", "a-b"])], errors: [] };
  const prompt = fixPrompt(diagnose(healthy({ workflows, labels: [] })), { repo: "me/app", project: PROJECT });
  assert.match(prompt, /`gh label create -R me\/app -- -wip`/);
  assert.match(prompt, /`gh label create a-b -R me\/app`/);
});
