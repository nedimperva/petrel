// The writing page: a note's title and text in Literata and one quiet line below (where it lives, words, saved).
// What links here, and related notes when asked, sit under the text. AI only when asked: `Ctrl J` on a selection, `/` on an empty
// line; under the built-in tasks Ctrl J lists the Prompts collection, and a prompt runs on the selection (or the
// whole note) and is shown beside the text like Tidy. Saves go through the note saver (300 ms, conflict copies), exactly as before the redesign. A day's page
// (`journal/YYYY-MM-DD.md`) has the date for a title, the month beside it, and the time at the start of each entry.
// Pasted pictures are saved next to the note and shown under their line.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type AiRelated, type AiTask, type Backlinks, type Note, type NoteSummary } from "../api";
import { blanks, fill, todayText } from "../blanks";
import FillBlanks from "../collection/FillBlanks";
import { lastVersions } from "../collection/BlankFields";
import { lastFirst, versionsOf } from "../collection/versions";
import { toggleTask } from "../editor/commands";
import { createEditor, type EditorHandle } from "../editor/editor";
import { cleanPaste } from "../editor/paste";
import { pictureExtensions } from "../editor/pictures";
import { addDays, clock, dayTitle, isDayNote, JOURNAL, monthGrid, today } from "../journal/days";
import { dayExtensions } from "../journal/stamps";
import { linkExtensions } from "../notes/links";
import { createNoteSaver, type NoteSaver, type SaveState } from "../notes/saver";
import { prefs } from "../settings/prefs";
import { wordCount } from "../copy";
import { folderName, KeyHints, say } from "../ui";
import { rank } from "../palette/match";
import { aiPreview, keepPreview, previewOf, setPreview, type Preview } from "./aiPreview";
import { currentHeading, outline, type Heading } from "./outline";
import { EditorView } from "@codemirror/view";

