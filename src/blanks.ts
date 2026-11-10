// Fill-in blanks in collection items: `{{name}}` in a prompt or snippet is asked for when it is copied. The same
// name twice is asked once. `{{name|default}}` starts filled. `\{{` is a literal brace pair.

export interface Blank {
  name: string;
  /** What the field starts with. */
  value: string;
}

const RE = /(\\)?\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;

/** The blanks in order of first use. */
export function blanks(text: string): Blank[] {
  const seen = new Map<string, Blank>();
  for (const m of text.matchAll(RE)) {
    if (m[1]) continue;
    const name = m[2];
    if (!seen.has(name)) seen.set(name, { name, value: m[3] ?? "" });
  }
  return [...seen.values()];
}

/** The text with each blank replaced; a blank with no value keeps its `{{name}}`, so nothing silently vanishes. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(RE, (whole, escaped: string | undefined, name: string, dflt: string | undefined) => {
    if (escaped) return whole.slice(1);
    const v = values[name] ?? dflt;
    return v === undefined || v === "" ? `{{${name}}}` : v;
  });
}

/** Text with the blanks marked, for drawing chips: alternating plain text and blank names. */
export function parts(text: string): { text: string; blank: boolean }[] {
  const out: { text: string; blank: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(RE)) {
    if (m[1]) continue;
    const i = m.index ?? 0;
    if (i > at) out.push({ text: text.slice(at, i), blank: false });
    out.push({ text: m[2], blank: true });
    at = i + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), blank: false });
  return out;
}
