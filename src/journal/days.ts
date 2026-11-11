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
