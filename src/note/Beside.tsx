// A note beside: a second note on the right of the one you write in (Ctrl \, or Shift Enter on a [[link]]). It
// is read-only until you click into it, so a stray key never lands in the wrong note; then it saves like the
// page does. One at a time; Esc closes it. The same note is never open on both sides (two savers would make
// conflict copies of each other).

import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type Note } from "../api";
import { createEditor, type EditorHandle } from "../editor/editor";
import { cleanPaste } from "../editor/paste";
import { linkExtensions } from "../notes/links";
import { createNoteSaver, type SaveState } from "../notes/saver";
import { folderName, say } from "../ui";

export interface BesideHandle {
  flush(): Promise<boolean>;
  id(): number;
}

export default function Beside(p: {
  id: number;
  onClose(): void;
  /** Make it the main note. */
  onSwap(id: number): void;
  /** A link followed inside it opens in its place. */
  onFollow(id: number): void;
  ref(h: BesideHandle): void;
}) {
  let host!: HTMLDivElement;
  let editor: EditorHandle | undefined;
  const [note, setNote] = createSignal<Note | null>(null);
  const [save, setSave] = createSignal<SaveState>("saved");
  const [editing, setEditing] = createSignal(false);
  const saver = createNoteSaver({
    store: api,
    editor: () => editor,
    note,
    setNote,
    setSave,
    fresh: () => ({ folder: note()?.folder ?? "", title: note()?.title ?? "Untitled" }),
    conflict: (path) => say(`This note was also changed elsewhere. That copy is kept as ${path}.`, { error: true }),
  });

  const load = async (id: number) => {
    await saver.flush();
    try {
      const n = await (await api()).openNote(id);
      // Loading focuses the editor; the main note keeps the focus.
      const had = document.activeElement as HTMLElement | null;
      saver.load(n);
      editor?.setReadOnly(true);
      setEditing(false);
      editor?.view.contentDOM.blur();
      if (had && had !== document.body && !host.contains(had)) had.focus();
    } catch (e) {
      say(errText(e), { error: true });
      p.onClose();
    }
  };

  onMount(() => {
    editor = createEditor(host, () => saver.changed(), { placeholder: "" });
    editor.setExtra([
      cleanPaste(() => say("Pasted as Markdown. Ctrl Z for plain text.")),
      linkExtensions({
        open: async (inner) => {
          const r = await (await api()).resolveLink(inner);
          if (r.kind === "note") p.onFollow(r.id);
        },
        resolve: async (inner) => (await api()).resolveLink(inner),
        preview: async (r) => {
          if (r.kind !== "note") return null;
          const n = await (await api()).peekNote(r.id);
          return { title: n.title, where: folderName(n.folder), text: n.body.slice(0, 280) };
        },
        targets: async (text) => (await api()).linkTargets(text, 12),
      }),
    ]);
    editor.setReadOnly(true);
    p.ref({ flush: () => saver.flush(), id: () => p.id });
    void load(p.id);
  });
  onCleanup(() => {
    void saver.flush();
    editor?.destroy();
  });

  // Another note sent beside: load it in place.
  createEffect(on(() => p.id, (id) => void load(id), { defer: true }));

  return (
    <aside class="beside" classList={{ editing: editing() }} aria-label="A note beside">
      <header class="beside-head">
        <span class="beside-title">{note()?.title ?? ""}</span>
        <span class="muted small">{folderName(note()?.folder ?? "")}</span>
        <span class="grow" />
        <button class="link small" title="Write in this one instead" onClick={() => p.onSwap(p.id)}>
          Open here
        </button>
        <button class="icon-btn" title="Close (Esc)" aria-label="Close the note beside" onClick={() => p.onClose()}>
          ×
        </button>
      </header>
      <div
        class="beside-text"
        ref={host}
        onMouseDown={() => {
          if (editing()) return;
          setEditing(true);
          editor?.setReadOnly(false);
        }}
      />
      <footer class="beside-foot">
        <Show when={editing()} fallback={<span>Read only · click to write in it</span>}>
          <span>{{ saved: "Saved", dirty: "Editing", saving: "Saving…", error: "Not saved" }[save()]}</span>
        </Show>
        <span class="grow" />
        <span>
          <kbd>Esc</kbd> close
        </span>
      </footer>
    </aside>
  );
}
