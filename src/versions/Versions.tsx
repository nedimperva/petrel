// History (`Ctrl H` or Inspector › History): the open note's versions, newest first, with a word-level diff
// against the current text. Renders inline inside the unified Inspector drawer (never hiding the note behind a
// modal) or standalone if `inline` is false. Restore keeps the replaced text as a version first.

import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { api, errText, type NoteVersion } from "../api";
import { ago, Kbd, say } from "../ui";
import { counts, diff } from "./diff";

export function reasonLabel(reason: string): string {
  return (
    { edit: "While writing", ai: "Before an AI change", restore: "Before a restore", merge: "Before a capture was added" }[reason] ?? reason
  );
}

export default function Versions(p: { noteId: number; title: string; current: string; inline?: boolean; onRestored(): void; onClose(): void }) {
  const [list, { refetch }] = createResource(
    () => p.noteId,
    async (id) => (await api()).noteVersions(id),
  );
  const [at, setAt] = createSignal(0);
  createEffect(on(() => p.noteId, () => setAt(0)));
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
      void refetch();
      p.onRestored();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  const key = (e: KeyboardEvent) => {
    if (p.inline) return;
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

  if (p.inline) {
    return (
      <div class="insp-history">
        <Show
          when={list() === undefined || list()!.length}
          fallback={
            <div class="insp-empty">
              <p>No versions yet.</p>
              <p class="muted small">Kept automatically after a few minutes of writing, and before any AI change.</p>
            </div>
          }
        >
          <div class="insp-ver-list">
            <For each={list()}>
              {(v, i) => (
                <button type="button" class="history-row" classList={{ on: i() === at() }} onClick={() => setAt(i())}>
                  <span>{reasonLabel(v.reason)}</span>
                  <span class="muted">{ago(v.createdAt)}</span>
                </button>
              )}
            </For>
          </div>
          <Show when={sel()}>
            <div class="insp-diff-head">
              <span class="muted small">
                +{summary().del} / −{summary().add} words
              </span>
              <span class="grow" />
              <button type="button" class="btn small primary" onClick={restore}>
                Restore
              </button>
            </div>
            <div class="diff insp-diff">
              <For each={parts()}>{(x) => <span class={x.kind}>{x.text}</span>}</For>
            </div>
          </Show>
        </Show>
      </div>
    );
  }

  return (
    <div class="scrim top" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <Show
        when={list() === undefined || list()!.length}
        fallback={
          <div class="history-none panel" role="dialog" aria-label="History">
            <h3>No versions yet</h3>
            <p>The first is kept after a few minutes of writing, and before any AI change.</p>
            <span class="history-none-keys">
              <Kbd keys="Esc" /> back
            </span>
          </div>
        }
      >
        <div class="history panel" role="dialog" aria-label="History">
          <div class="history-list">
            <h3>History</h3>
            <p class="muted small">{p.title}</p>
            <For each={list()}>
              {(v, i) => (
                <button class="history-row" classList={{ on: i() === at() }} onClick={() => setAt(i())}>
                  <span>{reasonLabel(v.reason)}</span>
                  <span class="muted">{ago(v.createdAt)}</span>
                </button>
              )}
            </For>
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
      </Show>
    </div>
  );
}
