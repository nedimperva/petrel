// Notes (`Ctrl 3`, docs/design/notes.md): a home of cards (pinned, recent, a folder's notes) and the note page,
// which is the note alone: its title, the text in a reading serif, an outline beside it, and what links to it
// underneath. The files are the notes; this view reads and writes them through the engine. Loaded the first
// time it opens, so drafts never pay for it.

import "@fontsource-variable/literata";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { RangeSet, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { api, type Backlinks, type Note, type NoteFolder, type NoteSummary, type UndoToken } from "../api";
import type { SaveState } from "../editor/autosave";
import { countWords } from "../editor/autosave";
import { createEditor, type EditorHandle } from "../editor/editor";
import { createNoteSaver } from "./saver";

export type NotesStart = { kind: "home"; folder?: string | null } | { kind: "note"; id: number } | { kind: "new"; title?: string; folder?: string };

export interface NotesHandle {
  flush(): Promise<boolean>;
  /** Keys the view takes when nothing else did; true when used. */
  key(e: KeyboardEvent): boolean;
  show(start: NotesStart): Promise<void>;
  /** The note on the page, if any. */
  current(): Note | null;
  /** The folder new notes go to: the open note's, or the folder the home shows. */
  folder(): string;
  /** After the window comes back: pick up files changed elsewhere. */
  rescan(): Promise<void>;
  /** `Ctrl #`. */
  trash(): Promise<void>;
  /** `Ctrl T`. */
  tag(): void;
  pin(): Promise<void>;
  /** The editor, to insert a link from a command. */
  editor(): EditorHandle | undefined;
}

interface Props {
  ref(h: NotesHandle): void;
  start: NotesStart;
  /** The links extension, shared with the draft editor. */
  links?: import("@codemirror/state").Extension;
  onClose(): void;
  onOpenDraft(id: number): void;
  onUndoable(label: string, t: UndoToken): void;
  say(text: string): void;
}

const RECENT_SHOWN = 12;

function when(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The headings of a Markdown text, outside code fences. */
function outline(text: string): { level: number; text: string; line: number }[] {
  const out: { level: number; text: string; line: number }[] = [];
  let fence = false;
  text.split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 });
  });
  return out;
}

class BacklinksWidget extends WidgetType {
  constructor(readonly el: HTMLElement) {
    super();
  }
  eq() {
    return true;
  }
  toDOM() {
    return this.el;
  }
  ignoreEvent() {
    return true;
  }
}

/** "Linked from" sits under the text, inside the editor's scroll, as a block at the end of the document. */
function backlinksBlock(el: HTMLElement) {
  const widget = Decoration.widget({ widget: new BacklinksWidget(el), block: true, side: 1 });
  return StateField.define({
    create: (s) => RangeSet.of([widget.range(s.doc.length)]),
    update: (v, tr) => (tr.docChanged ? RangeSet.of([widget.range(tr.state.doc.length)]) : v),
    provide: (f) => EditorView.decorations.from(f),
  });
}

