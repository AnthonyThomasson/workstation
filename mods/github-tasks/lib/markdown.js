// Prompt text shown as Markdown.
// Placeholders are text, not HTML. Inline code and fenced blocks stay as they are so their Markdown still works.
export function markdownLiteral(text) {
  return String(text ?? "").split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, "\\<").replace(/&(?=#?\w+;)/g, "\\&"))).join("");
}
