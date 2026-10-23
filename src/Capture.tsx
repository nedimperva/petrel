// The capture window (`petrel --capture`, ui.md §3): a new draft and nothing else. One quiet line under the text
// says where it goes and how to leave. `Esc` saves and closes; `Ctrl Enter` runs the default action, then closes.
// It never shows an empty state; the only dialogs are the ones an action asks for.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, type Action, type Draft, type Folder, type HostRequest, type TagCount } from "./api";
import { firstAction } from "./actions/ActionList";
import HostDialog from "./actions/HostDialog";
import { createAutosave, type SaveState } from "./editor/autosave";
import { createEditor, type EditorHandle } from "./editor/editor";

export default function Capture() {
  let editorEl!: HTMLDivElement;
  let tagInput: HTMLInputElement | undefined;
  let editor: EditorHandle | undefined;
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [save, setSave] = createSignal<SaveState>("saved");
  const [folder, setFolder] = createSignal<Folder>("inbox");
  const [tags, setTags] = createSignal<string[]>([]);
  const [tagging, setTagging] = createSignal(false);
  const [allTags, setAllTags] = createSignal<TagCount[]>([]);
  const [actions, setActions] = createSignal<Action[]>([]);
  const [requests, setRequests] = createSignal<HostRequest[]>([]);
  const [running, setRunning] = createSignal<string | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  let closing = false;

  // Nothing until the first save: an empty window has nothing to report.
  const saveLabel = () =>
    ({ saved: draft() ? "saved" : "", dirty: "…", saving: "saving…", error: "not saved — retrying" })[save()];

  const autosave = createAutosave({ editor: () => editor, draft, setDraft, setSave });
  const defaultAction = () => firstAction(actions());

  /** Folder and tags are chosen before the draft may exist, so they are applied when it is done. */
  async function applyChoices() {
    const d = draft();
    if (!d) return;
    const a = await api;
    if (tags().length) await a.setTags(d.id, tags());
    if (folder() !== "inbox") await a.moveDrafts([d.id], folder());
  }

  async function finish() {
    if (closing) return;
    closing = true;
    try {
      await autosave.flushNow();
      await applyChoices();
    } catch (e) {
      // The text is saved by now or retrying; a lost tag is not worth keeping the window open for.
      console.error(e);
    }
    await (await api).closeCapture();
  }

  async function runDefault() {
    const a = defaultAction();
    await autosave.flushNow();
    const d = draft();
    // Nothing typed, or nothing to run: Ctrl Enter is just "done".
    if (!a || !d) return finish();
    await applyChoices();
    setRunning(a.name);
    // Typing during the run would be lost: the action may rewrite the draft.
    editor?.setReadOnly(true);
    try {
      const r = await (await api).runAction(a.uuid, d.id, editor?.selection() ?? null, "shortcut");
      const o = r.outcome;
      if (o.status === "failed") return setNote(`${a.name} failed at step ${o.step}: ${o.message}`);
      if (o.status === "cancelled") return setNote(`${a.name}: cancelled.`);
      // Saved before the run, and the action may have changed the text since: close without saving again.
      closing = true;
      await (await api).closeCapture();
    } catch (e) {
      setNote(`${a.name}: ${String(e).replace(/^Error: /, "")}`);
    } finally {
      editor?.setReadOnly(false);
      setRunning(null);
    }
  }

  async function startTagging() {
    setAllTags(await (await api).tagCounts(null));
    setTagging(true);
    queueMicrotask(() => tagInput?.focus());
  }

  function addTags() {
    const names = (tagInput?.value ?? "").split(/[,\s]+/).map((t) => t.replace(/^#/, "")).filter(Boolean);
    setTags((t) => [...new Set([...t, ...names])]);
    setTagging(false);
    editor?.view.focus();
  }

  function onKey(e: KeyboardEvent) {
    // An action's dialog takes every key; the tag input handles its own Enter and Esc.
    if (requests().length || e.target === tagInput) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (running()) api.then((a) => a.cancelRun());
      else finish();
    } else if (ctrl && !e.shiftKey && !e.altKey && e.key === "Enter") {
      // Capture phase: CodeMirror's own Mod-Enter would insert a line first.
      e.preventDefault();
      e.stopPropagation();
      if (!running()) runDefault();
    }
  }

  onMount(async () => {
    editor = createEditor(editorEl, autosave.changed);
    editor.view.focus();
    const a = await api;
    await a.showWindow();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("beforeunload", () => void autosave.flushNow());
    if ("__TAURI_INTERNALS__" in window) {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      // The close button saves like Esc does.
      await getCurrentWebviewWindow().onCloseRequested((e) => {
        e.preventDefault();
        finish();
      });
    }
    await a.listenHost({
      request: (r) => setRequests((q) => [...q, r]),
      closed: (id) => setRequests((q) => q.filter((x) => x.id !== id)),
      message: (_kind, text) => setNote(text),
    });
    try {
      setActions(await a.listActions());
    } catch {
      // Without actions, Ctrl Enter saves and closes.
    }
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    editor?.destroy();
  });

  async function answer(r: HostRequest, value: unknown) {
    setRequests((q) => q.filter((x) => x.id !== r.id));
    await (await api).hostReply(r.id, value);
  }

  return (
    <div class="capture">
      <main class="editor" ref={editorEl} />
      <footer class="capture-foot">
        <select
          aria-label="Folder"
          value={folder()}
          onChange={(e) => {
            setFolder(e.currentTarget.value as Folder);
            editor?.view.focus();
          }}
        >
          <option value="inbox">Inbox</option>
          <option value="archive">Archive</option>
        </select>
        <For each={tags()}>
          {(t) => (
            <button
              class="chip"
              title="Remove tag"
              aria-label={`Remove tag ${t}`}
              onClick={() => {
                setTags((x) => x.filter((y) => y !== t));
                editor?.view.focus();
              }}
            >
              #{t}
            </button>
          )}
        </For>
        <Show
          when={tagging()}
          fallback={
            <button class="add-tag" onClick={startTagging}>
              + tag
            </button>
          }
        >
          <input
            ref={tagInput}
            list="capture-tags"
            aria-label="Tags"
            placeholder="work, idea"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
              if (e.key === "Enter") addTags();
              else if (e.key === "Escape") {
                setTagging(false);
                editor?.view.focus();
              }
            }}
            onBlur={() => tagging() && addTags()}
          />
          <datalist id="capture-tags">
            <For each={allTags()}>{(t) => <option value={t.name} />}</For>
          </datalist>
        </Show>
        <span class="grow" />
        <Show
          when={running()}
          fallback={
            <Show when={note()} fallback={<span class={`save-${save()}`}>{saveLabel()}</span>}>
              <span class="toast" title={note()!}>
                {note()}
              </span>
            </Show>
          }
        >
          <span>
            {running()} running · <kbd>Esc</kbd> stop
          </span>
        </Show>
        <Show when={defaultAction()}>
          {(a) => (
            <span>
              <kbd>Ctrl Enter</kbd> {a().name}
            </span>
          )}
        </Show>
        <span>
          <kbd>Esc</kbd> done
        </span>
      </footer>
      <Show when={requests()[0]}>{(r) => <HostDialog request={r()} onAnswer={(v) => answer(r(), v)} />}</Show>
    </div>
  );
}
