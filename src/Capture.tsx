// The capture window (`petrel --capture`, Ctrl Alt Space): text, and one quiet line under it. The file is made in
// inbox/ on the first keystroke and saved as you type. Tab picks a note or a collection to file it in when done;
// Ctrl Enter or Esc saves and closes. An empty capture leaves nothing behind.

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { api, inTauri, type Note } from "./api";
import { createEditor, type EditorHandle } from "./editor/editor";
import Destination, { targetLabel, type Target } from "./inbox/Destination";
import { fileCapture } from "./inbox/file";
import { createNoteSaver, type SaveState } from "./notes/saver";
import { applyPrefs, parsePrefs } from "./settings/prefs";

export default function Capture() {
  let host!: HTMLDivElement;
  let editor: EditorHandle | undefined;
  const [note, setNote] = createSignal<Note | null>(null);
  const [save, setSave] = createSignal<SaveState>("saved");
  const [target, setTarget] = createSignal<Target | null>(null);
  const [choosing, setChoosing] = createSignal(false);
  const [msg, setMsg] = createSignal<string | null>(null);
  let closing = false;

  const saver = createNoteSaver({
    // A capture is made by the engine, in inbox/, named by the time.
    store: async () => {
      const s = await api();
      return { createNote: (_f: string, _t: string, body: string) => s.captureNote(body), saveNote: s.saveNote };
    },
    editor: () => editor,
    note,
    setNote,
    setSave,
    fresh: () => ({ folder: "inbox", title: "capture" }),
    conflict: () => {},
  });

  async function done() {
    if (closing) return;
    closing = true;
    const s = await api();
    const text = editor?.text() ?? "";
    if (!(await saver.flush())) {
      // The engine will not take it: keep the words in a file rather than in a window that is about to close.
      const path = await s.rescueText(text).catch(() => null);
      if (!path) {
        closing = false;
        return setMsg(`Not saved: ${saver.error() ?? "unknown error"}`);
      }
    }
    const n = note();
    try {
      if (n && !text.trim()) await s.trashNote(n.id);
      else if (n && target()) await fileCapture({ ...n, body: text }, target()!);
    } catch (e) {
      // The text is safe in the inbox; filing can be done from there.
      console.error(e);
    }
    await s.closeCapture();
  }

  const onKey = (e: KeyboardEvent) => {
    if (choosing()) return;
    if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) {
      e.preventDefault();
      e.stopPropagation();
      void done();
    } else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      setChoosing(true);
    }
  };

  onMount(async () => {
    editor = createEditor(host, () => saver.changed(), { placeholder: "Write it down. File it later." });
    editor.view.focus();
    const s = await api();
    await s.showWindow();
    s.uiSettings().then((m) => applyPrefs(parsePrefs(m)), () => {});
    window.addEventListener("keydown", onKey, true);
    await s.listen({ quit: () => void done(), openNote: () => {}, focus: () => {}, changed: () => {} });
    if (inTauri) {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      await getCurrentWebviewWindow().onCloseRequested((e) => {
        e.preventDefault();
        void done();
      });
    }
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    editor?.destroy();
  });

  const saveLabel = () => (note() || save() !== "saved" ? { saved: "Saved", dirty: "Editing", saving: "Saving…", error: "Not saved, retrying" }[save()] : "");

  return (
    // No window frame: the empty parts of the panel drag the window (Tauri reads data-tauri-drag-region).
    <div class="capture" data-tauri-drag-region>
      <div class="capture-text-host" ref={host} />
      <footer class="capture-foot" data-tauri-drag-region>
        <button class="chip" classList={{ on: !!target() }} onClick={() => setChoosing(true)}>
          {target()?.kind === "note" ? "Add to " : ""}
          {targetLabel(target())}
        </button>
        <span class="muted" data-tauri-drag-region>
          <kbd>Tab</kbd> somewhere else
        </span>
        <span class="grow" data-tauri-drag-region />
        <Show when={msg()} fallback={<span class="muted">{saveLabel()}</span>}>
          <span class="bad">{msg()}</span>
        </Show>
        <button class="btn small" onClick={() => void done()}>
          Done <kbd>Esc</kbd>
        </button>
      </footer>
      <Show when={choosing()}>
        <Destination
          onPick={(t) => {
            setTarget(t);
            setChoosing(false);
            editor?.view.focus();
          }}
          onClose={() => {
            setChoosing(false);
            editor?.view.focus();
          }}
        />
      </Show>
    </div>
  );
}

