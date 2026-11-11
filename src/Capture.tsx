// The capture window (`petrel --capture`, Ctrl Alt Space): text, and one quiet line under it. The file is made in
// inbox/ on the first keystroke and saved as you type. Text selected in the app you were in comes in as a quote
// with where it came from. `#recipes` or `#today` in the text, or `>Groceries`, says where it goes (the list
// offers places as you type, and the word is taken out); Tab picks a place from a list. Ctrl Enter or Esc saves
// and closes. An empty capture leaves nothing behind. A pasted picture is saved next to it.

import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { api, inTauri, type Note } from "./api";
import { createEditor, type EditorHandle } from "./editor/editor";
import { pictureExtensions } from "./editor/pictures";
import Destination, { targetFolder, targetLabel, type Target } from "./inbox/Destination";
import { fileCapture } from "./inbox/file";
import { quoteBlock } from "./inbox/quote";
import { pickRoute, strip, tokens, typingToken } from "./inbox/route";
import Mark, { loadFaces } from "./library/Mark";
import { completionTheme } from "./notes/links";
import { createNoteSaver, type SaveState } from "./notes/saver";
import { applyPrefs, parsePrefs } from "./settings/prefs";
import { folderName } from "./ui";

/** Top folders a capture can be filed in by name. */
async function places(): Promise<string[]> {
  const fs = await (await api()).noteFolders();
  return fs.map((f) => f.path).filter((f) => !f.includes("/") && f !== "inbox" && f !== "journal" && !f.startsWith("."));
}

export default function Capture() {
  let host!: HTMLDivElement;
  let editor: EditorHandle | undefined;
  const [note, setNote] = createSignal<Note | null>(null);
  const [save, setSave] = createSignal<SaveState>("saved");
  const [target, setTarget] = createSignal<Target | null>(null);
  const [targetHome, setTargetHome] = createSignal("");
  const [choosing, setChoosing] = createSignal(false);
  const [quoted, setQuoted] = createSignal(false);
  const [msg, setMsg] = createSignal<string | null>(null);
  let closing = false;
  let folders: string[] = [];

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

  /** The suggestion list for `#` and `>`: picking one sets where the capture goes and takes the word out. */
  async function suggest(ctx: CompletionContext): Promise<CompletionResult | null> {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const t = typingToken(line.text.slice(0, ctx.pos - line.from));
    if (!t) return null;
    const from = ctx.pos - t.back;
    const w = t.word.toLowerCase();
    const pick = (to: Target, home: string) => (view: EditorView, _c: Completion, a: number, b: number) => {
      // One space goes with the word: the one after it, or else the one before.
      const end = view.state.doc.sliceString(b, b + 1) === " " ? b + 1 : b;
      const start = end === b && view.state.doc.sliceString(a - 1, a) === " " ? a - 1 : a;
      view.dispatch({ changes: { from: start, to: end, insert: "" } });
      setTarget(to);
      setTargetHome(home);
    };
    let options: Completion[];
    if (t.sign === "#") {
      const fs = folders.filter((f) => !w || f.toLowerCase().includes(w));
      options = [
        ...("today".startsWith(w) ? [{ label: "#today", detail: "Today's page", apply: pick({ kind: "day" }, "journal") }] : []),
        ...fs.map((f) => ({ label: `#${f}`, detail: "collection", apply: pick({ kind: "folder", folder: f }, f) })),
      ];
      if (w && !folders.some((f) => f.toLowerCase() === w)) {
        options.push({ label: `#${t.word}`, detail: `new collection “${t.word}”`, apply: pick({ kind: "folder", folder: t.word }, t.word) });
      }
    } else {
      if (!w) return null;
      const ns = (await (await api()).findNotes(t.word.replace(/-/g, " "), 8)).filter((n) => n.folder !== "inbox" && n.id !== note()?.id);
      options = ns.map((n) => ({ label: `>${n.title}`, detail: `add to the end · ${folderName(n.folder)}`, apply: pick({ kind: "note", id: n.id, title: n.title }, n.folder) }));
    }
    return options.length ? { from, options, filter: false } : null;
  }

  /** A `#word` or `>word` left in the text when Esc is pressed still routes it, and is taken out. */
  async function routeFromText(): Promise<void> {
    if (target() || !editor) return;
    const text = editor.text();
    const words = tokens(text).filter((t) => t.sign === ">").map((t) => t.word);
    const s = await api();
    const titles = (await Promise.all(words.map((w) => s.findNotes(w.replace(/-/g, " "), 5)))).flat().filter((n) => n.folder !== "inbox");
    const r = pickRoute(text, folders, titles.map((n) => n.title));
    if (!r) return;
    const v = editor.view;
    const after = strip(text, r.token);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: after } });
    if (r.route.kind === "note") {
      const title = r.route.title;
      const n = titles.find((x) => x.title === title)!;
      setTarget({ kind: "note", id: n.id, title: n.title });
    } else setTarget(r.route.kind === "day" ? { kind: "day" } : { kind: "folder", folder: r.route.folder });
  }

  async function done() {
    if (closing) return;
    closing = true;
    const s = await api();
    await routeFromText().catch((e) => console.error(e));
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
    // The suggestion list takes Esc, Enter and Tab while it is open.
    if (document.querySelector(".cm-tooltip-autocomplete")) return;
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
    editor = createEditor(host, () => saver.changed(), { placeholder: "Write it down. #topic or #today files it." });
    editor.setExtra([
      pictureExtensions(() => "inbox"),
      autocompletion({ override: [suggest], activateOnTyping: true, icons: false, closeOnBlur: true }),
      completionTheme,
    ]);
    editor.view.focus();
    const s = await api();
    const ctx = s.captureContext().catch(() => null);
    await s.showWindow();
    s.uiSettings().then((m) => applyPrefs(parsePrefs(m)), () => {});
    void loadFaces();
    places().then((f) => (folders = f), () => {});
    window.addEventListener("keydown", onKey, true);
    const c = await ctx;
    const quote = c ? quoteBlock(c) : "";
    if (quote && editor && !editor.text()) {
      editor.insert(quote, true);
      editor.select(quote.length, quote.length);
      setQuoted(true);
    }
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
          <Mark folder={targetFolder(target(), targetHome())} size={12} />
          {target()?.kind === "note" ? "Add to " : ""}
          {targetLabel(target())}
        </button>
        <Show when={quoted()}>
          <span class="muted" data-tauri-drag-region>
            with the quote
          </span>
        </Show>
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
            setTargetHome(t.kind === "folder" ? t.folder : "");
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