export default function NotesView(props: Props) {
  let editorEl!: HTMLDivElement;
  let titleEl: HTMLInputElement | undefined;
  let tagEl: HTMLInputElement | undefined;
  let homeEl: HTMLDivElement | undefined;
  let editor: EditorHandle | undefined;
  const backEl = document.createElement("div");
  backEl.className = "note-back";
  const [mode, setMode] = createSignal<"home" | "page">("home");
  const [note, setNote] = createSignal<Note | null>(null);
  const [newFolder, setNewFolder] = createSignal("");
  const [save, setSave] = createSignal<SaveState>("saved");
  const [words, setWords] = createSignal(0);
  const [heads, setHeads] = createSignal<ReturnType<typeof outline>>([]);
  const [back, setBack] = createSignal<Backlinks>({ linked: [], mentioned: [] });
  const [pinned, setPinned] = createSignal<NoteSummary[]>([]);
  const [recent, setRecent] = createSignal<NoteSummary[]>([]);
  const [folders, setFolders] = createSignal<NoteFolder[]>([]);
  const [folder, setFolder] = createSignal<string | null>(null);
  const [root, setRoot] = createSignal("");
  const [tagging, setTagging] = createSignal(false);
  let timer: number | undefined;

  const saver = createNoteSaver({
    store: () => api,
    editor: () => editor,
    note,
    setNote,
    setSave,
    fresh: () => ({ folder: newFolder(), title: titleEl?.value ?? "" }),
    conflict: (p) => props.say(`The file changed in another app while open here. Their text is kept as “${p}”.`),
  });

  function changed() {
    saver.changed();
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const t = editor?.text() ?? "";
      setHeads(outline(t));
      setWords(countWords(t));
    }, 300);
  }

  async function loadHome() {
    const a = await api;
    try {
      const f = folder();
      const [p, r, fs] = await Promise.all([
        a.listNotes({ pinned: true, limit: 9 }),
        a.listNotes({ folder: f, limit: f === null ? RECENT_SHOWN : 200 }),
        a.noteFolders(),
      ]);
      setPinned(p);
      setRecent(f === null ? r.filter((n) => !n.pinned).slice(0, RECENT_SHOWN) : r);
      setFolders(fs);
    } catch (e) {
      props.say(`Notes cannot be read: ${String(e).replace(/^Error: /, "")}`);
    }
  }

  async function loadBacklinks(id: number) {
    try {
      setBack(await (await api).backlinks(id));
    } catch {
      setBack({ linked: [], mentioned: [] });
    }
  }

  async function saved(): Promise<boolean> {
    if (await saver.flush()) return true;
    props.say(`Not saved: ${saver.error() ?? "unknown error"}. The text stays here until it is.`);
    return false;
  }

  async function openNote(id: number) {
    if (!(await saved())) return;
    let n: Note;
    try {
      n = await (await api).openNote(id);
    } catch (e) {
      props.say(String(e).replace(/^Error: /, ""));
      return;
    }
    setMode("page");
    saver.load(n);
    if (titleEl) titleEl.value = n.title;
    setHeads(outline(n.body));
    setWords(countWords(n.body));
    void loadBacklinks(n.id);
    queueMicrotask(() => editor?.view.focus());
  }

  async function newNote(title = "", inFolder?: string) {
    if (!(await saved())) return;
    setMode("page");
    setNote(null);
    setNewFolder(inFolder ?? folder() ?? note()?.folder ?? "");
    saver.load(null);
    setHeads([]);
    setWords(0);
    setBack({ linked: [], mentioned: [] });
    queueMicrotask(() => {
      if (!titleEl) return;
      titleEl.value = title;
      titleEl.focus();
    });
  }

  async function goHome() {
    if (!(await saved())) return;
    setMode("home");
    await loadHome();
    queueMicrotask(() => homeEl?.querySelector<HTMLElement>(".note-card")?.focus());
  }

  /** The title field: Enter or leaving it names the note (a rename rewrites links to it). */
  async function commitTitle() {
    const value = (titleEl?.value ?? "").trim();
    const n = note();
    if (!n) {
      if (value) {
        saver.changed();
        await saved();
      }
      return;
    }
    if (!value) {
      if (titleEl) titleEl.value = n.title;
      return;
    }
    if (value === n.title) return;
    if (!(await saved())) return;
    try {
      const c = await (await api).renameNote(n.id, value);
      setNote({ ...note()!, title: c.note.title, path: c.note.path, hash: c.note.hash });
      if (titleEl) titleEl.value = c.note.title;
      const links = c.relinked ? ` ${c.relinked} ${c.relinked === 1 ? "text" : "texts"} with links updated.` : "";
      props.onUndoable(`Renamed to “${c.note.title}”.${links}`, c.token);
    } catch (e) {
      if (titleEl) titleEl.value = n.title;
      props.say(String(e).replace(/^Error: /, ""));
    }
  }

  async function trash() {
    const n = note();
    if (!n || !(await saved())) return;
    try {
      const t = await (await api).trashNote(n.id);
      props.onUndoable(`“${n.title}” moved to the notes trash.`, t);
      setNote(null);
      await goHome();
    } catch (e) {
      props.say(String(e).replace(/^Error: /, ""));
    }
  }

  async function pin() {
    const n = note();
    if (!n || !(await saved())) return;
    const fresh = await (await api).pinNote(n.id, !n.pinned);
    setNote({ ...note()!, pinned: fresh.pinned, hash: fresh.hash });
    props.say(fresh.pinned ? "Pinned to the notes home." : "Unpinned.");
  }

  function tag() {
    if (!note()) return props.say("Give the note a title first.");
    setTagging(true);
    queueMicrotask(() => {
      if (!tagEl) return;
      tagEl.value = note()!.tags.join(", ");
      tagEl.focus();
      tagEl.select();
    });
  }

  async function saveTags() {
    const n = note();
    setTagging(false);
    editor?.view.focus();
    if (!n || !(await saved())) return;
    const names = (tagEl?.value ?? "").split(/[,\s]+/).filter(Boolean);
    try {
      const fresh = await (await api).setNoteTags(n.id, names);
      setNote({ ...note()!, tags: fresh.tags, hash: fresh.hash });
    } catch (e) {
      props.say(String(e).replace(/^Error: /, ""));
    }
  }

  async function rescan() {
    try {
      await (await api).scanNotes();
    } catch {
      return;
    }
    const n = note();
    if (mode() === "page" && n && !saver.dirty()) {
      try {
        const fresh = await (await api).peekNote(n.id);
        if (fresh.hash !== n.hash) {
          saver.load(fresh);
          if (titleEl) titleEl.value = fresh.title;
          props.say("Changed in another app: showing the new text.");
        }
      } catch (e) {
        props.say(String(e).replace(/^Error: /, ""));
      }
    }
    if (mode() === "home") await loadHome();
  }

  async function linkMention(r: Backlinks["mentioned"][number]) {
    const n = note();
    if (!n) return;
    try {
      const t = await (await api).linkMention(n.id, r.kind, r.id);
      props.onUndoable(`Linked in “${r.title}”.`, t);
      void loadBacklinks(n.id);
    } catch (e) {
      props.say(String(e).replace(/^Error: /, ""));
    }
  }

  function jumpTo(line: number) {
    if (!editor) return;
    const l = editor.view.state.doc.line(Math.min(line, editor.view.state.doc.lines));
    editor.view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "start" }) });
    editor.view.focus();
  }

  function moveCard(step: number) {
    const cards = [...(homeEl?.querySelectorAll<HTMLElement>(".note-card, .note-tree button") ?? [])];
    const i = cards.indexOf(document.activeElement as HTMLElement);
    cards[Math.max(0, Math.min(cards.length - 1, i + step))]?.focus();
  }

  const handle: NotesHandle = {
    flush: () => saver.flush(),
    key(e) {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey) {
        if (tagging()) return false;
        if (mode() === "page") void goHome();
        else props.onClose();
        return true;
      }
      if (typing || mode() !== "home") return false;
      if (e.key === "j" || e.key === "ArrowDown" || e.key === "ArrowRight") return moveCard(1), true;
      if (e.key === "k" || e.key === "ArrowUp" || e.key === "ArrowLeft") return moveCard(-1), true;
      if (e.key === "n") return void newNote(), true;
      return false;
    },
    show: async (s) => {
      if (s.kind === "note") return openNote(s.id);
      if (s.kind === "new") return newNote(s.title ?? "", s.folder);
      if (s.folder !== undefined) setFolder(s.folder);
      return goHome();
    },
    current: note,
    folder: () => note()?.folder ?? folder() ?? newFolder(),
    rescan,
    trash,
    tag,
    pin,
    editor: () => editor,
  };

  onMount(async () => {
    editor = createEditor(editorEl, changed, { placeholder: "Write. It's a Markdown file in your notes folder." });
    editor.setExtra([backlinksBlock(backEl), ...(props.links ? [props.links] : [])]);
    props.ref(handle);
    try {
      const a = await api;
      setRoot((await a.notesInfo()).root);
      await a.scanNotes();
    } catch (e) {
      props.say(`Notes folder: ${String(e).replace(/^Error: /, "")}`);
    }
    await handle.show(props.start);
  });
  onCleanup(() => {
    void saver.flush();
    editor?.destroy();
  });

  const card = (n: NoteSummary, big: boolean) => (
    <button class="note-card" classList={{ big }} onClick={() => openNote(n.id)}>
      <span class="note-card-title">{n.title}</span>
      <span class="note-card-text">{n.preview || "Empty"}</span>
      <span class="note-card-meta">
        {n.folder || "Notes"} · {when(n.modifiedAt)}
      </span>
    </button>
  );

  return (
    <div class="notes" classList={{ page: mode() === "page" }}>
      <Show when={mode() === "home"}>
        <div class="notes-home" ref={homeEl}>
          <nav class="note-tree" aria-label="Note folders">
            <div class="note-tree-head">
              <span>Notes</span>
              <span class="meta" title={root()}>
                {root().split(/[/\\]/).filter(Boolean).at(-1) ?? ""}
              </span>
            </div>
            <button classList={{ on: folder() === null }} onClick={() => (setFolder(null), loadHome())}>
              <span class="grow">Home</span>
            </button>
            <button classList={{ on: folder() === "" }} onClick={() => (setFolder(""), loadHome())}>
              <span class="grow">Top of the folder</span>
            </button>
            <For each={folders()}>
              {(f) => (
                <button
                  classList={{ on: folder() === f.path }}
                  style={{ "padding-left": `${8 + f.depth * 14}px` }}
                  onClick={() => (setFolder(f.path), loadHome())}
                  title={f.path}
                >
                  <span class="grow">{f.name}</span>
                  <Show when={f.count}>
                    <span class="meta">{f.count}</span>
                  </Show>
                </button>
              )}
            </For>
            <span class="grow" />
            <button class="note-tree-foot" onClick={props.onClose}>
              <span class="grow">Back to drafts</span>
              <kbd>Esc</kbd>
            </button>
          </nav>
          <main class="note-cards">
            <div class="note-cards-head">
              <h1>{folder() === null ? "Notes" : folder() === "" ? "Top of the folder" : folder()}</h1>
              <button onClick={() => newNote()}>
                New note <kbd>Ctrl N</kbd>
              </button>
            </div>
            <Show when={folder() === null && pinned().length}>
              <h2>Pinned</h2>
              <div class="note-grid big">
                <For each={pinned()}>{(n) => card(n, true)}</For>
              </div>
            </Show>
            <Show when={recent().length} fallback={<p class="notes-empty">No notes here yet. <kbd>Ctrl N</kbd> starts one, and <kbd>Ctrl Shift N</kbd> on a draft makes it a note.</p>}>
              <h2>{folder() === null ? "Recent" : "Notes"}</h2>
              <div class="note-grid">
                <For each={recent()}>{(n) => card(n, false)}</For>
              </div>
            </Show>
          </main>
        </div>
      </Show>
      <div class="note-page" style={{ display: mode() === "page" ? undefined : "none" }}>
        <div class="note-column">
          <div class="note-meta">
            <button class="link" onClick={goHome}>
              Notes
            </button>
            <Show when={(note()?.folder ?? newFolder())}>
              {(f) => <span>/ {f()}</span>}
            </Show>
            <span class="grow" />
            <Show when={note()?.pinned}>
              <span>pinned</span>
            </Show>
            <span class={`save save-${save()}`}>
              {save() === "saved" && (note() ? "saved" : "not a file yet")}
              {save() === "dirty" && "…"}
              {save() === "saving" && "saving…"}
              {save() === "error" && "not saved — retrying"}
            </span>
          </div>
          <input
            ref={titleEl}
            class="note-title"
            placeholder="Title"
            aria-label="Note title"
            onKeyDown={(e) => {
              if (e.key === "Enter" || (e.key === "ArrowDown" && !e.shiftKey)) {
                e.preventDefault();
                e.stopPropagation();
                editor?.view.focus();
              }
            }}
            onBlur={commitTitle}
          />
          <Show when={note()?.tags.length || tagging()}>
            <div class="note-tags">
              <Show
                when={tagging()}
                fallback={
                  <For each={note()?.tags ?? []}>
                    {(t) => (
                      <button class="chip" onClick={tag}>
                        #{t}
                      </button>
                    )}
                  </For>
                }
              >
                <input
                  ref={tagEl}
                  placeholder="design, petrel"
                  aria-label="Tags"
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
                    if (e.key === "Enter") void saveTags();
                    if (e.key === "Escape") {
                      setTagging(false);
                      editor?.view.focus();
                    }
                  }}
                  onBlur={() => tagging() && saveTags()}
                />
              </Show>
            </div>
          </Show>
          <main class="editor note-editor" ref={editorEl} />
        </div>
        <aside class="note-outline" aria-label="Outline">
          <Show when={heads().length}>
            <span class="label">Outline</span>
            <For each={heads()}>
              {(h) => (
                <button style={{ "padding-left": `${(h.level - 1) * 10}px` }} onClick={() => jumpTo(h.line)}>
                  {h.text}
                </button>
              )}
            </For>
          </Show>
          <span class="grow" />
          <span class="meta">{words() === 1 ? "1 word" : `${words().toLocaleString()} words`}</span>
        </aside>
      </div>
      <Portal mount={backEl}>
        <Show when={mode() === "page" && note() && (back().linked.length || back().mentioned.length)}>
          <section class="note-backlinks" aria-label="Linked from">
            <Show when={back().linked.length}>
              <span class="label">Linked from {back().linked.length}</span>
              <For each={back().linked}>
                {(r) => (
                  <button class="backref" onClick={() => (r.kind === "note" ? openNote(r.id) : props.onOpenDraft(r.id))}>
                    <span class="backref-title">
                      {r.title || "untitled"} <span class={`kind kind-${r.kind}`}>{r.kind}</span>
                    </span>
                    <span class="backref-line">{r.line}</span>
                  </button>
                )}
              </For>
            </Show>
            <Show when={back().mentioned.length}>
              <span class="label">Mentioned, not linked</span>
              <For each={back().mentioned}>
                {(r) => (
                  <div class="mention">
                    <span class="backref-line">
                      <b>{r.title || "untitled"}</b> {r.line}
                    </span>
                    <button onClick={() => linkMention(r)}>Link it</button>
                  </div>
                )}
              </For>
            </Show>
          </section>
        </Show>
      </Portal>
    </div>
  );
}
