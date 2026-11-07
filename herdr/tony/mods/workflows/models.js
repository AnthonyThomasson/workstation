// The models each agent can be started on, to complete a role's model field from. Pure: Codex's list
// comes in as the text of its own cache (env.js reads the file), so node --test runs it.
// Claude's are the ones Claude Code's /model menu offers (Herdr's model menu keeps the same list;
// `id` is what --model takes). Codex's are the visible entries of ~/.codex/models_cache.json, which
// the CLI keeps current. Kimi Code's are the [models."..."] sections of ~/.kimi-code/config.toml (its
// --model takes the section's name). No other agent has a list on this machine, so they complete
// nothing and any id can still be typed.

export const CLAUDE_MODELS = [
  { id: "opus", name: "Opus 5.5" },
  { id: "opus[1m]", name: "Opus 5.5 · 1M" },
  { id: "claude-fable-5-1", name: "Fable 5.1" },
  { id: "sonnet", name: "Sonnet 5.5" },
  { id: "haiku", name: "Haiku 5.5" },
];

// The models in Codex's cache text: [{ id, name }], the ones it lists (not "hide"). [] if it is
// not readable, so a missing or changed file only costs the completion.
export function parseCodexModels(text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const models = Array.isArray(data?.models) ? data.models : [];
  return models
    .filter((m) => m && typeof m.slug === "string" && m.slug && m.visibility !== "hide")
    .map((m) => ({ id: m.slug, name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug }));
}

// The models in Kimi Code's config.toml: [{ id, name }], its default_model first, the rest as the file
// has them. id is the section's name ("kimi-code/k3.1-pro"), which is what --model takes; name is its
// display_name. Reads only those sections and the default, nothing else the file holds. [] when there
// are none, so a missing or changed file only costs the completion.
export function parseKimiModels(text) {
  const str = (v) => { const m = /^\s*"((?:[^"\\]|\\.)*)"/.exec(v); return m ? m[1].replace(/\\(.)/g, "$1") : null; };
  const models = [];
  let current = null, fallback = null, inSection = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const header = /^\s*\[+\s*([^\]]*?)\s*\]+\s*(#.*)?$/.exec(line);
    if (header) {
      inSection = true;
      const name = /^models\.(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))$/.exec(header[1]);
      current = name ? { id: (name[1] ?? name[2]).replace(/\\(.)/g, "$1"), name: null } : null;
      if (current) models.push(current);
      continue;
    }
    const kv = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (!inSection && kv[1] === "default_model") fallback = str(kv[2]);
    else if (current && kv[1] === "display_name") current.name = str(kv[2]);
  }
  const list = models.map((m) => ({ id: m.id, name: m.name || m.id.split("/").pop() }));
  const first = list.findIndex((m) => m.id === fallback);
  return first > 0 ? [list[first], ...list.slice(0, first), ...list.slice(first + 1)] : list;
}

// The models to offer for an agent kind. have: the lists read from the machine, { codex, kimi }.
export function modelsFor(agent, have = {}) {
  if (agent === "claude") return CLAUDE_MODELS;
  if (agent === "codex") return have.codex ?? [];
  if (agent === "kimi") return have.kimi ?? [];
  return [];
}

// Every word typed is in the model's id or its name, any case ("op 1m" finds Opus 5.5 · 1M). Ids that
// start with the query come first, then names that do, then the rest, each in list order.
export function matchModels(models, query, limit = Infinity) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return models.slice(0, limit);
  const q = words.join(" ");
  const rank = (m) => (m.id.toLowerCase().startsWith(q) ? 0 : m.name.toLowerCase().startsWith(q) ? 1 : 2);
  return models
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => { const hay = `${m.id} ${m.name}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map(({ m }) => m)
    .slice(0, limit);
}

// Whether text is exactly one of the models' ids.
export const hasModel = (models, text) => {
  const q = String(text ?? "").trim().toLowerCase();
  return Boolean(q) && models.some((m) => m.id.toLowerCase() === q);
};
