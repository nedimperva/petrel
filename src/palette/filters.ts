// A few words in Ctrl K that narrow what is found: `in:travel`, `pinned`, `today`, `this week`, `has:link`,
// `has:picture`, `has:task`. The rest of the text is searched as before. Pure, for `npm test`.

import type { Note, NoteSummary } from "../api";

export interface Filters {
  words: string;
  folder: string | null;
  pinned: boolean;
  /** Changed since this moment (ms). */
  since: number | null;
  has: ("link" | "picture" | "task")[];
}

export const noFilters = (f: Filters) => !f.folder && !f.pinned && f.since === null && !f.has.length;

export function parseFilters(q: string, now = new Date()): Filters {
  const f: Filters = { words: "", folder: null, pinned: false, since: null, has: [] };
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
  take(/\s(?:is:)?pinned(?=\s)/i, () => (f.pinned = true));
  take(/\s(?:this\s+)?week(?=\s)/i, () => (f.since = midnight(6)));
  take(/\stoday(?=\s)/i, () => (f.since = midnight(0)));
  take(/\sinbox(?=\s)/i, () => (f.folder = "inbox"));
  f.words = rest.replace(/\s+/g, " ").trim();
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

/** The `has:` checks need the text, not the preview. */
export function hasAll(n: Note, has: Filters["has"]): boolean {
  return has.every((h) =>
    h === "link" ? /\[\[[^\]]+\]\]/.test(n.body) : h === "picture" ? /!\[[^\]]*\]\([^)]+\)/.test(n.body) : /^\s*[-*+] \[ \]/m.test(n.body),
  );
}
