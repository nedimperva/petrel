// How the command bar ranks what you type against a name. Small and predictable rather than clever: a name that
// starts with the query beats one with a word that does, then initials ("nd" → "New draft"), then a name that
// contains the query, then a word with one typo, then letters found in order. Case and accents never matter
// (`fold`), the same rule the engine uses for note titles.

// Kept in this file (no imports) so the tests can load it as it is.

const FOLD_MAP: Record<string, string> = { đ: "d", ď: "d", ł: "l", ß: "ss", ø: "o" };

/** Lower case, accents off, đ and dj as d. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[đďłßø]/g, (c) => FOLD_MAP[c])
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/dj/g, "d");
}

/** Whether `typed` is `word`, or its start, with at most one letter wrong, missing, extra or swapped. */
export function near(typed: string, word: string): boolean {
  if (typed.length < 4) return word.startsWith(typed);
  for (let len = typed.length - 1; len <= Math.min(typed.length + 1, word.length); len++) {
    if (edits(typed, word.slice(0, len)) <= 1) return true;
  }
  return false;
}

/** Damerau–Levenshtein distance (optimal string alignment), small inputs only. */
function edits(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** 0 when `query` does not match `name`; higher is better. An empty query matches everything with 1. */
export function score(query: string, name: string): number {
  const q = fold(query.trim());
  if (!q) return 1;
  const n = fold(name);
  if (n === q) return 100;
  if (n.startsWith(q)) return 80 - Math.min(n.length - q.length, 20) / 2;
  const word = n.search(new RegExp(`(^|[\\s\\-_/.:#])${escape(q)}`));
  if (word >= 0) return 60 - Math.min(word, 20) / 2;
  // Initials: "nd" is New Draft, ahead of a name that merely contains "nd" (Find).
  const initials = n
    .split(/[\s\-_/.:#]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("");
  if (!q.includes(" ") && initials.startsWith(q)) return 50;
  if (n.includes(q)) return 40;
  // A slip of the finger: each typed word within one edit of a word of the name.
  const qw = q.split(/[\s\-_/.:#]+/).filter(Boolean);
  const nw = n.split(/[\s\-_/.:#]+/).filter(Boolean);
  if (qw.some((w) => w.length >= 4) && qw.every((w) => nw.some((x) => near(w, x)))) return 25;
  // Letters in order, each one preferably at a word start.
  let at = 0;
  let starts = 0;
  let gaps = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = n.indexOf(ch, at);
    if (i < 0) return 0;
    if (i === 0 || /[\s\-_/.:#]/.test(n[i - 1])) starts++;
    gaps += i - at;
    at = i + 1;
  }
  // Letters strewn across a long name are chance, not a match: "petrel" is in "put back a deleted note, or empty
  // the old" letter by letter. Keep it only when the letters sit close or mostly start words.
  const letters = q.replace(/ /g, "").length;
  if (letters > 2 && gaps > letters * 2 && starts * 2 < letters) return 0;
  return 10 + starts * 4 - Math.min(gaps, 20) / 4;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Items that match, best first; ties keep their order (so a caller's recents or grouping stay put). */
export function rank<T>(query: string, items: T[], name: (t: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i, s: score(query, name(item)) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.item);
}

/** The recents list after using `key`: it moves to the front, the list keeps at most `max`. */
export function pushRecent(recent: string[], key: string, max = 8): string[] {
  return [key, ...recent.filter((k) => k !== key)].slice(0, max);
}
