// Open tasks: every unticked `- [ ]` in every note (the engine reads them all, not only recent ones), grouped by
// note, the most recently changed first. x ticks one in its file (z or the toast puts it back), Enter opens the
// note, typing narrows the list.

import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { api, errText, type OpenTask } from "../api";
import { folderName, KeyHints, say } from "../ui";

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

  const shown = createMemo(() => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    return (tasks() ?? []).filter((t) => words.every((w) => `${t.text} ${t.title} ${t.folder}`.toLowerCase().includes(w)));
  });
  /** Rows by note, in the order the engine gave (newest note first). */
  const groups = createMemo(() => {
    const out: { noteId: number; title: string; folder: string; rows: { t: OpenTask; k: number }[] }[] = [];
    shown().forEach((t, k) => {
      const last = out[out.length - 1];
      if (last?.noteId === t.noteId) last.rows.push({ t, k });
      else out.push({ noteId: t.noteId, title: t.title, folder: t.folder, rows: [{ t, k }] });
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
                <button class="task-note" onClick={() => (p.onClose(), p.onOpen(g.noteId))}>
                  <span>{g.folder === "inbox" ? "A capture" : g.title}</span>
                  <span class="row-sub">{folderName(g.folder)}</span>
                </button>
                <For each={g.rows}>
                  {(r) => (
                    <div class="palette-row task-row" classList={{ on: r.k === i() }} onMouseMove={() => setI(r.k)}>
                      <button class="task-box" title="Tick it (x)" aria-label={`Tick ${r.t.text}`} onClick={() => void tick(r.t)} />
                      <span class="row-label" onClick={() => (p.onClose(), p.onOpen(r.t.noteId))}>
                        {r.t.text}
                      </span>
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
