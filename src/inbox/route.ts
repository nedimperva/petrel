// Where a capture goes, said with one sign: `@recipes` files it in that collection, `@today`, `@fri`, `@nov20`
// on that day's page, `@Groceries` (or `@trip-to-mostar`) adds it to the end of that note. `#` stays a heading and
// `>` a quote: they never route. The word is taken out of the text. Pure, for `npm test`; the capture window does
// the looking up and passes `dayWord` (journal/days.ts).

export interface Token {
  word: string;
  from: number;
  to: number;
}

/** The `@word`s in a text, outside code. An address like `ana@example.com` has no space before the `@`. */
export function tokens(text: string): Token[] {
  const out: Token[] = [];
  let fence = false;
  let at = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) {
      const code = codeSpans(line);
      const re = /(^|\s)@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        const from = m.index + m[1].length;
        if (code.some(([a, b]) => from >= a && from < b)) continue;
        out.push({ word: m[2], from: at + from, to: at + from + 1 + m[2].length });
      }
    }
    at += line.length + 1;
  }
  return out;
}

function codeSpans(line: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /`[^`]*`/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** The text without the token, and without the space it leaves behind. */
export function strip(text: string, t: { from: number; to: number }): string {
  let { from, to } = t;
  if (text[to] === " ") to++;
  else if (from > 0 && text[from - 1] === " ") from--;
  return text.slice(0, from) + text.slice(to);
}

/** The `@word` being typed just before the cursor, for the suggestion list. */
export function typingToken(lineBefore: string): { word: string; back: number } | null {
  const m = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(lineBefore);
  if (!m) return null;
  return { word: m[1], back: m[1].length + 1 };
}

export type Route = { kind: "folder"; folder: string } | { kind: "day"; date: string } | { kind: "note"; title: string };

/** Which `@word` routes the capture: the last one that names something. In order: `@today`, a collection, a day,
 * a note title (case does not matter; a title may use spaces where the word has `-`). */
export function pickRoute(
  text: string,
  folders: string[],
  noteTitles: string[],
  dayWord: (word: string) => string | null,
): { route: Route; token: Token } | null {
  const low = (s: string) => s.toLowerCase();
  const found = tokens(text);
  for (let i = found.length - 1; i >= 0; i--) {
    const t = found[i];
    const w = low(t.word);
    const day = dayWord(w);
    if (w === "today" && day) return { route: { kind: "day", date: day }, token: t };
    const f = folders.find((x) => !x.includes("/") && low(x) === w);
    if (f) return { route: { kind: "folder", folder: f }, token: t };
    if (day) return { route: { kind: "day", date: day }, token: t };
    const n = noteTitles.find((x) => low(x) === w || low(x).replace(/\s+/g, "-") === w);
    if (n) return { route: { kind: "note", title: n }, token: t };
  }
  return null;
}
