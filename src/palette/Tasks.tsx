// Open tasks: every unticked `- [ ]` in every note, rendered right inside the workspace list pane beside the
// selected task's live note (no modal trap!). Tasks with a day (`@fri`, `@nov20`) come first under Overdue, Today,
// This week and Later; the rest are grouped by note. x ticks one in its file with undo; clicking or Enter selects
// its note right beside the list so you never lose your place.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type OpenTask } from "../api";
import { dayTitle, dueGroup, dueOf, JOURNAL, listName, today, type DueGroup } from "../journal/days";
import { folderName, say, typing } from "../ui";

const GROUPS: Record<DueGroup, string> = { overdue: "Overdue", today: "Today", week: "This week", later: "Later" };
const writtenOn = (t: OpenTask) => (t.folder === JOURNAL && /^\d{4}-\d{2}-\d{2}$/.test(t.title) ? new Date(`${t.title}T12:00`) : new Date(t.modifiedAt));

export default function Tasks(p: {
  /** Bumped when notes change so open tasks refresh. */
  rev?: number;
  /** Currently open note id, highlighted in the task list. */
  activeNoteId?: number | null;
  onSelect(noteId: number): void;
  onTicked(noteId: number): void;
  onClose?: () => void;
}) {
  let input!: HTMLInputElement;
  const [tasks, setTasks] = createSignal<OpenTask[] | null>(null);
  const [q, setQ] = createSignal("");
  const [i, setI] = createSignal(0);

  const load = async () => {
    try {
      const list = await (await api()).openTasks();
      setTasks(list);
      // Select the first task's note automatically if no note is open yet
      if (!p.activeNoteId && list.length) p.onSelect(list[0].noteId);
    } catch (e) {
      setTasks([]);
      say(errText(e), { error: true });
    }
  };
  onMount(() => void load());
  createEffect(on(() => p.rev, () => void load(), { defer: true }));

  const due = (t: OpenTask) => dueOf(t.text, writtenOn(t));
  const shown = createMemo(() => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    const all = (tasks() ?? []).filter((t) => words.every((w) => `${t.text} ${t.title} ${t.folder}`.toLowerCase().includes(w)));
    const dated = all.filter((t) => due(t)).sort((a, b) => due(a)!.localeCompare(due(b)!));
    return [...dated, ...all.filter((t) => !due(t))];
  });
  const groups = createMemo(() => {
    const now = today();
    const out: { key: string; noteId: number | null; title: string; folder: string; rows: { t: OpenTask; k: number }[] }[] = [];
    shown().forEach((t, k) => {
      const d = due(t);
      const key = d ? dueGroup(d, now) : `n${t.noteId}`;
      const last = out[out.length - 1];
      if (last?.key === key) last.rows.push({ t, k });
      else if (d) out.push({ key, noteId: null, title: GROUPS[key as DueGroup], folder: "", rows: [{ t, k }] });
      else out.push({ key, noteId: t.noteId, title: t.title, folder: t.folder, rows: [{ t, k }] });
    });
    return out;
  });

  async function tick(t: OpenTask | undefined) {
    if (!t) return;
    const s = await api();
    try {
      const token = await s.tickTask(t.noteId, t.line, t.text);
      setTasks((ts) => (ts ?? []).filter((x) => x !== t));
      setI((k) => Math.min(k, Math.max(0, shown().length - 1)));
      p.onTicked(t.noteId);
      say(`Ticked “${t.text.slice(0, 40)}”`, {
        undo: () =>
          s.undo(token.token).then(() => {
            p.onTicked(t.noteId);
            return load();
          }),
      });
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (document.querySelector(".scrim") || e.altKey) return;
    if (typing(e)) {
      if (e.target === input && (e.key === "ArrowDown" || e.key === "Enter")) {
        e.preventDefault();
        input.blur();
        const t = shown()[0];
        if (t) (setI(0), p.onSelect(t.noteId));
      } else if (e.target === input && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setQ("");
        input.blur();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    const n = shown().length;
    if (e.key === "ArrowDown" || e.key === "j") {
      if (!n) return;
      const next = (i() + 1) % n;
      setI(next);
      p.onSelect(shown()[next].noteId);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      if (!n) return;
      const next = (i() + n - 1) % n;
      setI(next);
      p.onSelect(shown()[next].noteId);
    } else if (e.key === "x") {
      void tick(shown()[i()]);
    } else if (e.key === "/") {
      input.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <section class="ws-list tasks-pane" aria-label="Open tasks">
      <div class="ws-list-head">
        <h2>Open tasks</h2>
        <span class="muted small">{tasks() ? shown().length : ""}</span>
      </div>
      <label class="lib-filter ws-filter">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input ref={input} placeholder="Filter tasks…" aria-label="Filter open tasks" value={q()} onInput={(e) => (setQ(e.currentTarget.value), setI(0))} />
        <kbd>/</kbd>
      </label>
      <div class="ws-list-rows">
        <For each={groups()}>
          {(g) => (
            <section class="task-group">
              <Show
                when={g.noteId !== null}
                fallback={
                  <h4 class="task-due" classList={{ overdue: g.key === "overdue" }}>
                    {g.title}
                  </h4>
                }
              >
                <button type="button" class="task-note" onClick={() => p.onSelect(g.noteId!)}>
                  <span>{g.folder === "inbox" ? "A capture" : listName(g)}</span>
                  <span class="row-sub">{folderName(g.folder)}</span>
                </button>
              </Show>
              <For each={g.rows}>
                {(r) => (
                  <div
                    class="ws-task-row"
                    classList={{ on: r.k === i() || p.activeNoteId === r.t.noteId }}
                    onClick={() => (setI(r.k), p.onSelect(r.t.noteId))}
                  >
                    <button
                      type="button"
                      class="task-box"
                      title="Tick task (x)"
                      aria-label={`Tick ${r.t.text}`}
                      onClick={(e) => (e.stopPropagation(), void tick(r.t))}
                    />
                    <div class="ws-task-body">
                      <span class="ws-task-text">{r.t.text}</span>
                      <Show when={g.noteId === null}>
                        <span class="ws-task-sub">
                          {dayTitle(due(r.t)!)} · {r.t.folder === "inbox" ? "capture" : listName(r.t)}
                        </span>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </section>
          )}
        </For>
        <Show when={tasks() && !shown().length}>
          <p class="muted pad">{q() ? "No open task matches." : "No open tasks. Every box is ticked."}</p>
        </Show>
      </div>
    </section>
  );
}
