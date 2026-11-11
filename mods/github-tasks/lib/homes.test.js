// Every "github-tasks.*" shared-state or overlay key, every herdr.* terminal label and every .herdr/ path the mod builds has
// one home, and this guard keeps it so: it parses each .js file of the mod (all its folders, tests left out) and reports a
// string, template piece or regular expression that holds one of them anywhere outside its home, inside a longer string too.
// Comments are not code, and prose that only names a repo's .herdr folder ("Kept in the repo's .herdr/workflows folder") is
// not a path being built.
import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "../../../tests/vendor/acorn/acorn.mjs";

const MOD = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// kind, the one file that may hold it (relative to the mod), and whether a piece of text holds one.
export const HOMES = [
  { kind: "key", home: "lib/keys.js", holds: (text) => /(?:^|[^\w.-])github-tasks\./.test(text) },
  { kind: "label", home: "lib/terminal-labels.js", holds: (text) => /(?:^|[^\w.-])herdr\.[A-Za-z]/.test(text) },
  {
    kind: "path", home: "workflow/places.js",
    // A path being built: /.herdr/ (after a folder, ~ or ${...}), .herdr/ opening the text, one of the home's run folders, or a pane.json.
    holds: (text) => /\/\.herdr\/|^\.herdr\/|\.herdr\/(?:workflow-runs|worktrees|investigations)\b|\/pane\.json\b/.test(text),
  },
];

// Every problem in one file's source: "<file>:<line>: <kind> belongs in <home>: <text>".
export function problemsIn(source, file) {
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
  const problems = [];
  const check = (node, text) => {
    for (const { kind, home, holds } of HOMES) {
      if (file !== home && holds(text)) problems.push(`${file}:${node.loc.start.line}: ${kind} belongs in ${home}: ${text}`);
    }
  };
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "Literal" && typeof node.value === "string") check(node, node.value);
    else if (node.type === "Literal" && node.regex) check(node, node.regex.pattern.replace(/\\(.)/g, "$1")); // \.herdr\/ is .herdr/
    else if (node.type === "TemplateElement") check(node, node.value.cooked ?? node.value.raw);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === "string") visit(value);
    }
  };
  visit(ast);
  return problems;
}

// The mod's code files (no tests), relative to the mod, sorted; symlinks are not followed.
function codeFiles(dir = MOD) {
  return readdirSync(dir).sort().flatMap((name) => {
    const full = path.join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink() || name === "node_modules") return [];
    if (st.isDirectory()) return codeFiles(full);
    return /\.(js|mjs)$/.test(name) && !name.endsWith(".test.js") ? [path.relative(MOD, full).split(path.sep).join("/")] : [];
  });
}

test("every github-tasks key, terminal label and .herdr path in mod code is in its home", () => {
  const files = codeFiles();
  assert.ok(files.includes("main.js") && files.some((f) => f.startsWith("runs/")), "the scan reaches the top files and the sub-folders");
  for (const { home } of HOMES) assert.ok(files.includes(home), `${home} is there`);
  const problems = files.flatMap((file) => problemsIn(readFileSync(path.join(MOD, file), "utf8"), file));
  assert.deepEqual(problems, [], "import these from their home (through its folder's index.js) instead");
});

test("the guard finds keys in strings, templates and longer strings, and ignores comments and the mod's own name", () => {
  const source = `
    // const ignored = "github-tasks.changed";
    /* setShared(\`github-tasks.run.\${id}.stage\`) */
    const overlay = { mod: "github-tasks", kind: "window" };
    const icon = "mods/github-tasks/icons/x.svg";
    const key = "github-tasks.changed";
    const perRun = \`github-tasks.run.\${id}.stage\`;
    const inside = \`shared \${a} github-tasks.place\`;
    const single = 'github-tasks.groomAgent';
  `;
  const keys = problemsIn(source, "runs/example.js").filter((p) => p.includes(": key belongs in lib/keys.js"));
  assert.deepEqual(keys.map((p) => p.split(":")[1]), ["6", "7", "8", "9"]);
  assert.deepEqual(problemsIn(source, "lib/keys.js").filter((p) => p.includes(": key ")), [], "its home may hold them");
});

test("the guard finds labels in strings, templates and command lines, and ignores comments", () => {
  const source = `
    // const ignored = "herdr.role";
    const label = "herdr.role";
    const assigned = \`herdr.workflow.run=\${id}\`;
    const command = "hc run --label herdr.role=x";
    const script = \`hc ls --label "herdr.workflow.folder=\${d}"\`;
    const module = "herdr";
    const app = "herdr-app";
  `;
  const labels = problemsIn(source, "runs/example.js").filter((p) => p.includes(": label belongs in lib/terminal-labels.js"));
  assert.deepEqual(labels.map((p) => p.split(":")[1]), ["3", "4", "5", "6"]);
  assert.deepEqual(problemsIn('export const ROLE_LABEL = "herdr.role";', "lib/terminal-labels.js"), []);
});

test("the guard finds .herdr paths and pane.json built in code, inside longer strings and regexes, and ignores prose", () => {
  const source = `
    // const ignored = \`\${home}/.herdr/workflow-runs/\${id}\`;
    const prose = "Kept in the repo's .herdr/workflows folder, to commit with the repo.";
    const doc = "Workflows are YAML files in \`.herdr/workflows/\` in the repo.";
    const note = "The run's pane.json wasn't updated";
    const run = \`\${home}/.herdr/workflow-runs/\${id}\`;
    const mkdir = \`mkdir -p \${d}/.herdr/workflow-runs\`;
    const tilde = "~/.herdr/worktrees";
    const pane = \`\${runDir}/pane.json\`;
    const pattern = /^\\/(?:.*\\/)?\\.herdr\\/workflow-runs\\/([^/]+)$/;
    const relative = ".herdr/investigations";
  `;
  const paths = problemsIn(source, "runs/example.js").filter((p) => p.includes(": path belongs in workflow/places.js"));
  assert.deepEqual(paths.map((p) => p.split(":")[1]), ["6", "7", "8", "9", "10", "11"]);
  assert.deepEqual(problemsIn('export const runDir = (home, id) => `${home}/.herdr/workflow-runs/${id}`;', "workflow/places.js"), []);
});
