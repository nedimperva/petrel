// How the command bar ranks what you type against a name. Small and predictable rather than clever: a name that
// starts with the query beats one with a word that does, then initials ("nd" → "New draft"), then a name that
// contains the query, then letters found in order.

/** 0 when `query` does not match `name`; higher is better. An empty query matches everything with 1. */
export function score(query: string, name: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const n = name.toLowerCase();
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
