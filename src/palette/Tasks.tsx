// Open tasks: every unticked `- [ ]` in every note (the engine reads them all, not only recent ones). Tasks with a
// day (`@fri`, `@nov20`) come first, under Overdue, Today, This week and Later; the rest are grouped by note, the
// most recently changed first. x ticks one in its file (z or the toast puts it back), Enter opens the
// note, typing narrows the list.

import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { api, errText, type OpenTask } from "../api";
import { folderName, KeyHints, say } from "../ui";
import { dayTitle, dueGroup, dueOf, JOURNAL, listName, today, type DueGroup } from "../journal/days";

const GROUPS: Record<DueGroup, string> = { overdue: "Overdue", today: "Today", week: "This week", later: "Later" };

/** When a task was written, for its weekday words: the day of its page, or when its note last changed. */
const writtenOn = (t: OpenTask) => (t.folder === JOURNAL && /^\d{4}-\d{2}-\d{2}$/.test(t.title) ? new Date(`${t.title}T12:00`) : new Date(t.modifiedAt));

export default function Tasks(p: { onClose(): void; onOpen(id: number): void; onTicked(noteId: number): void }) {
  let input!: HTMLInputElement;
  const [tasks, setTasks] = createSignal<OpenTask[] | null>(null);
  const [q, setQ] = createSignal("");
  const [i, setI] = createSignal(0);

  const load = async () => {
    try {
      setTasks(await (await api()).openTasks());
    } catch (e) {
      setTasks([]);
      say(errText(e), { error: true });
    }
  };
  onMount(() => {
    input.focus();
    void load();
  });

  const due = (t: OpenTask) => dueOf(t.text, writtenOn(t));
  /** Dated tasks first, soonest first; then the rest in the engine's order (newest note first). */
  const shown = createMemo(() => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    const all = (tasks() ?? []).filter((t) => words.every((w) => `${t.text} ${t.title} ${t.folder}`.toLowerCase().includes(w)));
    const dated = all.filter((t) => due(t)).sort((a, b) => due(a)!.localeCompare(due(b)!));
    return [...dated, ...all.filter((t) => !due(t))];
  });
  /** Rows under a day group (Overdue, Today…) or, without a day, under their note. */
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

  const key = (e: KeyboardEvent) => {
    const n = shown().length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setI((i() + 1) % Math.max(1, n));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setI((i() + n - 1) % Math.max(1, n));
    else if (e.key === "Enter") {
      const t = shown()[i()];
      if (t) (p.onClose(), p.onOpen(t.noteId));
    } else if (e.key === "Escape") p.onClose();
    // x ticks; with words typed, Ctrl X does (x is a letter you may be typing).
    else if ((e.key === "x" && !q()) || (e.ctrlKey && e.key.toLowerCase() === "x")) void tick(shown()[i()]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class="scrim top" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="palette tasks" role="dialog" aria-label="Open tasks">
        <div class="palette-field">
          <span class="spark">☐</span>
          <input class="palette-input" ref={input} placeholder="Open tasks in every note. Type to narrow…" value={q()} onInput={(e) => (setQ(e.currentTarget.value), setI(0))} onKeyDown={key} />
          <span class="muted small nowrap">{tasks() ? `${shown().length} open` : ""}</span>
        </div>
        <div class="palette-list">
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
                  <button class="task-note" onClick={() => (p.onClose(), p.onOpen(g.noteId!))}>
                    <span>{g.folder === "inbox" ? "A capture" : listName(g)}</span>
                    <span class="row-sub">{folderName(g.folder)}</span>
                  </button>
                </Show>
                <For each={g.rows}>
                  {(r) => (
                    <div class="palette-row task-row" classList={{ on: r.k === i() }} onMouseMove={() => setI(r.k)}>
                      <button class="task-box" title="Tick it (x)" aria-label={`Tick ${r.t.text}`} onClick={() => void tick(r.t)} />
                      <span class="row-label" onClick={() => (p.onClose(), p.onOpen(r.t.noteId))}>
                        {r.t.text}
                      </span>
                      <Show when={g.noteId === null}>
                        <span class="row-sub">
                          {dayTitle(due(r.t)!)} · {r.t.folder === "inbox" ? "a capture" : listName(r.t)}
                        </span>
                      </Show>
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
          <Show when={tasks() && !shown().length}>
            <p class="muted pad">{q() ? "No open task has those words." : "No open tasks. Every box is ticked."}</p>
          </Show>
        </div>
        <footer class="picker-foot">
          <KeyHints hints={[["↑ ↓", "move"], ["x", "tick"], ["Enter", "open the note"]]} />
          <span class="grow" />
          <KeyHints hints={[["Esc", "back"]]} />
        </footer>
      </div>
    </div>
  );
}