export interface NotePageHandle {
  note(): Note | null;
  text(): string;
  flush(): Promise<boolean>;
  /** Selection, or the whole note when nothing is selected. */
  selectedText(): string;
  ai(task: AiTask): void;
  findRelated(): void;
  /** The line (or the selected lines) becomes a task, or a task is ticked. */
  task(): void;
  reload(): Promise<void>;
  /** Unsaved typing in it. */
  dirty(): boolean;
  /** The file changed on disk: load it again where you were. False when it could not be. */
  refresh(): Promise<boolean>;
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
  /** The note being written on, once it is a file: for Back (Ctrl Tab). */
  onNoteId?(id: number | null): void;
  /** Open a note on the right (Shift Enter on a link). */
  onBeside?(id: number): void;
  /** A note is open beside: the margin is taken. */
  besideOpen?: boolean;
  /** A line in the footer for a moment ("Updated from Drive"). */
  notice?: string | null;
  /** A day's page (`YYYY-MM-DD`) that may not have a file yet. */
  day?: string | null;
  /** Go to another day's page. */
  onDay?(day: string): void;
  onAiSetup(): void;
  ref(h: NotePageHandle): void;
}

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
  prompt: "Your prompt",
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
  // The one AI menu (Ctrl J, or `/` on an empty line). `whole`: nothing was selected when it opened.
  const [menu, setMenu] = createSignal<{ x: number; y: number; i: number; q: string; whole: boolean; from: number; to: number; head: number } | null>(null);
  const [explain, setExplain] = createSignal<{ x: number; y: number; text: string | null; at: number } | null>(null);
  // The last AI request, for Try again.
  let last: { task: AiTask; from: number; to: number; instruction?: string; label?: string } | null = null;
  // Ctrl J's own prompts: the Prompts collection, the most copied first.
  const [prompts, setPrompts] = createSignal<NoteSummary[]>([]);
  const [filling, setFilling] = createSignal<{ title: string; text: string; from: number; to: number; selected: string } | null>(null);
  let seq = 0;

  /** The day this page is, if it is a day's page: from the view, or from the note that was opened. */
  const dayPage = (): string | null => {
    if (p.day) return p.day;
    const n = note();
    return n && isDayNote(n.folder, n.title) ? n.title : null;
  };
  // The days that have a page, for the month. A signal, not a resource: a resource read here would suspend the
  // whole page (App's Suspense) on every day change and take the focus out of the text.
  const [journal, setJournal] = createSignal<Set<string>>(new Set());
  createEffect(
    on(
      () => (dayPage() ? `${dayPage()}:${note()?.id ?? ""}` : null),
      (k) => {
        if (k)
          void api()
            .then((s) => s.listNotes({ folder: JOURNAL, limit: 1000 }))
            .then((ns) => setJournal(new Set(ns.map((n) => n.title))), () => {});
      },
    ),
  );

  const loadLinks = async (id: number) => setLinks(await (await api()).backlinks(id).catch(() => ({ linked: [], mentioned: [] })));

  async function load(id: number | null) {
    await saver?.flush();
    setRelated(null);
    setMenu(null);
    setExplain(null);
    if (id === null) {
      saver.load(null);
      setNote(null);
      setTitle("");
      setLinks({ linked: [], mentioned: [] });
      setWords(0);
      setHeads([]);
      if (p.day) {
        // Today's empty page starts with the time; it is not a file until something is written after it.
        if (p.day === today()) editor?.load(`${clock()} `, 6);
        editor?.view.focus();
      } else titleInput?.focus();
      return;
    }
    try {
      const n = await (await api()).openNote(id);
      saver.load(n);
      setTitle(n.title);
      measure();
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

  async function run(task: AiTask, from: number, to: number, instruction?: string, label?: string) {
    if (!p.aiReady) return p.onAiSetup();
    setMenu(null);
    const v = view();
    const doc = v.state.doc;
    const text = task === "continue" || task === "summarize" ? doc.sliceString(0, to) : task === "title" ? doc.toString() : doc.sliceString(from, to);
    if (!text.trim()) return say("There is no text to work on yet");
    last = { task, from, to, instruction, label };
    const mine = ++seq;
    await saver.flush();
    if (task === "explain") {
      const c = v.coordsAtPos(to);
      setExplain({ x: c?.left ?? 0, y: (c?.bottom ?? 0) + 6, text: null, at: to });
    } else if (task !== "title") {
      // Continue and summarize write at the cursor; the rest replace the text they read.
      const at = task === "continue" || task === "summarize" ? to : from;
      v.dispatch({ effects: setPreview.of({ from: at, to: task === "continue" || task === "summarize" ? at : to, text: null, error: null, label: label ?? LABELS[task] }) });
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
      void run(last.task, from, to, last.instruction, last.label);
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

  /** Ctrl J, or `/` on an empty line: the one AI menu, below the text it will work on. The rewrites read the
   * selection (or the paragraph at the cursor); your prompts read the selection, or the whole note when nothing
   * was selected. */
  function openMenu() {
    if (!editor || previewOf(view().state)) return;
    const v = view();
    const sel = v.state.selection.main;
    if (!v.state.doc.length) return say("Write something first");
    const r = range();
    if (r.from !== r.to) v.dispatch({ selection: { anchor: r.from, head: r.to } });
    const c = v.coordsAtPos(r.from !== r.to ? r.to : sel.head);
    void loadPrompts();
    setMenu({ x: c?.left ?? 0, y: (c?.bottom ?? 0) + 6, i: 0, q: "", whole: sel.empty, from: r.from, to: r.to, head: sel.head });
  }

  const closeMenu = () => {
    setMenu(null);
    view().focus();
  };

  async function loadPrompts() {
    const s = await api();
    const [all, counts] = await Promise.all([s.listNotes({ limit: 2000 }), s.copyCounts()]);
    setPrompts(
      all
        .filter((n) => /prompt/i.test(n.folder.split("/")[0]))
        .sort((a, b) => (counts[b.path] ?? 0) - (counts[a.path] ?? 0) || a.title.localeCompare(b.title))
        .slice(0, 8),
    );
  }

  /** One of your prompts on the selection, or on the whole note when nothing was selected. `{{text}}`,
   * `{{code}}`, `{{selection}}` and `{{note}}` are that text; other blanks are asked first. */
  async function runPrompt(n: NoteSummary, r: { from: number; to: number }) {
    if (!p.aiReady) return p.onAiSetup();
    const v = view();
    const body = (await (await api()).peekNote(n.id)).body.replace(/\n+$/, "");
    const vs = lastFirst(versionsOf(body), (await lastVersions())[n.path]);
    const text = vs.length ? vs[0].text : body;
    const selected = v.state.sliceDoc(r.from, r.to);
    // A blank for the text itself is the text the prompt runs on; only the others are asked.
    const pre = fill(text, { selection: selected, text: selected, code: selected, note: selected, today: todayText() });
    if (blanks(pre).length) return setFilling({ title: n.title, text: pre, ...r, selected });
    void run("prompt", r.from, r.to, pre, n.title);
  }

  /** The paragraph above an empty line, for "Turn into a checklist" from `/`. */
  function paragraphAbove(head: number): { from: number; to: number } | null {
    const doc = view().state.doc;
    let n = doc.lineAt(head).number - 1;
    while (n >= 1 && !doc.line(n).text.trim()) n--;
    if (n < 1) return null;
    let a = n;
    while (a > 1 && doc.line(a - 1).text.trim()) a--;
    return { from: doc.line(a).from, to: doc.line(n).to };
  }

  interface MenuItem {
    label: string;
    hint: string;
    go(): void;
  }

  /** What the menu offers now, narrowed by what is typed. Typed words that match nothing are an ask. */
  const menuItems = (): MenuItem[] => {
    const m = menu();
    if (!m) return [];
    const has = m.to > m.from;
    const len = view().state.doc.length;
    const out: MenuItem[] = [];
    if (has) {
      for (const [task, label] of [
        ["tidy", "Tidy"],
        ["shorten", "Shorten"],
        ["list", "Make a list"],
        ["checklist", "Turn into a checklist"],
        ["explain", "Explain"],
      ] as const)
        out.push({ label, hint: m.whole ? "this paragraph" : "the selection", go: () => void run(task, m.from, m.to) });
    } else {
      const above = paragraphAbove(m.head);
      if (above) out.push({ label: "Turn into a checklist", hint: "the paragraph above", go: () => void run("checklist", above.from, above.to) });
    }
    out.push({ label: "Continue writing", hint: "from the cursor", go: () => void run("continue", m.head, m.head) });
    out.push({ label: "Summarize", hint: "the text above the cursor", go: () => void run("summarize", m.head, m.head) });
    out.push({ label: "Suggest a title", hint: "renames the note if you keep it", go: () => void run("title", 0, len) });
    const promptRange = m.whole ? { from: 0, to: len } : { from: m.from, to: m.to };
    for (const n of prompts())
      out.push({ label: n.title, hint: m.whole ? "your prompt · the whole note" : "your prompt · the selection", go: () => void runPrompt(n, promptRange) });
    const q = m.q.trim();
    if (!q) return out;
    const found = rank(q, out, (x) => x.label);
    const target = has ? { from: m.from, to: m.to } : { from: 0, to: len };
    return [...found, { label: `Ask: “${q}”`, hint: has ? "rewrite it this way" : "rewrite the note this way", go: () => void run("custom", target.from, target.to, q) }];
  };

  const menuKey = (e: KeyboardEvent) => {
    const m = menu();
    if (!m) return;
    const items = menuItems();
    const n = items.length;
    const digit = Number(e.key);
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setMenu({ ...m, i: (m.i + 1) % Math.max(1, n) });
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setMenu({ ...m, i: (m.i + n - 1) % Math.max(1, n) });
    else if (e.key === "Enter") {
      const it = items[m.i];
      setMenu(null);
      if (it) it.go();
      else view().focus();
    } else if (e.key === "Escape" || (e.ctrlKey && e.key.toLowerCase() === "j")) closeMenu();
    else if (!m.q && digit >= 1 && digit <= Math.min(9, n)) {
      setMenu(null);
      items[digit - 1].go();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  // ---- headings in the margin ---------------------------------------------------------------------------------

  const [heads, setHeads] = createSignal<Heading[]>([]);
  const [here, setHere] = createSignal(-1);
  // The margin steps back while you type, and comes back when you stop.
  const [typingNow, setTypingNow] = createSignal(false);
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  const measure = () => {
    const t = editor?.text() ?? "";
    setWords(wordCount(t));
    setHeads(outline(t));
    setHere(currentHeading(heads(), editor?.cursor() ?? 0));
  };
  const minLevel = () => Math.min(...heads().map((h) => h.level));
  const jump = (from: number) => {
    const v = view();
    v.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "start", yMargin: 80 }) });
    v.focus();
  };

  onMount(() => {
    editor = createEditor(host, () => {
      saver.changed();
      measure();
      setTypingNow(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => setTypingNow(false), 1500);
      setMenu(null);
      setExplain(null);
    });
    saver = createNoteSaver({
      store: api,
      editor: () => editor,
      note,
      setNote,
      setSave,
      fresh: () => ({ folder: p.folder, title: dayPage() ?? title() }),
      conflict: (path) => say(`This note was also changed elsewhere. That copy is kept as ${path}.`, { error: true }),
    });
    editor.setExtra([
      EditorView.updateListener.of((u) => {
        if (u.selectionSet || u.docChanged) setHere(currentHeading(heads(), u.state.selection.main.head));
      }),
      aiPreview(actions),
      cleanPaste(() => say("Pasted as Markdown. Ctrl Z for plain text.")),
      pictureExtensions(() => note()?.folder ?? p.folder),
      dayExtensions(() => dayPage() === today()),
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
        beside: async (inner) => {
          const r = await (await api()).resolveLink(inner);
          if (r.kind === "note") p.onBeside?.(r.id);
          else say("That note does not exist yet. Alt Enter makes it.");
        },
      }),
    ]);
    editor.view.contentDOM.addEventListener("keydown", (e) => {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const s = view().state;
        const line = s.doc.lineAt(s.selection.main.head);
        if (!line.text.trim() && s.selection.main.empty) {
          e.preventDefault();
          openMenu();
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
      task: () => {
        toggleTask(view());
        view().focus();
      },
      reload: () => load(note()?.id ?? null),
      dirty: () => saver.dirty(),
      refresh: async () => {
        const n = note();
        if (!n || saver.dirty() || !editor || previewOf(view().state)) return false;
        const fresh = await (await api()).openNote(n.id).catch(() => null);
        if (!fresh || saver.dirty()) return false;
        if (fresh.body === editor.text()) {
          setNote({ ...n, hash: fresh.hash, modifiedAt: fresh.modifiedAt });
          return true;
        }
        const at = editor.cursor();
        const top = editor.view.scrollDOM.scrollTop;
        saver.load(fresh);
        editor.select(at, at);
        editor.view.scrollDOM.scrollTop = top;
        measure();
        return true;
      },
      focus: () => editor?.view.focus(),
    });
    void load(p.id);
  });

  createEffect(() => editor?.setTypewriter(prefs().typewriter));
  createEffect(() => editor?.setFocusMode(prefs().focus));
  createEffect(on(() => note()?.id ?? null, (id) => p.onNoteId?.(id)));
  createEffect(() => {
    const d = dayPage();
    p.onTitle?.(d ? (d === today() ? "Today" : dayTitle(d)) : title() || (note() ? note()!.title : ""));
  });

  // Another note, or another day whose page has no file yet (the id stays null): load again.
  createEffect(on(() => [p.id, p.day] as const, ([id, day], prev) => {
    if (editor && (id !== (note()?.id ?? null) || day !== prev?.[1])) void load(id);
  }, { defer: true }));

  onCleanup(() => {
    void saver?.flush();
    editor?.destroy();
  });

  const onKey = (e: KeyboardEvent) => {
    if (explain() && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setExplain(null);
      return editor?.view.focus();
    }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "j") {
      e.preventDefault();
      if (menu()) closeMenu();
      else openMenu();
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
          <Show when={dayPage()}>
            {(d) => (
              <div class="day-head">
                <h1 class="day-title">{dayTitle(d())}</h1>
                <span class="day-nav">
                  <button class="icon-btn" title="The day before (Alt ←)" aria-label="The day before" onClick={() => p.onDay?.(addDays(d(), -1))}>
                    ‹
                  </button>
                  <Show when={d() !== today()}>
                    <button class="link small" onClick={() => p.onDay?.(today())}>
                      Today
                    </button>
                  </Show>
                  <button class="icon-btn" title="The day after (Alt →)" aria-label="The day after" onClick={() => p.onDay?.(addDays(d(), 1))}>
                    ›
                  </button>
                </span>
              </div>
            )}
          </Show>
          <input
            ref={titleInput}
            hidden={!!dayPage()}
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
      <Show when={dayPage()}>
        {(d) => (
          <aside class="day-month" aria-label="This month">
            <div class="day-month-name">{new Date(`${d()}T12:00`).toLocaleDateString(undefined, { month: "long" })}</div>
            <div class="day-grid">
              <For each={["M", "T", "W", "T", "F", "S", "S"]}>{(w) => <span class="day-wd">{w}</span>}</For>
              <For each={monthGrid(d())}>
                {(x) =>
                  x ? (
                    <button
                      class="day-cell"
                      classList={{ on: x === d(), has: journal().has(x), future: x > today() }}
                      aria-label={dayTitle(x)}
                      onClick={() => p.onDay?.(x)}
                    >
                      {Number(x.slice(8))}
                    </button>
                  ) : (
                    <span />
                  )
                }
              </For>
            </div>
            <p class="muted small">A dot is a day with a page. A day you skip makes no file.</p>
          </aside>
        )}
      </Show>
      <Show when={!dayPage() && !p.besideOpen && heads().length >= 3}>
        <nav class="note-outline" classList={{ quiet: typingNow() }} aria-label="Headings">
          <For each={heads()}>
            {(h, i) => (
              <button
                class="outline-row"
                classList={{ on: i() === here() }}
                style={{ "padding-left": `${(h.level - minLevel()) * 12 + 8}px` }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => jump(h.from)}
              >
                {h.text}
              </button>
            )}
          </For>
        </nav>
      </Show>
      <footer class="page-foot">
        <span>{dayPage() ? "Journal" : folderName(note()?.folder ?? p.folder)}</span>
        <Show when={words()}>
          <span>{words()} words</span>
        </Show>
        <Show when={dayPage()}>
          <span>
            <kbd>Alt ←</kbd> <kbd>Alt →</kbd> other days
          </span>
        </Show>
        <Show when={p.notice}>
          <span class="notice">{p.notice}</span>
        </Show>
        <span class="grow" />
        <span class="state" classList={{ bad: save() === "error", saved: save() === "saved" && !!note() }} title={synced() ? p.root : undefined}>
          {saveLabel()}
        </span>
      </footer>

      <Show when={menu()}>
        {(m) => (
          <div
            class="menu ai-menu"
            style={{ left: `${Math.max(12, Math.min(m().x, innerWidth - 380))}px`, top: `${Math.max(56, Math.min(m().y, innerHeight - 380))}px` }}
            role="dialog"
            aria-label="Ask Claude"
          >
            <div class="ai-menu-field">
              <span class="spark">✦</span>
              <input
                ref={(el) => setTimeout(() => el.focus())}
                placeholder="Pick one, or say what to do…"
                value={m().q}
                onInput={(e) => setMenu({ ...m(), q: e.currentTarget.value, i: 0 })}
                onKeyDown={menuKey}
                onBlur={() => setMenu(null)}
              />
            </div>
            <div class="ai-menu-list" role="listbox">
              <For each={menuItems()}>
                {(x, i) => (
                  <button
                    class="menu-item"
                    role="option"
                    aria-selected={i() === m().i}
                    classList={{ on: i() === m().i }}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => i() !== m().i && setMenu({ ...m(), i: i() })}
                    onClick={() => {
                      setMenu(null);
                      x.go();
                    }}
                  >
                    <Show when={!m().q && i() < 9}>
                      <kbd>{i() + 1}</kbd>
                    </Show>
                    <span>{x.label}</span>
                    <span class="muted">{x.hint}</span>
                  </button>
                )}
              </For>
            </div>
            <footer class="ai-menu-foot">
              <KeyHints hints={[["1–9", "pick"], ["Enter", "run"], ["Esc", "close"]]} />
            </footer>
          </div>
        )}
      </Show>

      <Show when={filling()}>
        {(f) => (
          <FillBlanks
            title={f().title}
            text={f().text}
            selection={f().selected}
            action="Run"
            onClose={() => (setFilling(null), view().focus())}
            onCopy={(t) => {
              const x = f();
              setFilling(null);
              view().focus();
              void run("prompt", x.from, x.to, t, x.title);
            }}
          />
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
