// Sending a capture with a word: `#recipes` files it in that collection, `#today` on today's page (`#fri`,
// `#tomorrow`, `#nov20` on that day's), `>Groceries` adds it to the end of that note. The word is taken out of the
// text. Pure, for `npm test`; the capture window does the looking up and passes `dayWord` (journal/days.ts).

export interface Token {
  sign: "#" | ">";
  word: string;
  from: number;
  to: number;
}

/** The `#word` and `>word` in a text, outside code. `# Heading` (with a space) and `> quote` are Markdown, not words. */
export function tokens(text: string): Token[] {
  const out: Token[] = [];
  let fence = false;
  let at = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) {
      const code = codeSpans(line);
      const re = /(^|\s)([#>])([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        const from = m.index + m[1].length;
        if (code.some(([a, b]) => from >= a && from < b)) continue;
        out.push({ sign: m[2] as "#" | ">", word: m[3], from: at + from, to: at + from + 1 + m[3].length });
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

/** The token being typed just before the cursor, for the suggestion list. */
export function typingToken(lineBefore: string): { sign: "#" | ">"; word: string; back: number } | null {
  const m = /(?:^|\s)([#>])([\p{L}\p{N}_-]*)$/u.exec(lineBefore);
  if (!m) return null;
  return { sign: m[1] as "#" | ">", word: m[2], back: m[2].length + 1 };
}

export type Route = { kind: "folder"; folder: string } | { kind: "day"; date: string } | { kind: "note"; title: string };

/** Which typed token routes the capture: the last one that names a collection, a day, or a note title (case
 * does not matter; a note's title may use spaces where the word has `-`). A collection named like a day wins,
 * except over `#today`. */
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
    if (t.sign === "#") {
      const day = dayWord(w);
      if (w === "today" && day) return { route: { kind: "day", date: day }, token: t };
      const f = folders.find((x) => !x.includes("/") && low(x) === w);
      if (f) return { route: { kind: "folder", folder: f }, token: t };
      if (day) return { route: { kind: "day", date: day }, token: t };
    } else {
      const n = noteTitles.find((x) => low(x) === w || low(x).replace(/\s+/g, "-") === w);
      if (n) return { route: { kind: "note", title: n }, token: t };
    }
  }
  return null;
}
