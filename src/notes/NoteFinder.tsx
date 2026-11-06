// `Ctrl P`: find a note by title, from drafts or notes. `Enter` opens it, `Ctrl Enter` makes a note with the title
// typed, `Esc` goes back.

import { createSignal, For, onMount, Show } from "solid-js";
import { api, type NoteSummary } from "../api";

interface Props {
  onOpen(id: number): void;
  onCreate(title: string): void;
  onClose(): void;
}

export default function NoteFinder(props: Props) {
  let input!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [found, setFound] = createSignal<NoteSummary[]>([]);
  const [at, setAt] = createSignal(0);
  let generation = 0;

  async function find(text: string) {
    setQuery(text);
    const mine = ++generation;
    try {
      const rows = await (await api).findNotes(text, 12);
      if (mine === generation) {
        setFound(rows);
        setAt(0);
      }
    } catch {
      if (mine === generation) setFound([]);
    }
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") return e.preventDefault(), props.onClose();
    if (e.key === "Enter" && (ctrl || !found().length)) {
      e.preventDefault();
      if (query().trim()) props.onCreate(query().trim());
      return;
    }
    if (e.key === "Enter") return e.preventDefault(), props.onOpen(found()[at()].id);
    const step = e.key === "ArrowDown" || (ctrl && e.key === "j") ? 1 : e.key === "ArrowUp" || (ctrl && e.key === "k") ? -1 : 0;
    if (step) {
      e.preventDefault();
      setAt((i) => Math.max(0, Math.min(found().length - 1, i + step)));
    }
  }

  onMount(async () => {
    input.focus();
    try {
      await (await api).scanNotes();
    } catch {
      // The index from last time still finds most notes.
    }
    await find("");
  });

  return (
    <div class="scrim palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="palette finder" role="dialog" aria-label="Find a note" onKeyDown={onKey}>
        <input ref={input} class="palette-input" placeholder="Find a note" aria-label="Note title" onInput={(e) => find(e.currentTarget.value)} />
        <div class="palette-body" role="listbox">
          <For each={found()}>
            {(n, i) => (
              <button role="option" aria-selected={i() === at()} classList={{ "palette-row": true, at: i() === at() }} onClick={() => props.onOpen(n.id)} onMouseMove={() => setAt(i())}>
                <span class="name">{n.title}</span>
                <span class="grow" />
                <span class="meta">{n.folder || "Notes"}</span>
              </button>
            )}
          </For>
          <Show when={query().trim()}>
            <button class="palette-row create" onClick={() => props.onCreate(query().trim())}>
              <span class="name">Create note “{query().trim()}”</span>
              <span class="grow" />
              <kbd>Ctrl Enter</kbd>
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
