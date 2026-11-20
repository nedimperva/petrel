// A day's page (journal/YYYY-MM-DD.md): a clean date heading with tally and `+ Entry` over the text, and in the
// right margin a simple month calendar chooser, the day's schedule, unified Carry-over & Due tasks, and a clickable
// Captured today card. Split from NotePage.tsx, which owns the text.

import { createEffect, createMemo, createSignal, For, on, Show, type Accessor } from "solid-js";
import { api, errText, type CalEvent, type Note, type OpenTask } from "../api";
import type { EditorHandle } from "../editor/editor";
import { addDays, clock, dayOf, dayTitle, dueOf, JOURNAL, monthGrid, parseDay, today } from "../journal/days";
import { keyLabel } from "../keys";
import { Kbd, say } from "../ui";

export interface MarginTask {
  t: OpenTask;
  overdue: boolean;
  badge: string;
  isJournal: boolean;
}

function shiftMonth(iso: string, delta: number): string {
  const d = parseDay(iso) ?? new Date();
  return dayOf(new Date(d.getFullYear(), d.getMonth() + delta, 1));
}

export function createDay(o: { dayPage: Accessor<string | null>; note: Accessor<Note | null>; editor: () => EditorHandle | undefined }) {
  const dayPage = o.dayPage;
  const note = o.note;
  // The days that have a page, for the calendar dots. Signals, not resources (avoids App's Suspense).
  const [journal, setJournal] = createSignal<Set<string>>(new Set());
  createEffect(
    on(
      () => (dayPage() ? `${dayPage()}:${note()?.id ?? ""}` : null),
      (k) => {
        if (k)
          void api()
            .then((s) => s.listNotes({ folder: JOURNAL, limit: 1000 }))
            .then((ns) => setJournal(new Set(ns.map((n) => n.title))), () => {});
      },
    ),
  );

  /** The day's events from Google Calendar, when it is turned on (Settings › Sync). */
  const [events, setEvents] = createSignal<CalEvent[]>([]);
  createEffect(
    on(dayPage, (d) => {
      setEvents([]);
      if (d) void api().then((s) => s.calendarDay(d)).then((e) => dayPage() === d && setEvents(e), () => {});
    }),
  );

  /** An event becomes an entry at the end of the page, its time and title, the cursor after it for notes. */
  function writeUnder(e: CalEvent) {
    const v = o.editor()?.view;
    if (!v) return;
    const doc = v.state.doc.toString();
    // The fresh time line at the end (nothing after it) gives way to the event's line.
    const bare = /\n*\d{1,2}:\d{2}[ \t]*$/.exec(doc);
    const from = bare ? bare.index : doc.length;
    const before = doc.slice(0, from).replace(/\s+$/, "");
    const line = `${e.start || clock()} **${e.title}** `;
    const insert = `${before ? "\n\n" : ""}${line}`;
    v.dispatch({ changes: { from: before.length, to: doc.length, insert }, selection: { anchor: before.length + insert.length }, scrollIntoView: true, userEvent: "input" });
    v.focus();
  }

  // On today's page: tasks still open on earlier days' pages, tasks due today/overdue, and today's inbox count.
  const [carried, setCarried] = createSignal<OpenTask[]>([]);
  const [dueNow, setDueNow] = createSignal<{ t: OpenTask; due: string }[]>([]);
  const [capturedToday, setCapturedToday] = createSignal(0);

  createEffect(
    on(
      () => (dayPage() === today() ? `${note()?.id ?? ""}` : null),
      (k) => {
        if (k === null) {
          setCarried([]);
          setDueNow([]);
          setCapturedToday(0);
          return;
        }
        void api().then(async (s) => {
          const [tasks, inbox] = await Promise.all([s.openTasks().catch(() => []), s.listNotes({ folder: "inbox", limit: 1000 }).catch(() => [])]);
          setCarried(
            tasks
              .filter((t) => t.folder === JOURNAL && t.title < today())
              .sort((a, b) => b.title.localeCompare(a.title) || a.line - b.line)
              .slice(0, 8),
          );
          const written = (t: OpenTask) => (t.folder === JOURNAL && /^\d{4}-\d{2}-\d{2}$/.test(t.title) ? new Date(`${t.title}T12:00`) : new Date(t.modifiedAt));
          setDueNow(
            tasks
              .filter((t) => !(t.folder === JOURNAL && t.title === today()))
              .map((t) => ({ t, due: dueOf(t.text, written(t)) ?? "" }))
              .filter((x) => x.due && x.due <= today())
              .sort((a, b) => a.due.localeCompare(b.due))
              .slice(0, 8),
          );
          const start = new Date();
          start.setHours(0, 0, 0, 0);
          setCapturedToday(inbox.filter((n) => n.modifiedAt >= start.getTime()).length);
        });
      },
    ),
  );

  /** Unified Carry-over & Due list (overdue/due first, then earlier days, deduplicated by noteId:line). */
  const openList = createMemo((): MarginTask[] => {
    const out: MarginTask[] = [];
    const seen = new Set<string>();
    const td = today();
    for (const x of dueNow()) {
      const k = `${x.t.noteId}:${x.t.line}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const overdue = x.due < td;
      const where = x.t.folder === JOURNAL ? new Date(`${x.t.title}T12:00`).toLocaleDateString(undefined, { weekday: "short" }) : x.t.title.slice(0, 18);
      out.push({
        t: x.t,
        overdue,
        badge: overdue ? `Overdue · ${new Date(`${x.due}T12:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : `Due today · ${where}`,
        isJournal: x.t.folder === JOURNAL,
      });
    }
    for (const t of carried()) {
      const k = `${t.noteId}:${t.line}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        t,
        overdue: false,
        badge: new Date(`${t.title}T12:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }),
        isJournal: true,
      });
    }
    return out.slice(0, 10);
  });

  /** A task from an earlier day or another note comes onto today's page. */
  async function bringHere(t: OpenTask) {
    try {
      const s = await api();
      const tok = await s.takeTask(t.noteId, t.line, t.text);
      setCarried(carried().filter((x) => !(x.noteId === t.noteId && x.line === t.line)));
      setDueNow(dueNow().filter((x) => !(x.t.noteId === t.noteId && x.t.line === t.line)));
      const clean = t.text.replace(/^\s*[-*+]\s+\[ \]\s*/, "");
      o.editor()?.insert(`- [ ] ${clean}`, false);
      say(`Moved here from ${t.folder === JOURNAL ? dayTitle(t.title) : t.title}`, { undo: () => s.undo(tok.token) });
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function tickTask(t: OpenTask) {
    try {
      const s = await api();
      const tok = await s.tickTask(t.noteId, t.line, t.text);
      setCarried(carried().filter((x) => !(x.noteId === t.noteId && x.line === t.line)));
      setDueNow(dueNow().filter((x) => !(x.t.noteId === t.noteId && x.t.line === t.line)));
      say(`Ticked on ${t.folder === JOURNAL ? dayTitle(t.title) : t.title}`, { undo: () => s.undo(tok.token) });
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  return { journal, events, writeUnder, openList, capturedToday, bringHere, tickTask };
}

export type DayState = ReturnType<typeof createDay>;

export function DayHead(p: { day: string; tally: string; state: DayState; onDay(day: string): void; onNewEntry(): void }) {
  return (
    <div class="day-head">
      <div class="day-heading-row">
        <div class="day-heading-text">
          <h1 class="day-title">{dayTitle(p.day)}</h1>
          <div class="day-sub">
            <span>{p.tally || (p.day === today() ? "Fresh page — starts saving when you write" : "No entries yet")}</span>
            <Show when={p.day !== today()}>
              <button type="button" class="link small" onClick={() => p.onDay(today())}>
                Back to Today
              </button>
            </Show>
          </div>
        </div>
        <span class="day-nav">
          <Show when={p.day === today()}>
            <button
              type="button"
              class="btn small day-new-entry"
              title="Start a new timestamped entry (Ctrl Enter)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={p.onNewEntry}
            >
              + Entry <kbd>Ctrl ↵</kbd>
            </button>
          </Show>
          <button type="button" class="icon-btn" title="The day before (Alt ←)" aria-label="The day before" onClick={() => p.onDay(addDays(p.day, -1))}>
            ‹
          </button>
          <button type="button" class="icon-btn" title="The day after (Alt →)" aria-label="The day after" onClick={() => p.onDay(addDays(p.day, 1))}>
            ›
          </button>
        </span>
      </div>
    </div>
  );
}

export function DayMargin(p: { day: string; state: DayState; onDay(day: string): void; onOpen(id: number): void; onInbox(): void }) {
  const [viewedMonth, setViewedMonth] = createSignal(p.day);
  createEffect(on(() => p.day, (d) => setViewedMonth(d)));

  const monthTitle = () =>
    new Date(`${viewedMonth()}T12:00`).toLocaleDateString(undefined, {
      month: "long",
      year: viewedMonth().slice(0, 4) === today().slice(0, 4) ? undefined : "numeric",
    });

  return (
    <>
      <section class="day-month-box" aria-label="Calendar">
        <div class="day-month-head">
          <span class="day-month-name">{monthTitle()}</span>
          <span class="day-month-nav">
            <Show when={viewedMonth().slice(0, 7) !== today().slice(0, 7) || p.day !== today()}>
              <button type="button" class="link small" onClick={() => (setViewedMonth(today()), p.onDay(today()))}>
                Today
              </button>
            </Show>
            <button type="button" class="day-month-step" aria-label="Previous month" title="Previous month" onClick={() => setViewedMonth(shiftMonth(viewedMonth(), -1))}>
              ‹
            </button>
            <button type="button" class="day-month-step" aria-label="Next month" title="Next month" onClick={() => setViewedMonth(shiftMonth(viewedMonth(), 1))}>
              ›
            </button>
          </span>
        </div>
        <div class="day-grid">
          <For each={["M", "T", "W", "T", "F", "S", "S"]}>{(w) => <span class="day-wd">{w}</span>}</For>
          <For each={monthGrid(viewedMonth())}>
            {(x) =>
              x ? (
                <button
                  type="button"
                  class="day-cell"
                  classList={{ on: x === p.day, has: p.state.journal().has(x), today: x === today(), future: x > today() }}
                  aria-label={dayTitle(x)}
                  aria-current={x === p.day ? "date" : undefined}
                  onClick={() => p.onDay(x)}
                >
                  {Number(x.slice(8))}
                </button>
              ) : (
                <span />
              )
            }
          </For>
        </div>
      </section>

      <Show when={p.state.events().length}>
        <section class="day-cal" aria-label="Schedule">
          <h4>Schedule</h4>
          <For each={p.state.events()}>
            {(e) => (
              <button type="button" class="cal-row" title="Click to start meeting notes under this time" onMouseDown={(ev) => ev.preventDefault()} onClick={() => p.state.writeUnder(e)}>
                <span class="cal-time">{e.start || "all day"}</span>
                <span class="cal-title">{e.title}</span>
                <span class="cal-add">+ note</span>
              </button>
            )}
          </For>
        </section>
      </Show>
      <Show when={p.day === today() && p.state.openList().length}>
        <section class="day-carried" aria-label="Carry-over and due tasks">
          <div class="day-sec-head">
            <h4>Carry-over &amp; due</h4>
            <span class="muted small">{p.state.openList().length}</span>
          </div>
          <For each={p.state.openList()}>
            {(item) => (
              <div class="carried-item">
                <input type="checkbox" aria-label={`Mark done: ${item.t.text}`} onChange={() => void p.state.tickTask(item.t)} />
                <div class="carried-body">
                  <span class="carried-text" classList={{ overdue: item.overdue }}>
                    {item.t.text.replace(/^\s*[-*+]\s+\[ \]\s*/, "")}
                  </span>
                  <span class="carried-sub">
                    <button
                      type="button"
                      class="carried-src"
                      classList={{ overdue: item.overdue }}
                      onClick={() => (item.isJournal ? p.onDay(item.t.title) : p.onOpen(item.t.noteId))}
                      title={`Open ${item.isJournal ? dayTitle(item.t.title) : item.t.title}`}
                    >
                      {item.badge}
                    </button>
                    <button type="button" class="carried-bring" onClick={() => void p.state.bringHere(item.t)} title="Move onto today's page">
                      ↓ bring to today
                    </button>
                  </span>
                </div>
              </div>
            )}
          </For>
        </section>
      </Show>
      <Show when={p.day === today() && p.state.capturedToday()}>
        {(k) => (
          <section aria-label="Captured today">
            <h4>Captured today</h4>
            <button type="button" class="day-inbox-card" onClick={p.onInbox}>
              <span>
                <b>{k()}</b> {k() === 1 ? "capture" : "captures"} waiting in Inbox
              </span>
              <Kbd keys={keyLabel("library")} />
            </button>
          </section>
        )}
      </Show>
    </>
  );
}
