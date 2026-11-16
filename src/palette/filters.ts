// A few words in Ctrl K that narrow what is found: `in:travel`, `is:pinned`, `when:today`, `when:week`,
// `has:link`, `has:picture`, `has:task`. The rest of the text is searched as before. Plain words that look like
// a filter ("today", "week", "inbox", "pinned") stay words, so "week plan" finds the note; they are offered as a
// filter instead (`offers`), which Tab turns on (`acceptOffer`). Pure, for `npm test`.

import type { NoteSummary } from "../api";

export interface Filters {
  words: string;
  folder: string | null;
  pinned: boolean;
  /** Changed since this moment (ms). */
  since: number | null;
  has: ("link" | "picture" | "task")[];
  /** Plain words that could be a filter, and the filter each would be: Tab takes the first. */
  offers: { word: string; filter: string; label: string }[];
}

export const noFilters = (f: Filters) => !f.folder && !f.pinned && f.since === null && !f.has.length;

const OFFERS: { re: RegExp; filter: string; label: string }[] = [
  { re: /(^|\s)(pinned)(?=\s|$)/i, filter: "is:pinned", label: "only pinned notes" },
  { re: /(^|\s)(this\s+week|week)(?=\s|$)/i, filter: "when:week", label: "changed this week" },
  { re: /(^|\s)(today)(?=\s|$)/i, filter: "when:today", label: "changed today" },
  { re: /(^|\s)(inbox)(?=\s|$)/i, filter: "in:inbox", label: "only the inbox" },
];

/** The query with the first offer turned into its filter. */
export function acceptOffer(q: string): string {
  for (const o of OFFERS) {
    const m = o.re.exec(q);
    if (m) return (q.slice(0, m.index) + m[1] + o.filter + q.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim() + " ";
  }
  return q;
}

export function parseFilters(q: string, now = new Date()): Filters {
  const f: Filters = { words: "", folder: null, pinned: false, since: null, has: [], offers: [] };
  const midnight = (back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).getTime();
  let rest = ` ${q} `;
  const take = (re: RegExp, then: (m: RegExpExecArray) => void) => {
    for (let m = re.exec(rest); m; m = re.exec(rest)) {
      then(m);
      rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
      re.lastIndex = 0;
    }
  };
  take(/\s(?:in|folder):("[^"]+"|\S+)(?=\s)/i, (m) => (f.folder = m[1].replace(/"/g, "")));
  take(/\shas:(link|links|picture|pictures|image|task|tasks|todo)(?=\s)/i, (m) => {
    const w = m[1].toLowerCase();
    const h = w.startsWith("link") ? "link" : w.startsWith("task") || w === "todo" ? "task" : "picture";
    if (!f.has.includes(h)) f.has.push(h);
  });
  take(/\sis:pinned(?=\s)/i, () => (f.pinned = true));
  take(/\swhen:(?:this-?)?week(?=\s)/i, () => (f.since = midnight(6)));
  take(/\swhen:today(?=\s)/i, () => (f.since = midnight(0)));
  f.words = rest.replace(/\s+/g, " ").trim();
  for (const o of OFFERS) {
    const m = o.re.exec(f.words);
    if (m) f.offers.push({ word: m[2], filter: o.filter, label: o.label });
  }
  return f;
}

/** Whether a note's folder is the one asked for: its top folder, by name, any case; `in:travel/mostar` as a path. */
export function inFolder(folder: string, want: string): boolean {
  const w = want.toLowerCase().replace(/\/+$/, "");
  const f = folder.toLowerCase();
  return f === w || f.startsWith(`${w}/`) || (!w.includes("/") && f.split("/")[0].startsWith(w));
}

export function keep(n: NoteSummary, f: Filters): boolean {
  if (f.folder && !inFolder(n.folder, f.folder)) return false;
  if (f.pinned && !n.pinned) return false;
  if (f.since !== null && n.modifiedAt < f.since) return false;
  return true;
}
