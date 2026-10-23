import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, type AppInfo, type Draft, type TagCount, type UndoToken } from "./api";
import { createEditor, type EditorHandle } from "./editor/editor";
import DraftList, { type ListHandle } from "./list/DraftList";

type SaveState = "saved" | "dirty" | "saving" | "error";

/** Autosave waits this long after the last keystroke. The kill test allows exactly this much loss. */
export const AUTOSAVE_MS = 300;

/** Coming back after this long away opens a new draft (package 02 "open to new draft"; a setting later). */
export const NEW_AFTER_AWAY_MS = 10 * 60 * 1000;

/** How long a toast stays in the strip. */
const TOAST_MS = 5000;

interface Undoable {
  label: string;
  token: string;
  /** The draft the editor showed when it was archived or trashed from the editor, reopened on undo. */
  reopen?: number;
}

export default function App() {
  let editorEl!: HTMLDivElement;
  let tagInput: HTMLInputElement | undefined;
  let editor: EditorHandle | undefined;
  let list: ListHandle | undefined;
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [save, setSave] = createSignal<SaveState>("saved");
  const [info, setInfo] = createSignal<AppInfo | null>(null);
  const [listOpen, setListOpen] = createSignal(false);
  const [tagging, setTagging] = createSignal(false);
  const [allTags, setAllTags] = createSignal<TagCount[]>([]);
  const [toast, setToast] = createSignal<{ text: string; undo: boolean } | null>(null);
  let undoStack: Undoable[] = [];
  let toastTimer: number | undefined;
  let timer: number | undefined;
  let saving: Promise<void> | null = null;
  let awaySince: number | null = null;

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
    setListOpen(false);
    editor?.load("", 0);
    setSave("saved");
  }

  async function openDraft(id: number) {
    await flushNow();
    try {
      const d = await (await api).openDraft(id);
      setDraft(d);
      setListOpen(false);
      editor?.load(d.content, d.cursor);
      setSave("saved");
    } catch (e) {
      say(`Cannot open: ${e}`);
    }
  }

  function say(text: string, undo = false) {
    window.clearTimeout(toastTimer);
    setToast({ text, undo });
    toastTimer = window.setTimeout(() => setToast(null), TOAST_MS);
  }

  function remember(u: Undoable, count: number) {
    if (count === 0) {
      say(`${u.label}: nothing changed.`);
      return;
    }
    undoStack.push(u);
    if (undoStack.length > 20) undoStack.shift();
    say(u.label, true);
  }

  async function undo() {
    const u = undoStack.pop();
    if (!u) {
      say("Nothing to undo.");
      return;
    }
    try {
      const n = await (await api).undo(u.token);
      say(`Undone: ${u.label.toLowerCase()} (${n}).`);
      if (u.reopen && !draft() && editor?.text() === "") await openDraft(u.reopen);
      else if (draft()) refreshDraft();
      list?.reload();
    } catch (e) {
      say(String(e).replace(/^Error: /, ""));
    }
  }

  async function refreshDraft() {
    const d = draft();
    if (d) setDraft({ ...(await (await api).openDraft(d.id)), content: d.content });
  }

  /** Archive or trash the draft in the editor, then start a new one (Drafts' habit: the next thing is new). */
  async function moveCurrent(folder: "archive" | "trash") {
    await flushNow();
    const d = draft();
    if (!d) return;
    const label = folder === "archive" ? "Archived" : "Trashed";
    try {
      const t: UndoToken = await (await api).moveDrafts([d.id], folder);
      await newDraft();
      remember({ label: `${label} “${d.title || "untitled"}”`, token: t.token, reopen: d.id }, t.count);
    } catch (e) {
      say(`${label} failed: ${e}`);
    }
  }

  async function flagCurrent() {
    await flushNow();
    const d = draft();
    if (!d) return;
    const flagged = !d.flagged;
    const t = await (await api).flagDrafts([d.id], flagged);
    setDraft({ ...d, flagged });
    remember({ label: flagged ? "Flagged" : "Unflagged", token: t.token }, t.count);
  }

  async function startTagging() {
    await flushNow();
    if (!draft()) {
      say("Type something first: an empty draft has nothing to tag.");
      return;
    }
    setAllTags(await (await api).tagCounts(null));
    setTagging(true);
    queueMicrotask(() => {
      if (!tagInput) return;
      tagInput.value = draft()!.tags.join(", ");
      tagInput.focus();
      tagInput.select();
    });
  }

  async function saveTags() {
    const d = draft();
    const names = (tagInput?.value ?? "").split(/[,\s]+/).filter(Boolean);
    setTagging(false);
    editor?.view.focus();
    if (!d) return;
    try {
      const tags = await (await api).setTags(d.id, names);
      setDraft({ ...d, tags });
      say(tags.length ? `Tags: ${tags.join(", ")}` : "Tags cleared.");
    } catch (e) {
      say(`Tagging failed: ${e}`);
    }
  }

  function toggleList() {
    if (listOpen()) {
      setListOpen(false);
      editor?.view.focus();
    } else {
      flushNow();
      setListOpen(true);
    }
  }

  function onKey(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && !e.altKey) {
      if (k === "n") return stop(e, newDraft);
      if (k === "l") return stop(e, toggleList);
      if (k === "e" && !listOpen()) return stop(e, () => moveCurrent("archive"));
      if (k === "t" && !listOpen()) return stop(e, startTagging);
    }
    if (ctrl && e.shiftKey && !e.altKey && !listOpen()) {
      if (k === "f") return stop(e, flagCurrent);
      // `Ctrl #` is Ctrl Shift 3 on most layouts; match the key and the physical key.
      if (e.key === "#" || e.code === "Digit3") return stop(e, () => moveCurrent("trash"));
    }
    const el = e.target as HTMLElement | null;
    const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    if (listOpen() && !typing && list?.key(e)) e.preventDefault();
  }

  function stop(e: KeyboardEvent, run: () => unknown) {
    e.preventDefault();
    e.stopPropagation();
    run();
  }

  /** Back after `NEW_AFTER_AWAY_MS` with a draft open: start a new one, as Drafts does. The old one is saved. */
  function away(hidden: boolean) {
    if (hidden) {
      awaySince ??= Date.now();
      flushNow();
      return;
    }
    const since = awaySince;
    awaySince = null;
    if (since !== null && Date.now() - since >= NEW_AFTER_AWAY_MS && draft() && !listOpen() && !tagging()) {
      newDraft();
    }
  }

  onMount(async () => {
    editor = createEditor(editorEl, onChange);
    editor.view.focus();
    const a = await api;
    await a.showWindow();
    setInfo(await a.appInfo());
    window.addEventListener("blur", () => away(true));
    window.addEventListener("focus", () => away(false));
    window.addEventListener("beforeunload", flushNow);
    document.addEventListener("visibilitychange", () => away(document.hidden));
    window.addEventListener("keydown", onKey, true);
  });
  onCleanup(() => editor?.destroy());

  return (
    <div class="app">
      <main class="editor" ref={editorEl} />
      <Show when={listOpen()}>
        <DraftList
          ref={(h) => (list = h)}
          openId={draft()?.id ?? null}
          onOpen={openDraft}
          onClose={toggleList}
          onBatch={(label, t) => remember({ label, token: t.token }, t.count)}
          onUndo={undo}
          onToast={say}
        />
      </Show>
      <Show when={tagging()}>
        <div class="bar tagbar">
          <span>Tags:</span>
          <input
            ref={tagInput}
            list="petrel-tags"
            placeholder="work, idea"
            onKeyDown={(e) => {
              e.stopPropagation();
              // preventDefault: focus moves to the editor before the key's default action would type there.
              if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
              if (e.key === "Enter") saveTags();
              else if (e.key === "Escape") {
                setTagging(false);
                editor?.view.focus();
              }
            }}
          />
          <span class="hint">
            <kbd>Enter</kbd> save <kbd>Esc</kbd> cancel
          </span>
        </div>
      </Show>
      <datalist id="petrel-tags">
        <For each={allTags()}>{(t) => <option value={t.name} />}</For>
      </datalist>
      <footer class="strip">
        <span class={`save save-${save()}`}>
          {save() === "saved" && "saved"}
          {save() === "dirty" && "…"}
          {save() === "saving" && "saving…"}
          {save() === "error" && "not saved — retrying"}
        </span>
        <span class="sep" />
        <Show when={draft()}>
          {(d) => (
            <>
              <Show when={d().flagged}>
                <span class="flag on" title="Flagged" />
              </Show>
              <span class="meta">{d().title || "untitled"}</span>
              <Show when={d().folder !== "inbox"}>
                <span class="meta">· {d().folder}</span>
              </Show>
              <For each={d().tags}>{(t) => <span class="tag">{t}</span>}</For>
            </>
          )}
        </Show>
        <Show when={toast()}>
          {(t) => (
            <>
              <span class="sep" />
              <span class="toast">{t().text}</span>
              <Show when={t().undo}>
                <button class="link" onClick={undo}>
                  Undo
                </button>
                <span class="meta">
                  <kbd>z</kbd> in the list
                </span>
              </Show>
            </>
          )}
        </Show>
        <span class="grow" />
        <Show
          when={listOpen()}
          fallback={
            <span class="meta keys">
              <kbd>Ctrl</kbd>
              <kbd>L</kbd> list <kbd>Ctrl</kbd>
              <kbd>N</kbd> new <kbd>Ctrl</kbd>
              <kbd>E</kbd> archive <kbd>Ctrl</kbd>
              <kbd>T</kbd> tag
            </span>
          }
        >
          <span class="meta keys">
            <kbd>j</kbd>
            <kbd>k</kbd> move <kbd>Enter</kbd> open <kbd>x</kbd> select <kbd>e</kbd> archive <kbd>#</kbd> trash{" "}
            <kbd>f</kbd> flag <kbd>t</kbd> tag <kbd>z</kbd> undo <kbd>/</kbd> search <kbd>Esc</kbd> back
          </span>
        </Show>
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
