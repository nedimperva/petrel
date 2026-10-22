import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { api, type AppInfo, type Draft } from "./api";
import { createEditor, type EditorHandle } from "./editor/editor";

type SaveState = "saved" | "dirty" | "saving" | "error";

/** Autosave waits this long after the last keystroke. The kill test allows exactly this much loss. */
export const AUTOSAVE_MS = 300;

export default function App() {
  let editorEl!: HTMLDivElement;
  let editor: EditorHandle | undefined;
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [save, setSave] = createSignal<SaveState>("saved");
  const [info, setInfo] = createSignal<AppInfo | null>(null);
  const [count, setCount] = createSignal<number | null>(null);
  let timer: number | undefined;
  let saving: Promise<void> | null = null;

  // The row is created on the first keystroke, never for an untouched new draft.
  async function flush() {
    const a = await api;
    if (!editor) return;
    const text = editor.text();
    const cursor = editor.cursor();
    const current = draft();
    if (!current && text === "") return;
    setSave("saving");
    try {
      if (!current) {
        const d = await a.newDraft(text);
        setDraft(d);
        // Text may have changed while the insert ran.
        if (editor.text() !== text) await a.saveDraft(d.id, editor.text(), editor.cursor());
      } else {
        const ok = await a.saveDraft(current.id, text, cursor);
        if (!ok) throw new Error("draft vanished");
      }
      setSave(editor.text() === text ? "saved" : "dirty");
    } catch (e) {
      console.error(e);
      setSave("error");
      schedule(2000); // not a dialog: retry quietly
    }
  }

  function schedule(ms = AUTOSAVE_MS) {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      saving = flush().finally(() => (saving = null));
    }, ms);
  }

  function onChange() {
    setSave("dirty");
    schedule();
  }

  async function flushNow() {
    window.clearTimeout(timer);
    if (saving) await saving;
    await flush();
  }

  async function newDraft() {
    await flushNow();
    setDraft(null);
    editor?.load("", 0);
    setSave("saved");
  }

  onMount(async () => {
    editor = createEditor(editorEl, onChange);
    editor.view.focus();
    const a = await api;
    await a.showWindow();
    setInfo(await a.appInfo());
    const page = await a.listDrafts({ limit: 1 });
    setCount(page.rows.length ? null : 0);
    window.addEventListener("blur", flushNow);
    window.addEventListener("beforeunload", flushNow);
    document.addEventListener("visibilitychange", () => document.hidden && flushNow());
    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newDraft();
      }
    });
  });
  onCleanup(() => editor?.destroy());

  return (
    <div class="app">
      <main class="editor" ref={editorEl} />
      <footer class="strip">
        <span class={`save save-${save()}`}>
          {save() === "saved" && "saved"}
          {save() === "dirty" && "…"}
          {save() === "saving" && "saving…"}
          {save() === "error" && "not saved — retrying"}
        </span>
        <span class="sep" />
        <Show when={draft()}>{(d) => <span class="meta">{d().title || "untitled"}</span>}</Show>
        <Show when={count() === 0 && !draft()}>
          <span class="meta">Inbox is empty.</span>
        </Show>
        <span class="grow" />
        <span class="meta">markdown</span>
        <span class="sep" />
        <span class="meta">
          <kbd>Ctrl</kbd>
          <kbd>N</kbd> new
        </span>
        <Show when={info()?.debug}>
          <span class="sep" />
          <span class="meta" title={info()?.dbPath}>
            dev
          </span>
        </Show>
      </footer>
    </div>
  );
}
