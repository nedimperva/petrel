// Fill-in blanks in collection items: `{{name}}` in a prompt or snippet is asked for when it is copied. The same
// name twice is asked once. `{{name|default}}` starts filled. `\{{` is a literal brace pair. A few fill
// themselves: `{{clipboard}}`, `{{today}}` and `{{selection}}` (what was selected in the app you were in, from the
// picker). `{{tone: formal / casual / blunt}}` is a choice, picked with the number keys.

export type Auto = "clipboard" | "today" | "selection";

export interface Blank {
  name: string;
  /** What the field starts with: the default, or the first choice. */
  value: string;
  /** For `{{name: a / b / c}}`. */
  choices?: string[];
  /** Fills itself when the field opens, unless it has a default. */
  auto?: Auto;
}

const RE = /(\\)?\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;
const AUTO: Auto[] = ["clipboard", "today", "selection"];

/** `tone: a / b` → the name and its choices; anything else is just a name. */
function parse(inner: string): { name: string; choices?: string[] } {
  const at = inner.indexOf(":");
  if (at > 0) {
    const choices = inner
      .slice(at + 1)
      .split("/")
      .map((c) => c.trim())
      .filter(Boolean);
    if (choices.length >= 2) return { name: inner.slice(0, at).trim(), choices };
  }
  return { name: inner };
}

/** The blanks in order of first use. */
export function blanks(text: string): Blank[] {
  const seen = new Map<string, Blank>();
  for (const m of text.matchAll(RE)) {
    if (m[1]) continue;
    const { name, choices } = parse(m[2]);
    if (seen.has(name)) continue;
    const b: Blank = { name, value: m[3] ?? choices?.[0] ?? "" };
    if (choices) b.choices = choices;
    const auto = AUTO.find((a) => a === name.toLowerCase());
    if (auto && m[3] === undefined && !choices) b.auto = auto;
    seen.set(name, b);
  }
  return [...seen.values()];
}

/** The text with each blank replaced; a blank with no value keeps its `{{name}}`, so nothing silently vanishes. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(RE, (whole, escaped: string | undefined, inner: string, dflt: string | undefined) => {
    if (escaped) return whole.slice(1);
    const { name, choices } = parse(inner);
    const v = values[name] ?? dflt ?? choices?.[0];
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
    out.push({ text: parse(m[2]).name, blank: true });
    at = i + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), blank: false });
  return out;
}

/** `{{today}}`: the date as it is written, `11 November 2026`. */
export function todayText(now = new Date()): string {
  return now.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/** What the field starts with: its default, then what fills itself, then the last answer, then nothing. */
export function startValue(b: Blank, last: string[] | undefined, auto: Partial<Record<Auto, string>>): string {
  if (b.auto) return auto[b.auto] ?? "";
  if (b.choices) return last?.find((l) => b.choices!.includes(l)) ?? b.value;
  return b.value || last?.[0] || "";
}

/** The last answers for each blank after a copy: the new one first, five kept, the self-filling ones left out. */
export function rememberAnswers(
  memory: Record<string, string[]>,
  list: Blank[],
  values: Record<string, string>,
  keep = 5,
): Record<string, string[]> {
  const out = { ...memory };
  for (const b of list) {
    const v = (values[b.name] ?? "").trim();
    if (b.auto || !v || v.length > 2000) continue;
    out[b.name] = [v, ...(out[b.name] ?? []).filter((x) => x !== v)].slice(0, keep);
  }
  return out;
}
