// The writing page: a note's title and text in Literata and one quiet line below (where it lives, words, saved).
// What links here, and related notes when asked, sit under the text. AI only when asked: `Ctrl J` on a selection, `/` on an empty
// line. Saves go through the note saver (300 ms, conflict copies), exactly as before the redesign.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type AiRelated, type AiTask, type Backlinks, type Note } from "../api";
import { createEditor, type EditorHandle } from "../editor/editor";
import { linkExtensions } from "../notes/links";
import { createNoteSaver, type NoteSaver, type SaveState } from "../notes/saver";
import { prefs } from "../settings/prefs";
import { wordCount } from "../copy";
import { folderName, say } from "../ui";
import { aiPreview, keepPreview, previewOf, setPreview, type Preview } from "./aiPreview";

export interface NotePageHandle {
  note(): Note | null;
  text(): string;
  flush(): Promise<boolean>;
  /** Selection, or the whole note when nothing is selected. */
  selectedText(): string;
  ai(task: AiTask): void;
  findRelated(): void;
  reload(): Promise<void>;
  focus(): void;
}

interface Props {
  id: number | null;
  /** Where a new note is made. */
  folder: string;
  root: string;
  aiReady: boolean;
  onOpen(id: number): void;
  onFolder(folder: string): void;
  onHome(): void;
  onHistory(): void;
  /** The title as it is typed, for the title bar. */
  onTitle?(title: string): void;
  onAiSetup(): void;
  ref(h: NotePageHandle): void;
}

const BAR: { task: AiTask; label: string }[] = [
  { task: "tidy", label: "Tidy" },
  { task: "shorten", label: "Shorten" },
  { task: "list", label: "Make a list" },
  { task: "explain", label: "Explain" },
];

const SLASH: { task: AiTask; label: string; hint: string }[] = [
  { task: "continue", label: "Continue writing", hint: "from where the text stops" },
  { task: "summarize", label: "Summarize the text above", hint: "a few sentences" },
  { task: "checklist", label: "Turn into a checklist", hint: "the paragraph above" },
  { task: "title", label: "Suggest a title", hint: "renames the note if you keep it" },
];

const LABELS: Record<AiTask, string> = {
  tidy: "Tidied",
  shorten: "Shorter",
  list: "As a list",
  checklist: "As a checklist",
  custom: "Rewritten",
  explain: "Explained",
  continue: "Continued",
  summarize: "Summary",
  title: "Title",
};

