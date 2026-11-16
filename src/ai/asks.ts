// What you typed into Ctrl J before ("make it formal", "translate to English"), offered again like blanks
// remember their answers. Newest first, each once, at most eight. Kept in the `ui.asks` setting by NotePage.
// Pure, for `npm test`.

export const ASKS_KEY = "ui.asks";
const MAX = 8;

export function parseAsks(raw: string | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** The list with `ask` first; the same words in another case count as the same ask. */
export function addAsk(list: string[], ask: string): string[] {
  const a = ask.trim().replace(/\s+/g, " ");
  if (!a) return list;
  return [a, ...list.filter((x) => x.toLowerCase() !== a.toLowerCase())].slice(0, MAX);
}
