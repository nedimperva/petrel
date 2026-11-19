// A day's page (journal/YYYY-MM-DD.md): the week over the title, the month on request, and in the margin the
// day's calendar, the tasks still open from earlier days, what is due and what was captured. Split from
// NotePage.tsx, which owns the text; this owns what is around it on a day.

import { createEffect, createSignal, For, on, Show, type Accessor } from "solid-js";
import { api, errText, type CalEvent, type Note, type OpenTask } from "../api";
import type { EditorHandle } from "../editor/editor";
import { addDays, clock, dayTitle, dueOf, JOURNAL, monthGrid, today, weekOf } from "../journal/days";
import { keyLabel } from "../keys";
import { Kbd, say } from "../ui";

export function createDay(o: { dayPage: Accessor<string | null>; note: Accessor<Note | null>; editor: () => EditorHandle | undefined }) {
  const dayPage = o.dayPage;
  const note = o.note;
  // The days that have a page, for the month. A signal, not a resource: a resource read here would suspend the
  // whole page (App's Suspense) on every day change and take the focus out of the text.
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

  /** The month grid, on request: the week strip over the title is enough to step between days. */
  const [showMonth, setShowMonth] = createSignal(false);
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

  // On today's page: tasks still open on earlier days' pages, and how many captures came in today.
  const [carried, setCarried] = createSignal<OpenTask[]>([]);
  /** Tasks in any note due today or before (`@fri`, `@nov20`), for today's margin. */
  const [dueNow, setDueNow] = createSignal<{ t: OpenTask; due: string }[]>([]);
  const [capturedToday, setCapturedToday] = createSignal(0);
  createEffect(
    on(
      () => (dayPage() === today() ? `${note()?.id ?? ""}` : null),
      (k) => {
        if (k === null) return setCarried([]);
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
  /** A task from an earlier day comes onto today's page: out of its note, onto the end of this one. */
  async function bringHere(t: OpenTask) {
    try {
      const s = await api();
      const tok = await s.takeTask(t.noteId, t.line, t.text);
      setCarried(carried().filter((x) => x !== t));
      setDueNow(dueNow().filter((x) => x.t !== t));
      o.editor()?.insert(`- [ ] ${t.text}`, false);
      say(`Moved here from ${t.folder === JOURNAL ? dayTitle(t.title) : t.title}`, { undo: () => s.undo(tok.token) });
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function tickCarried(t: OpenTask) {
    try {
      const s = await api();
      const tok = await s.tickTask(t.noteId, t.line, t.text);
      setCarried(carried().filter((x) => x !== t));
      say(`Ticked on ${dayTitle(t.title)}`, { undo: () => s.undo(tok.token).then(() => setCarried([t, ...carried()])) });
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  return { journal, showMonth, setShowMonth, events, writeUnder, carried, dueNow, capturedToday, bringHere, tickCarried };
}

export type DayState = ReturnType<typeof createDay>;

export function DayHead(p: { day: string; state: DayState; onDay(day: string): void }) {
  return (
        <div class="day-head">
          <div class="day-week" role="group" aria-label="This week">
            <For each={weekOf(p.day)}>
              {(x) => (
                <button
                  type="button"
                  class="week-day"
                  classList={{ on: x === p.day, has: p.state.journal().has(x), today: x === today(), future: x > today() }}
                  aria-label={dayTitle(x)}
                  aria-current={x === p.day ? "date" : undefined}
                  onClick={() => p.onDay(x)}
                >
                  <span class="week-wd">{new Date(`${x}T12:00`).toLocaleDateString(undefined, { weekday: "short" })}</span>
                  <span class="week-n">{Number(x.slice(8))}</span>
                </button>
              )}
            </For>
            <button type="button" class="link small week-month" aria-expanded={p.state.showMonth()} onClick={() => p.state.setShowMonth(!p.state.showMonth())}>
              {p.state.showMonth() ? "Hide the month" : "Month"}
            </button>
          </div>
          <h1 class="day-title">{dayTitle(p.day)}</h1>
          <span class="day-nav">
            <button class="icon-btn" title="The day before (Alt ←)" aria-label="The day before" onClick={() => p.onDay(addDays(p.day, -1))}>
              ‹
            </button>
            <Show when={p.day !== today()}>
              <button class="link small" onClick={() => p.onDay(today())}>
                Today
              </button>
            </Show>
            <button class="icon-btn" title="The day after (Alt →)" aria-label="The day after" onClick={() => p.onDay(addDays(p.day, 1))}>
              ›
            </button>
          </span>
        </div>
  );
}

export function DayMargin(p: { day: string; state: DayState; onDay(day: string): void; onOpen(id: number): void }) {
  return (
    <>
          <Show when={p.state.events().length}>
            <section class="day-cal" aria-label="Calendar">
              <h4>Calendar</h4>
              <For each={p.state.events()}>
                {(e) => (
                  <button type="button" class="cal-row" title="Write under it" onMouseDown={(ev) => ev.preventDefault()} onClick={() => p.state.writeUnder(e)}>
                    <span class="cal-time">{e.start || "all day"}</span>
                    <span class="cal-title">{e.title}</span>
                  </button>
                )}
              </For>
            </section>
          </Show>
          <Show when={p.state.showMonth() ? p.day : null}>
            {(d) => (
              <section class="day-month" aria-label="This month">
                <div class="day-month-name">{new Date(`${d()}T12:00`).toLocaleDateString(undefined, { month: "long" })}</div>
            <div class="day-grid">
              <For each={["M", "T", "W", "T", "F", "S", "S"]}>{(w) => <span class="day-wd">{w}</span>}</For>
              <For each={monthGrid(d())}>
                {(x) =>
                  x ? (
                    <button
                      class="day-cell"
                      classList={{ on: x === d(), has: p.state.journal().has(x), future: x > today() }}
                      aria-label={dayTitle(x)}
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
            )}
          </Show>
          <Show when={p.day === today() && p.state.carried().length}>
            <section class="day-carried" aria-label="Still open from earlier days">
              <h4>Still open</h4>
              <For each={p.state.carried()}>
                {(t) => (
                  <label class="carried-row">
                    <input type="checkbox" onChange={() => void p.state.tickCarried(t)} />
                    <span class="carried-text">{t.text.replace(/^\s*[-*]\s+\[ \]\s*/, "")}</span>
                    <button type="button" class="carried-day" onClick={() => p.onDay(t.title)} title={`Open ${dayTitle(t.title)}`}>
                      {new Date(`${t.title}T12:00`).toLocaleDateString(undefined, { weekday: "short" })}
                    </button>
                    <button type="button" class="carried-bring" onClick={(e) => (e.preventDefault(), void p.state.bringHere(t))} title="Move it onto today's page">
                      ↓ here
                    </button>
                  </label>
                )}
              </For>
            </section>
          </Show>
          <Show when={p.day === today() && p.state.dueNow().length}>
            <section class="day-carried" aria-label="Due today">
              <h4>Due</h4>
              <For each={p.state.dueNow()}>
                {(x) => (
                  <div class="carried-row">
                    <span class="carried-text" classList={{ overdue: x.due < today() }}>
                      {x.t.text}
                    </span>
                    <button type="button" class="carried-day" onClick={() => p.onOpen(x.t.noteId)} title={`Open ${x.t.title}`}>
                      {x.due < today() ? dayTitle(x.due) : x.t.folder === JOURNAL ? dayTitle(x.t.title) : x.t.title.slice(0, 16)}
                    </button>
                  </div>
                )}
              </For>
            </section>
          </Show>
          <Show when={p.day === today() && p.state.capturedToday()}>
            {(k) => (
              <section aria-label="Captured today">
                <h4>Captured today</h4>
                <p class="muted small">
                  {k()} in the inbox. <Kbd keys={keyLabel("library")} /> to file them.
                </p>
              </section>
            )}
          </Show>
    </>
  );
}
