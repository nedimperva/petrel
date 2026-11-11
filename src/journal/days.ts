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
