// History (`Ctrl H`): the open note's versions, newest first, and what each had compared with the text now.
// Restore puts a version back; the text it replaces is kept as a version first, so nothing is ever lost.

import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { api, errText, type NoteVersion } from "../api";
import { ago, say } from "../ui";
import { counts, diff } from "./diff";

export function reasonLabel(reason: string): string {
  return (
    { edit: "While writing", ai: "Before an AI change", restore: "Before a restore", merge: "Before a capture was added" }[reason] ?? reason
  );
}

export default function Versions(p: { noteId: number; title: string; current: string; onRestored(): void; onClose(): void }) {
  const [list] = createResource(async () => (await api()).noteVersions(p.noteId));
  const [at, setAt] = createSignal(0);
  const sel = (): NoteVersion | undefined => list()?.[at()];
  const [text] = createResource(sel, async (v) => (await api()).noteVersionText(v.id));
  const parts = createMemo(() => (text() == null ? [] : diff(text()!, p.current)));
  const summary = createMemo(() => counts(parts()));

  async function restore() {
    const v = sel();
    if (!v) return;
    try {
      await (await api()).restoreNoteVersion(p.noteId, v.id);
      say("Restored. The text it replaced is in History.");
      p.onRestored();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  const key = (e: KeyboardEvent) => {
    const n = list()?.length ?? 0;
    if (e.key === "Escape" || (e.ctrlKey && e.key.toLowerCase() === "h")) p.onClose();
    else if (e.key === "ArrowDown" || e.key === "j") setAt(Math.min(at() + 1, n - 1));
    else if (e.key === "ArrowUp" || e.key === "k") setAt(Math.max(at() - 1, 0));
    else if (e.key === "Enter" || e.key === "r") void restore();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("keydown", key, true);
  onCleanup(() => document.removeEventListener("keydown", key, true));

  return (
    <div class="scrim top" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="history panel" role="dialog" aria-label="History">
        <div class="history-list">
          <h3>History</h3>
          <p class="muted small">{p.title}</p>
          <Show when={list()?.length} fallback={<p class="muted pad">No versions yet. Petrel keeps one every few minutes of writing, and before every AI change.</p>}>
            <For each={list()}>
              {(v, i) => (
                <button class="history-row" classList={{ on: i() === at() }} onClick={() => setAt(i())}>
                  <span>{reasonLabel(v.reason)}</span>
                  <span class="muted">{ago(v.createdAt)}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
        <div class="history-body">
          <div class="history-head">
            <Show when={sel()}>
              <span class="muted small">
                {summary().del} words would come back, {summary().add} would go
              </span>
            </Show>
            <span class="grow" />
            <button class="btn" onClick={p.onClose}>
              Close <kbd>Esc</kbd>
            </button>
            <button class="btn primary" disabled={!sel()} onClick={restore}>
              Restore <kbd>Enter</kbd>
            </button>
          </div>
          <div class="diff">
            <For each={parts()}>{(x) => <span class={x.kind}>{x.text}</span>}</For>
          </div>
        </div>
      </div>
    </div>
  );
}
