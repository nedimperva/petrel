// Promote a draft (`Ctrl Shift N`): a new note file, or the draft added to the end of a note. Either way the draft
// keeps its text and goes to the Archive pointing at the note; Undo puts everything back.

import { createSignal, For, onMount, Show } from "solid-js";
import { api, type Draft, type NoteChange, type NoteFolder, type NoteSummary } from "../api";

const FOLDER_KEY = "petrel.notes.promoteFolder";

interface Props {
  draft: Draft;
  mode: "new" | "append";
  onDone(c: NoteChange, mode: "new" | "append"): void;
  onClose(): void;
}

function lastFolder(): string {
  try {
    return localStorage.getItem(FOLDER_KEY) ?? "";
  } catch {
    return "";
  }
}

export default function Promote(props: Props) {
  let titleEl: HTMLInputElement | undefined;
  let findEl: HTMLInputElement | undefined;
  const [mode, setMode] = createSignal(props.mode);
  const [folders, setFolders] = createSignal<NoteFolder[]>([]);
  const [folder, setFolder] = createSignal(lastFolder());
  const [title, setTitle] = createSignal(props.draft.title);
  const [keepTags, setKeepTags] = createSignal(true);
  const [found, setFound] = createSignal<NoteSummary[]>([]);
  const [at, setAt] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function find(text: string) {
    try {
      setFound(await (await api).findNotes(text, 8));
      setAt(0);
    } catch {
      setFound([]);
    }
  }

  function pick(m: "new" | "append") {
    setMode(m);
    setError(null);
    queueMicrotask(() => (m === "new" ? titleEl?.focus() : findEl?.focus()));
  }

  async function go() {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const a = await api;
      if (mode() === "new") {
        try {
          localStorage.setItem(FOLDER_KEY, folder());
        } catch {
          // Remembering the folder is a convenience.
        }
        props.onDone(await a.promoteDraft(props.draft.id, folder(), title(), keepTags()), "new");
      } else {
        const target = found()[at()];
        if (!target) return setError("Pick a note to add to.");
        props.onDone(await a.appendToNote(props.draft.id, target.id, keepTags()), "append");
      }
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") return e.preventDefault(), props.onClose();
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) return e.preventDefault(), void go();
    if (mode() === "append" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setAt((i) => Math.max(0, Math.min(found().length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
    }
  }

  const path = () => {
    const t = title().trim() || "Untitled";
    return `${folder() ? `${folder()}/` : ""}${t}.md`;
  };

  onMount(async () => {
    try {
      const a = await api;
      await a.scanNotes();
      setFolders(await a.noteFolders());
      await find("");
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
    pick(props.mode);
  });

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="dialog promote" role="dialog" aria-label="Promote to note" onKeyDown={onKey}>
        <div class="dialog-head">
          <strong>Keep as a note</strong>
          <span class="meta">The draft goes to the Archive with a link to the note. Its text stays as it is.</span>
        </div>
        <div class="segmented" role="group" aria-label="Where the text goes">
          <button classList={{ on: mode() === "new" }} onClick={() => pick("new")}>
            New note
          </button>
          <button classList={{ on: mode() === "append" }} onClick={() => pick("append")}>
            Add to a note
          </button>
        </div>
        <Show when={mode() === "new"}>
          <label>
            Title
            <input ref={titleEl} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          </label>
          <label>
            Folder
            <select value={folder()} onChange={(e) => setFolder(e.currentTarget.value)}>
              <option value="">Top of the notes folder</option>
              <For each={folders()}>
                {(f) => <option value={f.path}>{`${"  ".repeat(f.depth)}${f.name}`}</option>}
              </For>
            </select>
          </label>
          <span class="meta path">{path()}</span>
        </Show>
        <Show when={mode() === "append"}>
          <label>
            Note
            <input ref={findEl} placeholder="Find a note by title" onInput={(e) => find(e.currentTarget.value)} />
          </label>
          <div class="pick-list" role="listbox" aria-label="Notes">
            <For each={found()} fallback={<span class="meta">No notes match.</span>}>
              {(n, i) => (
                <button role="option" aria-selected={i() === at()} classList={{ at: i() === at() }} onClick={() => setAt(i())}>
                  <span class="grow">{n.title}</span>
                  <span class="meta">{n.folder || "Notes"}</span>
                </button>
              )}
            </For>
          </div>
          <span class="meta">Added at the end, under a line with the date and time.</span>
        </Show>
        <Show when={props.draft.tags.length}>
          <label class="check">
            <input type="checkbox" checked={keepTags()} onChange={(e) => setKeepTags(e.currentTarget.checked)} />
            Keep the tags ({props.draft.tags.map((t) => `#${t}`).join(" ")})
          </label>
        </Show>
        <Show when={error()}>
          <span class="error">{error()}</span>
        </Show>
        <div class="dialog-foot">
          <button onClick={props.onClose}>
            Cancel <kbd>Esc</kbd>
          </button>
          <button class="primary" disabled={busy()} onClick={go}>
            {mode() === "new" ? "Promote" : "Add"} <kbd>Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
