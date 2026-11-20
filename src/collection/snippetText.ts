// Snippets that expand as you type, inside Petrel: `;sig` in a note or the capture window becomes the Email
// sign-off from the Snippets collection. A snippet's trigger is a line of its own like `;sig`, or else its title
// in lower case without spaces (`;emailsignoff`, found from `;ema` too). Blanks become fields to fill in place,
// Tab to the next. Pure, for the tests; the editor part is src/editor/snippets.ts.

// No imports: node runs the tests on this file as it is, and an import without its extension would not load.

export interface Snippet {
  trigger: string;
  title: string;
  /** The text as written, without its trigger line. */
  body: string;
}

const TRIGGER = /^;([\p{L}\p{N}_-]{1,24})\s*$/u;

export function snippetOf(title: string, body: string): Snippet {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => TRIGGER.test(l.trim()));
  const trigger = at >= 0 ? TRIGGER.exec(lines[at].trim())![1].toLowerCase() : title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (at >= 0) lines.splice(at, 1);
  return { trigger, title, body: lines.join("\n").replace(/^\n+|\n+$/g, "") };
}

/** Exact triggers first, then those that start with what was typed, then titles with a word that does. */
export function matchSnippets(list: Snippet[], typed: string): Snippet[] {
  const q = typed.toLowerCase();
  const rank = (s: Snippet) =>
    s.trigger === q ? 0 : s.trigger.startsWith(q) ? 1 : s.title.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) ? 2 : -1;
  return list
    .map((s) => [rank(s), s] as const)
    .filter(([r]) => r >= 0)
    .sort((a, b) => a[0] - b[0] || a[1].trigger.length - b[1].trigger.length)
    .map(([, s]) => s);
}

const BLANK = /(\\)?\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;

/**
 * The text as a CodeMirror snippet template: each blank a field named by its default (or its name), the same
 * blank twice one field. `{{today}}` is written out. Null when the text has `${` or `#{` of its own, which the
 * template would misread: then it goes in filled with its defaults instead.
 */
export function template(body: string, now = new Date()): string | null {
  if (/[#$]\{/.test(body)) return null;
  if (![...body.matchAll(BLANK)].some((m) => !m[1])) return null;
  // As in src/blanks.ts: a name, a default after `|`, or choices after `:` split by `/` (the first is shown).
  const first = new Map<string, string>();
  return `${body.replace(BLANK, (whole, esc: string | undefined, inner: string, dflt: string | undefined) => {
    if (esc) return whole.slice(1);
    const colon = inner.indexOf(":");
    const choices = colon > 0 ? inner.slice(colon + 1).split("/").map((c) => c.trim()).filter(Boolean) : [];
    const name = choices.length >= 2 ? inner.slice(0, colon).trim() : inner;
    if (name.toLowerCase() === "today" && dflt === undefined && choices.length < 2) return today(now);
    if (!first.has(name)) first.set(name, (dflt ?? choices[0] ?? "") || name);
    return `\${${first.get(name)!.replace(/[{}]/g, "")}}`;
  })}\${}`;
}

/** `{{today}}` as src/blanks.ts writes it: `19 November 2026`. */
function today(now: Date): string {
  return now.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/** What copying a card gives: a snippet without its `;trigger` line. */
export function copyBody(n: { folder: string; title: string; body: string }): string {
  const top = n.folder.split("/")[0].toLowerCase();
  return (top === "snippets" ? snippetOf(n.title, n.body).body : n.body).replace(/\n+$/, "");
}