export default function NotePage(p: Props) {
  let host!: HTMLDivElement;
  let titleInput!: HTMLInputElement;
  let editor: EditorHandle | undefined;
  let saver!: NoteSaver;
  const [note, setNote] = createSignal<Note | null>(null);
  const [save, setSave] = createSignal<SaveState>("saved");
  const [title, setTitle] = createSignal("");
  const [words, setWords] = createSignal(0);
  const [links, setLinks] = createSignal<Backlinks>({ linked: [], mentioned: [] });
  const [related, setRelated] = createSignal<AiRelated[] | "loading" | null>(null);
  const [bar, setBar] = createSignal<{ x: number; y: number; ask: boolean } | null>(null);
  const [slash, setSlash] = createSignal<{ x: number; y: number; i: number } | null>(null);
  const [explain, setExplain] = createSignal<{ x: number; y: number; text: string | null; at: number } | null>(null);
  const [asking, setAsking] = createSignal("");
  // The last AI request, for Try again.
  let last: { task: AiTask; from: number; to: number; instruction?: string } | null = null;
  let seq = 0;

  const loadLinks = async (id: number) => setLinks(await (await api()).backlinks(id).catch(() => ({ linked: [], mentioned: [] })));

  async function load(id: number | null) {
    await saver?.flush();
    setRelated(null);
    setBar(null);
    setSlash(null);
    setExplain(null);
    if (id === null) {
      saver.load(null);
      setNote(null);
      setTitle("");
      setLinks({ linked: [], mentioned: [] });
      setWords(0);
      titleInput?.focus();
      return;
    }
    try {
      const n = await (await api()).openNote(id);
      saver.load(n);
      setTitle(n.title);
      setWords(wordCount(n.body));
      void loadLinks(n.id);
      editor?.view.focus();
    } catch (e) {
      say(errText(e), { error: true });
      p.onHome();
    }
  }

  const rename = async () => {
    const t = title().trim();
    const n = note();
    if (!n) {
      if (t) saver.changed();
      return;
    }
    if (!t || t === n.title) return setTitle(n.title);
    try {
      await saver.flush();
      const ch = await (await api()).renameNote(n.id, t);
      setNote(ch.note);
      setTitle(ch.note.title);
      const s = await api();
      say(ch.relinked ? `Renamed. ${ch.relinked} links follow it.` : "Renamed", { undo: () => s.undo(ch.token.token).then(() => load(n.id)) });
    } catch (e) {
      say(errText(e), { error: true });
      setTitle(n.title);
    }
  };

  // ---- AI ----------------------------------------------------------------------------------------------------

  const view = () => editor!.view;

  async function run(task: AiTask, from: number, to: number, instruction?: string) {
    if (!p.aiReady) return p.onAiSetup();
    setBar(null);
    setSlash(null);
    const v = view();
    const doc = v.state.doc;
    const text = task === "continue" || task === "summarize" ? doc.sliceString(0, to) : task === "title" ? doc.toString() : doc.sliceString(from, to);
    if (!text.trim()) return say("There is no text to work on yet");
    last = { task, from, to, instruction };
    const mine = ++seq;
    await saver.flush();
    if (task === "explain") {
      const c = v.coordsAtPos(to);
      setExplain({ x: c?.left ?? 0, y: (c?.bottom ?? 0) + 6, text: null, at: to });
    } else if (task !== "title") {
      // Continue and summarize write at the cursor; the rest replace the text they read.
      const at = task === "continue" || task === "summarize" ? to : from;
      v.dispatch({ effects: setPreview.of({ from: at, to: task === "continue" || task === "summarize" ? at : to, text: null, error: null, label: LABELS[task] }) });
    }
    try {
      const out = await (await api()).aiWrite({ task, text, context: doc.toString(), instruction, noteId: note()?.id });
      if (mine !== seq) return;
      if (task === "explain") return setExplain((e) => e && { ...e, text: out });
      if (task === "title") return proposeTitle(out);
      const pv = previewOf(v.state);
      if (!pv) return;
      const lead = (task === "continue" || task === "summarize") && pv.from > 0 && doc.sliceString(pv.from - 1, pv.from) !== "\n" ? "\n\n" : "";
      v.dispatch({ effects: setPreview.of({ ...pv, text: lead + out }) });
    } catch (e) {
      if (mine !== seq) return;
      if (task === "explain") return setExplain(null), say(errText(e), { error: true });
      if (task === "title") return say(errText(e), { error: true });
      const pv = previewOf(v.state);
      if (pv) v.dispatch({ effects: setPreview.of({ ...pv, error: errText(e) }) });
    }
  }

  const proposeTitle = (t: string) => {
    const clean = t.split("\n")[0].replace(/^["'#\s]+|["'.\s]+$/g, "");
    setTitle(clean);
    if (!note()) return saver.changed();
    say("Suggested title. Enter keeps it, Esc puts the old one back.");
    titleInput.focus();
    titleInput.select();
  };

  const actions = {
    keep() {
      const pv = previewOf(view().state);
      if (pv?.text != null) keepPreview(view());
    },
    drop() {
      seq++;
      view().dispatch({ effects: setPreview.of(null) });
      view().focus();
    },
    retry() {
      if (!last) return;
      const pv: Preview | null = previewOf(view().state);
      view().dispatch({ effects: setPreview.of(null) });
      const from = pv ? pv.from : last.from;
      const to = pv ? (last.task === "continue" || last.task === "summarize" ? pv.from : pv.to) : last.to;
      void run(last.task, from, to, last.instruction);
    },
  };

  /** The selection, or the paragraph around the cursor when nothing is selected. */
  function range(): { from: number; to: number } {
    const s = view().state;
    const sel = s.selection.main;
    if (!sel.empty) return { from: sel.from, to: sel.to };
    const doc = s.doc;
    let a = doc.lineAt(sel.head).number;
    let b = a;
    while (a > 1 && doc.line(a - 1).text.trim()) a--;
    while (b < doc.lines && doc.line(b + 1).text.trim()) b++;
    return { from: doc.line(a).from, to: doc.line(b).to };
  }

  function openBar() {
    if (!editor || previewOf(view().state)) return;
    const r = range();
    if (r.from === r.to) return say("Select some text first");
    view().dispatch({ selection: { anchor: r.from, head: r.to } });
    const c = view().coordsAtPos(r.from);
    setBar({ x: c?.left ?? 0, y: (c?.top ?? 0) - 46, ask: false });
  }

  function openSlash() {
    const v = view();
    const head = v.state.selection.main.head;
    const c = v.coordsAtPos(head);
    setSlash({ x: c?.left ?? 0, y: (c?.bottom ?? 0) + 4, i: 0 });
  }

  function slashRun(task: AiTask) {
    const v = view();
    const head = v.state.selection.main.head;
    setSlash(null);
    if (task === "checklist") {
      // The paragraph above the empty line.
      const doc = v.state.doc;
      let n = doc.lineAt(head).number - 1;
      while (n >= 1 && !doc.line(n).text.trim()) n--;
      if (n < 1) return say("There is no paragraph above");
      let a = n;
      while (a > 1 && doc.line(a - 1).text.trim()) a--;
      return void run("checklist", doc.line(a).from, doc.line(n).to);
    }
    void run(task, head, head);
  }

  const slashKeys = (e: KeyboardEvent) => {
    const s = slash();
    if (!s) return;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setSlash({ ...s, i: (s.i + 1) % SLASH.length });
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setSlash({ ...s, i: (s.i + SLASH.length - 1) % SLASH.length });
    else if (e.key === "Enter") slashRun(SLASH[s.i].task);
    else if (e.key === "Escape") setSlash(null);
    else return setSlash(null);
    e.preventDefault();
    e.stopPropagation();
  };

  const barKeys = (e: KeyboardEvent) => {
    const b = bar();
    if (!b || b.ask) return;
    const i = ["1", "2", "3", "4"].indexOf(e.key);
    if (i >= 0) {
      e.preventDefault();
      const r = range();
      return void run(BAR[i].task, r.from, r.to);
    }
    if (e.key === "a" || e.key === "5") {
      e.preventDefault();
      return setBar({ ...b, ask: true });
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setBar(null);
      view().focus();
    }
  };

  onMount(() => {
    editor = createEditor(host, () => {
      saver.changed();
      setWords(wordCount(editor!.text()));
      setBar(null);
      setExplain(null);
    });
    saver = createNoteSaver({
      store: api,
      editor: () => editor,
      note,
      setNote,
      setSave,
      fresh: () => ({ folder: p.folder, title: title() }),
      conflict: (path) => say(`This note was also changed elsewhere. That copy is kept as ${path}.`, { error: true }),
    });
    editor.setExtra([
      aiPreview(actions),
      linkExtensions({
        open: async (inner) => {
          const r = await (await api()).resolveLink(inner);
          if (r.kind === "note") p.onOpen(r.id);
          else if (r.kind === "missing") {
            const n = await (await api()).createNote(r.folder ?? p.folder, r.title, "", []);
            p.onOpen(n.id);
          }
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
    editor.view.contentDOM.addEventListener("keydown", (e) => {
      if (slash()) return slashKeys(e);
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const s = view().state;
        const line = s.doc.lineAt(s.selection.main.head);
        if (!line.text.trim() && s.selection.main.empty) {
          e.preventDefault();
          openSlash();
        }
      }
    }, true);
    p.ref({
      note,
      text: () => editor?.text() ?? "",
      flush: () => saver.flush(),
      selectedText: () => {
        const s = view().state.selection.main;
        return s.empty ? view().state.doc.toString() : view().state.sliceDoc(s.from, s.to);
      },
      ai: (task) => {
        const r = task === "continue" || task === "summarize" ? { from: view().state.doc.length, to: view().state.doc.length } : { from: 0, to: view().state.doc.length };
        const s = view().state.selection.main;
        void run(task, s.empty ? r.from : s.from, s.empty ? r.to : s.to);
      },
      findRelated,
      reload: () => load(note()?.id ?? null),
      focus: () => editor?.view.focus(),
    });
    void load(p.id);
  });

  createEffect(() => editor?.setTypewriter(prefs().typewriter));
  createEffect(() => p.onTitle?.(title() || (note() ? note()!.title : "")));

  createEffect(on(() => p.id, (id) => {
    if (editor && id !== (note()?.id ?? null)) void load(id);
  }, { defer: true }));

  onCleanup(() => {
    void saver?.flush();
    editor?.destroy();
  });

  const onKey = (e: KeyboardEvent) => {
    if (bar()) return barKeys(e);
    if (explain() && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setExplain(null);
      return editor?.view.focus();
    }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "j") {
      e.preventDefault();
      openBar();
    }
  };
  document.addEventListener("keydown", onKey, true);
  onCleanup(() => document.removeEventListener("keydown", onKey, true));

  async function findRelated() {
    const n = note();
    if (!n) return;
    if (!p.aiReady) return p.onAiSetup();
    setRelated("loading");
    try {
      setRelated(await (await api()).aiRelated(n.id));
    } catch (e) {
      setRelated(null);
      say(errText(e), { error: true });
    }
  }

  const insertExplain = () => {
    const x = explain();
    if (!x?.text) return;
    const v = view();
    const line = v.state.doc.lineAt(x.at);
    v.dispatch({ changes: { from: line.to, insert: `\n\n> ${x.text.replace(/\n/g, "\n> ")}` } });
    setExplain(null);
    v.focus();
  };

  const saveLabel = () =>
    ({ saved: "Saved", dirty: "Editing", saving: "Saving…", error: "Not saved" })[save()];
  const synced = () => /google drive|googledrive|my drive|onedrive|dropbox|syncthing/i.test(p.root);

  return (
    <div class="page">
      <div class="page-main">
        <div class="sheet">
          <input
            ref={titleInput}
            class="title-input"
            placeholder="Title"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                editor?.view.focus();
              } else if (e.key === "Escape" && note()) {
                e.preventDefault();
                e.stopPropagation();
                setTitle(note()!.title);
                editor?.view.focus();
              }
            }}
          />
          <div class="writer" ref={host} />
        </div>
        <Show when={links().linked.length || links().mentioned.length || related()}>
          <div class="page-links">
            <Show when={links().linked.length}>
              <h4>Linked from</h4>
              <For each={links().linked}>
                {(b) => (
                  <button class="link-row" onClick={() => p.onOpen(b.id)}>
                    <span class="link-title">{b.title}</span>
                    <span class="link-line">{b.line.replace(/\[\[|\]\]/g, "")}</span>
                  </button>
                )}
              </For>
            </Show>
            <Show when={links().mentioned.length}>
              <h4>Mentioned in</h4>
              <For each={links().mentioned}>
                {(b) => (
                  <button class="link-row" onClick={() => p.onOpen(b.id)}>
                    <span class="link-title">{b.title}</span>
                    <span class="link-line">{b.line}</span>
                  </button>
                )}
              </For>
            </Show>
            <Show when={related()}>
              <h4>
                <span class="spark">✦</span> Related
              </h4>
              <Show when={Array.isArray(related())} fallback={<p class="ai-thinking">Claude is looking through your notes…</p>}>
                <Show when={(related() as AiRelated[]).length} fallback={<p class="muted small">Nothing closely related.</p>}>
                  <For each={related() as AiRelated[]}>
                    {(r) => (
                      <button class="link-row" onClick={() => p.onOpen(r.id)}>
                        <span class="link-title">{r.title}</span>
                        <span class="link-line">{r.why}</span>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </Show>
          </div>
        </Show>
      </div>
      <footer class="page-foot">
        <span>{folderName(note()?.folder ?? p.folder)}</span>
        <Show when={words()}>
          <span>{words()} words</span>
        </Show>
        <span class="grow" />
        <span class="state" classList={{ bad: save() === "error" }} title={synced() ? p.root : undefined}>
          {saveLabel()}
        </span>
      </footer>

      <Show when={bar()}>
        {(b) => (
          <div class="ai-bar" style={{ left: `${Math.max(12, b().x)}px`, top: `${Math.max(56, b().y)}px` }} onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
            <Show
              when={!b().ask}
              fallback={
                <form
                  class="ai-ask"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const r = range();
                    const i = asking().trim();
                    if (i) void run("custom", r.from, r.to, i);
                    setAsking("");
                  }}
                >
                  <span class="spark">✦</span>
                  <input
                    autofocus
                    ref={(el) => setTimeout(() => el.focus())}
                    placeholder="What should Claude do with this?"
                    value={asking()}
                    onInput={(e) => setAsking(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setBar(null);
                        view().focus();
                      }
                    }}
                  />
                </form>
              }
            >
              <span class="spark">✦</span>
              <For each={BAR}>
                {(x, i) => (
                  <button
                    class="ai-bar-btn"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      const r = range();
                      void run(x.task, r.from, r.to);
                    }}
                  >
                    {x.label} <kbd>{i() + 1}</kbd>
                  </button>
                )}
              </For>
              <button class="ai-bar-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setBar({ ...b(), ask: true })}>
                Ask… <kbd>A</kbd>
              </button>
            </Show>
          </div>
        )}
      </Show>

      <Show when={slash()}>
        {(s) => (
          <div class="menu slash" style={{ left: `${s().x}px`, top: `${s().y}px` }}>
            <div class="menu-head">
              <span class="spark">✦</span> Ask Claude
            </div>
            <For each={SLASH}>
              {(x, i) => (
                <button class="menu-item" classList={{ on: i() === s().i }} onMouseDown={(e) => e.preventDefault()} onClick={() => slashRun(x.task)}>
                  <span>{x.label}</span>
                  <span class="muted">{x.hint}</span>
                </button>
              )}
            </For>
          </div>
        )}
      </Show>

      <Show when={explain()}>
        {(x) => (
          <div class="explain" style={{ left: `${Math.min(x().x, innerWidth - 380)}px`, top: `${x().y}px` }}>
            <div class="menu-head">
              <span class="spark">✦</span> Explained
            </div>
            <p classList={{ "ai-thinking": x().text === null }}>{x().text ?? "Claude is reading…"}</p>
            <div class="row">
              <button class="btn small" disabled={!x().text} onClick={insertExplain}>
                Add below as a quote
              </button>
              <button class="btn small" onClick={() => setExplain(null)}>
                Close <kbd>Esc</kbd>
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
