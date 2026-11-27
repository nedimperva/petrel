// Days for the journal: today's page is `journal/YYYY-MM-DD.md` in the local time zone. Pure, so `npm test` can
// check it.

export const JOURNAL = "journal";

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of a moment, in local time. */
export function dayOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const today = () => dayOf(new Date());

/** Local midnight of a `YYYY-MM-DD`, or null when it is not one. */
export function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dayOf(d) === s.trim() ? d : null;
}

export function addDays(day: string, n: number): string {
  const d = parseDay(day) ?? new Date();
  return dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/** True for a note that is a day's page. */
export const isDayNote = (folder: string, title: string) => folder === JOURNAL && parseDay(title) !== null;

/** `Wednesday, 11 November` (the year too when it is not this one). */
export function dayTitle(day: string, now = new Date()): string {
  const d = parseDay(day);
  if (!d) return day;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** A day as a list names it: `Today · Fri 27 Nov`, `Yesterday · Thu 26 Nov`, `Tomorrow · …`, else `Mon 23 Nov`
 * (the year too when it is not this one). The file stays `journal/2026-11-27.md`; only the words change. */
export function dayName(day: string, now = new Date()): string {
  const d = parseDay(day);
  if (!d) return day;
  const short = d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).replace(",", "");
  const off = Math.round((d.getTime() - parseDay(dayOf(now))!.getTime()) / 86_400_000);
  const near = off === 0 ? "Today" : off === -1 ? "Yesterday" : off === 1 ? "Tomorrow" : "";
  return near ? `${near} · ${short}` : short;
}

/** A note's name in a list: a day's page by its day, any other note by its title. */
export const listName = (n: { folder: string; title: string }, now = new Date()) =>
  isDayNote(n.folder, n.title) ? dayName(n.title, now) : n.title;

/** `21:14` now. */
export function clock(d = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The days of a month as a calendar grid, Monday first: null for the blanks before the first. */
export function monthGrid(day: string): (string | null)[] {
  const d = parseDay(day) ?? new Date();
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const out: (string | null)[] = Array(lead).fill(null);
  for (let i = 1; i <= days; i++) out.push(dayOf(new Date(d.getFullYear(), d.getMonth(), i)));
  return out;
}

/** The last seven days up to now: from local midnight six days ago. */
export function lastWeek(now = new Date()): { from: number; to: number; label: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const fmt = (x: Date) => x.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return { from: start.getTime(), to: now.getTime() + 1, label: `${fmt(start)} to ${fmt(now)}` };
}

/** ISO week name for the week page's file: `2026-W46`. */
export function isoWeek(now = new Date()): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${pad(week)}`;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** A month by its name or its first three letters or more (`nov`, `novem`). */
function monthOf(w: string): number {
  return w.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(w)) : -1;
}

/** The day a capture word names: `today`, `tomorrow`, `yesterday`, a weekday (`fri`, `friday`: the next one,
 * not today), a date (`nov20`, `20nov`, `2026-11-20`). A date more than a month gone is next year's. Null when the
 * word is not a day. */
export function dayWord(word: string, now = new Date()): string | null {
  if (parseDay(word)) return word;
  const w = word.toLowerCase().replace(/[-_.]/g, "");
  const base = dayOf(now);
  if (w === "today") return base;
  if (w === "tomorrow" || w === "tmrw" || w === "tmr") return addDays(base, 1);
  if (w === "yesterday") return addDays(base, -1);
  if (w.length >= 3) {
    const wd = WEEKDAYS.findIndex((d) => d.startsWith(w));
    if (wd >= 0 && !/\d/.test(w)) {
      const ahead = (wd - now.getDay() + 7) % 7 || 7;
      return addDays(base, ahead);
    }
  }
  const m = /^([a-z]+)(\d{1,2})$/.exec(w) ?? /^(\d{1,2})([a-z]+)$/.exec(w);
  if (!m) return null;
  const [name, num] = /\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
  const month = monthOf(name);
  const day = Number(num);
  if (month < 0 || day < 1 || day > 31) return null;
  let d = new Date(now.getFullYear(), month, day);
  if (d.getMonth() !== month) return null;
  if (now.getTime() - d.getTime() > 31 * 86400000) d = new Date(now.getFullYear() + 1, month, day);
  return dayOf(d);
}

/** Day words to offer while `#…` is typed: the words that start with it, or the date it already names. */
export function dayOptions(typed: string, now = new Date()): { word: string; day: string }[] {
  const w = typed.toLowerCase();
  const words = ["today", "tomorrow", "yesterday", ...WEEKDAYS.map((d) => d.slice(0, 3))];
  const out: { word: string; day: string }[] = [];
  for (const x of words) {
    const full = WEEKDAYS.find((d) => d.startsWith(x)) ?? x;
    if (w && !(x.startsWith(w) || full.startsWith(w))) continue;
    out.push({ word: w.length > 3 && full.startsWith(w) ? full : x, day: dayWord(x, now)! });
  }
  const exact = !out.length && w ? dayWord(w, now) : null;
  if (exact) out.push({ word: typed, day: exact });
  return w ? out.slice(0, 4) : out.slice(0, 2);
}

/** The day a task is due: an `@word` in it that names a day (`@fri`, `@nov20`, `@2026-11-20`, `@tomorrow`). A
 * weekday or "tomorrow" counts from `written`: the day of the page it is on, or when its note last changed. */
export function dueOf(text: string, written: Date): string | null {
  for (const m of text.matchAll(/(?:^|\s)@([\p{L}\d-]+)/gu)) {
    const d = dayWord(m[1], written);
    if (d) return d;
  }
  return null;
}

export type DueGroup = "overdue" | "today" | "week" | "later";

/** Where a due day falls from `today`: before it, on it, in the next six days, or after. */
export function dueGroup(due: string, today: string): DueGroup {
  if (due < today) return "overdue";
  if (due === today) return "today";
  return due <= addDays(today, 6) ? "week" : "later";
}

const BARE_STAMP = /^\d{1,2}:\d{2}[ \t]*$/;
const ANY_STAMP = /^(\d{1,2}):(\d{2})(?=\s|$)/;

/** Minutes since midnight for a `HH:MM` stamp, or null if invalid. */
export function stampMinutes(text: string): number | null {
  const m = ANY_STAMP.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h < 24 && min >= 0 && min < 60 ? h * 60 + min : null;
}

/** A day's page as it is saved: a time with nothing after it (followed by blank line or EOF) is left out,
 * while a standalone time immediately above a content line (like a task `- [ ] …`) is kept. */
export function dropBareStamps(text: string): string {
  if (!/^\d{1,2}:\d{2}[ \t]*$/m.test(text)) return text;
  const lines = text.split("\n");
  const kept = lines.filter((l, idx) => {
    if (!BARE_STAMP.test(l)) return true;
    const next = lines[idx + 1];
    return next !== undefined && next.trim().length > 0 && !ANY_STAMP.test(next);
  });
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  return out ? `${out}\n` : "";
}

/** Minutes since midnight of the last non-bare entry stamp in a day's body, or null if none. */
export function lastEntryMinutes(body: string): number | null {
  const lines = body.split("\n");
  let last: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = ANY_STAMP.exec(l);
    if (!m) continue;
    const hasInline = l.slice(m[0].length).trim().length > 0;
    const next = lines[i + 1];
    const hasBelow = !hasInline && next !== undefined && next.trim().length > 0 && !ANY_STAMP.test(next);
    if (hasInline || hasBelow) {
      const mins = stampMinutes(m[0]);
      if (mins !== null) last = mins;
    }
  }
  return last;
}

/** Whether returning to today's page should open a fresh live entry: true when no entry exists yet or at least
 * `gapMinutes` have elapsed since the last entry's stamp (default 5 min). */
export function shouldStartFreshEntry(body: string, now = new Date(), gapMinutes = 5): boolean {
  if (!body.trim()) return true;
  const last = lastEntryMinutes(body);
  if (last === null) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  const diff = cur - last;
  return diff < 0 || diff >= gapMinutes;
}

/** The seven days of the week `day` is in, Monday first. */
export function weekOf(day: string): string[] {
  const d = parseDay(day) ?? new Date();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => dayOf(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)));
}

/** What a day's page holds, for the line under its heading: entries written (a time with words after it, or
 * immediately above a content line), tasks ticked, and captures filed onto it. From the text alone. */
export function dayTally(text: string): { entries: number; done: number; captures: number } {
  let entries = 0;
  let done = 0;
  let captures = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\d{1,2}:\d{2}\s+\S/.test(line)) entries++;
    else if (BARE_STAMP.test(line) && lines[i + 1]?.trim() && !ANY_STAMP.test(lines[i + 1])) entries++;
    if (/^\s*[-*+] \[[xX]\]/.test(line)) done++;
    if (line.trim() === "_from capture_") captures++;
  }
  return { entries, done, captures };
}

/** `3 entries · 2 tasks done · 1 capture`, leaving out what is none. */
export function tallyLine(t: { entries: number; done: number; captures: number }): string {
  const n = (k: number, one: string, many: string) => (k ? `${k} ${k === 1 ? one : many}` : "");
  return [n(t.entries, "entry", "entries"), n(t.done, "task done", "tasks done"), n(t.captures, "capture", "captures")].filter(Boolean).join(" · ");
}
