// The capture window (`petrel --capture` or the capture hotkey): text, and one quiet line under it. The file is made in
// inbox/ on the first keystroke and saved as you type. Text selected in the app you were in comes in as a quote
// with where it came from. `@recipes`, `@today`, a day (`@fri`, `@nov20`) or a note (`@Groceries`) in the text
// says where it goes (the list offers places as you type, and the word is taken out); Ctrl K picks a
// place from a list. Esc saves and closes. An empty capture leaves nothing behind. A pasted picture is saved next
// to it; pasted HTML comes in as Markdown.
//
// Keep going: opened again within two minutes of the last capture, the window adds the new text under it, in the
// same file. The old text is folded away behind a line at the top that shows its last line, where the new words
// follow (click it to see it all, faded). Ctrl
// Enter makes the new text a capture of its own instead.
//
// Ctrl D sends it to today's page and back to the inbox, as Ctrl D opens today's page in the main window. The line
// at the top then shows the page's last entry, so you see where the words land.
//
// The bar under the text holds only the place and Esc; `?` lists the window's keys.

import { autocompletion, startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, inTauri, type Note } from "./api";
import { createEditor, type EditorHandle } from "./editor/editor";
import { cleanPaste } from "./editor/paste";
import { pictureExtensions } from "./editor/pictures";
import Destination, { targetFolder, targetLabel, type Target } from "./inbox/Destination";
import { fileCapture } from "./inbox/file";
import { quoteBlock, titleLine } from "./inbox/quote";
import { titleFrom } from "./copy";
import { pickRoute, strip, tokens, typingToken } from "./inbox/route";
import { dayOptions, dayTitle, dayWord, today } from "./journal/days";
import Mark, { loadFaces } from "./library/Mark";
import { completionTheme } from "./notes/links";
import { createNoteSaver, type SaveState } from "./notes/saver";
import { applyPrefs, parsePrefs } from "./settings/prefs";
import { keyLabel, matches, SHORTCUTS } from "./keys";
import { folderName, Kbd, say, ToastView } from "./ui";
import { rest, whenOpened } from "./warm";

/** Opening the window again within this long adds to the last capture. */
const KEEP_GOING_MS = 2 * 60 * 1000;
const LAST = "ui.capture.last";

/** Top folders a capture can be filed in by name. */
async function places(): Promise<string[]> {
  const fs = await (await api()).noteFolders();
  return fs.map((f) => f.path).filter((f) => !f.includes("/") && f !== "inbox" && f !== "journal" && !f.startsWith("."));
}

/** The last line with words in it, where the new text will follow: a quote's `> ` and a task's box taken off. */
function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim().replace(/^>\s?/, "").replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ""))
    .filter((l) => /[\p{L}\p{N}]/u.test(l) && l !== "_from capture_");
  const last = lines.length ? lines[lines.length - 1] : titleLine(text);
  // A long line shows its end, the words the new text follows.
  if (last.length <= 64) return last;
  const tail = last.slice(-64);
  return `…${tail.slice(tail.indexOf(" ") + 1)}`;
}

/** Where the last capture's text ends; it is drawn faded and follows edits made before it. */
const setEndEffect = StateEffect.define<number>();
const earlierEnd = StateField.define<number>({
  create: () => 0,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setEndEffect)) return e.value;
    return v ? tr.changes.mapPos(v, -1) : v;
  },
});
/** The quote at the top, from the app you were in, drawn as a card above your own words. */
const quoteLine = Decoration.line({ class: "cap-quote-line" });
const quoteCard = EditorView.decorations.compute(["doc"], (s) => {
  const b = new RangeSetBuilder<Decoration>();
  for (let n = 1; n <= s.doc.lines; n++) {
    const line = s.doc.line(n);
    if (!line.text.startsWith(">")) break;
    b.add(line.from, line.from, quoteLine);
  }
  return b.finish();
});

const faded = Decoration.mark({ class: "cm-earlier" });
const earlierDeco = EditorView.decorations.compute([earlierEnd], (s) => {
  const end = s.field(earlierEnd);
  return end > 0 ? Decoration.set([faded.range(0, end)]) : Decoration.none;
});

/** Whether the last capture's text is folded away (it is, until the line at the top is clicked). */
const setFoldEffect = StateEffect.define<boolean>();
const earlierFolded = StateField.define<boolean>({
  create: () => true,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setFoldEffect)) return e.value;
    return v;
  },
});
/** Where the folded part ends: the old text and the blank line after it, so the cursor starts on a clean line. */
function foldEnd(s: EditorState): number {
  const end = s.field(earlierEnd, false) ?? 0;
  if (!end || !s.field(earlierFolded, false)) return 0;
  const line = s.doc.lineAt(end);
  if (line.number < s.doc.lines) {
    const next = s.doc.line(line.number + 1);
    if (!next.text.trim() && next.number < s.doc.lines) return next.to;
  }
  return line.to;
}
const folded = Decoration.replace({ block: true });
const foldSet = (s: EditorState) => {
  const to = foldEnd(s);
  return to > 0 ? Decoration.set([folded.range(0, to)]) : Decoration.none;
};
const earlierFold: Extension = [
  earlierFolded,
  EditorView.decorations.compute([earlierEnd, earlierFolded], foldSet),
  EditorView.atomicRanges.of((v) => foldSet(v.state)),
  // Folded text can't be seen, so typing, deleting and pasting must not reach it (Backspace at the start would).
  EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"))) return tr;
    const to = foldEnd(tr.startState);
    let touches = false;
    tr.changes.iterChangedRanges((a) => (touches ||= to > 0 && a <= to));
    return touches ? [] : tr;
  }),
];

export default function Capture() {
  let host!: HTMLDivElement;
  let editor: EditorHandle | undefined;
  const [note, setNote] = createSignal<Note | null>(null);
  const [save, setSave] = createSignal<SaveState>("saved");
  const [target, setTarget] = createSignal<Target | null>(null);
  const [targetHome, setTargetHome] = createSignal("");
  const [choosing, setChoosing] = createSignal(false);
  const [quoted, setQuoted] = createSignal(false);
  /** Where an `@word` already typed will file the capture, shown before Esc. Chosen places (`target`) win. */
  const [implied, setImplied] = createSignal<Target | null>(null);
  let quoteText = "";
  let impliedTimer: ReturnType<typeof setTimeout> | undefined;
  const [msg, setMsg] = createSignal<string | null>(null);
  /** The last capture's text when this window is adding to it. */
  const [earlier, setEarlier] = createSignal<string | null>(null);
  const [earlierShown, setEarlierShown] = createSignal(false);
  /** The last entry on today's page, shown at the top while the capture goes there. */
  const [todayLast, setTodayLast] = createSignal<string | null>(null);
  const [help, setHelp] = createSignal(false);
  const [leaving, setLeaving] = createSignal(false);
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

  const end = () => (editor ? editor.view.state.field(earlierEnd, false) ?? 0 : 0);

  /** A new collection named once; a second Enter on it makes it. */
  let armed = "";

  /** The suggestion list for `@`: picking one sets where the capture goes and takes the word out. */
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
    const fs = folders.filter((f) => !w || f.toLowerCase().includes(w));
    const days = dayOptions(w).map((d) => ({
      label: `@${d.word}`,
      detail: d.day === today() ? "Today's page" : `${dayTitle(d.day)}'s page`,
      apply: pick({ kind: "day", date: d.day }, "journal"),
    }));
    const ns = w ? (await (await api()).findNotes(t.word.replace(/-/g, " "), 6)).filter((n) => n.folder !== "inbox" && n.id !== note()?.id) : [];
    const options: Completion[] = [
      ...days,
      ...fs.map((f) => ({ label: `@${f}`, detail: "collection", apply: pick({ kind: "folder", folder: f }, f) })),
      ...ns.map((n) => ({ label: `@${n.title}`, detail: `add to the end · ${folderName(n.folder)}`, apply: pick({ kind: "note", id: n.id, title: n.title }, n.folder) })),
    ];
    if (w && !folders.some((f) => f.toLowerCase() === w) && !days.length && !ns.length) {
      // A new collection is a new folder: a typo must not make one, so it takes Enter twice.
      const make = pick({ kind: "folder", folder: t.word }, t.word);
      const sure = armed === t.word;
      options.push({
        label: `@${t.word}`,
        detail: sure ? `Enter again: new collection “${t.word}”` : `new collection “${t.word}”?`,
        apply: (view, c, a, b) => {
          if (armed === t.word) return make(view, c, a, b);
          armed = t.word;
          say(`“${t.word}” is not a collection yet. Enter again to make it, or keep typing.`);
          setTimeout(() => startCompletion(view));
        },
      });
    }
    return options.length ? { from, options, filter: false } : null;
  }

  /** Reads the `@word`s as they are typed (collections and days; notes are looked up on Esc), a moment after typing. */
  function readImplied() {
    clearTimeout(impliedTimer);
    impliedTimer = setTimeout(() => {
      if (!editor || earlier() !== null) return setImplied(null);
      const r = pickRoute(editor.text(), folders, [], (w) => dayWord(w));
      setImplied(!r ? null : r.route.kind === "day" ? { kind: "day", date: r.route.date } : r.route.kind === "folder" ? { kind: "folder", folder: r.route.folder } : null);
    }, 150);
  }

  /** Takes out the quote brought from the app you were in, if it is still at the top unchanged. */
  function dropQuote() {
    if (!editor || !quoteText) return;
    const v = editor.view;
    if (v.state.doc.sliceString(0, quoteText.length) === quoteText) v.dispatch({ changes: { from: 0, to: quoteText.length, insert: "" } });
    quoteText = "";
    setQuoted(false);
    v.focus();
  }

  /** An `@word` left in the new text when Esc is pressed still routes it, and is taken out. */
  async function routeFromText(): Promise<void> {
    if (target() || !editor || earlier() !== null) return;
    const text = editor.text();
    const words = tokens(text).map((t) => t.word);
    const s = await api();
    const titles = (await Promise.all(words.map((w) => s.findNotes(w.replace(/-/g, " "), 5)))).flat().filter((n) => n.folder !== "inbox");
    const r = pickRoute(text, folders, titles.map((n) => n.title), (w) => dayWord(w));
    if (!r) return;
    const v = editor.view;
    const after = strip(text, r.token);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: after } });
    if (r.route.kind === "note") {
      const title = r.route.title;
      const n = titles.find((x) => x.title === title)!;
      setTarget({ kind: "note", id: n.id, title: n.title });
    } else setTarget(r.route.kind === "day" ? { kind: "day", date: r.route.date } : { kind: "folder", folder: r.route.folder });
  }

  /** A capture left in the inbox is named by its words, not the time it was made: easy to find again. A name
   * already taken gets a number; if none is free it keeps the time. */
  async function nameCapture(id: number, title: string) {
    const s = await api();
    for (const t of [title, `${title} 2`, `${title} 3`, `${title} 4`]) {
      try {
        await s.renameNote(id, t);
        return;
      } catch {
        // Taken: try the next.
      }
    }
  }

  /** Adding to the last capture: nothing new typed leaves it exactly as it was. */
  function dropEmptyTail() {
    const old = earlier();
    if (old === null || !editor) return;
    if (editor.text().slice(end()).trim()) return;
    if (editor.text() === old) return;
    // Only the tail is put back when the old text is untouched, so it stays folded away while the window closes.
    const e = end();
    const doc = editor.view.state.doc;
    const keep = doc.sliceString(0, e) === old.slice(0, e);
    editor.view.dispatch({ changes: keep ? { from: e, to: doc.length, insert: old.slice(e) } : { from: 0, to: doc.length, insert: old } });
  }

  /** Ctrl Enter while adding to the last capture: the new text becomes a capture of its own. */
  async function separate() {
    const old = earlier();
    if (old === null || !editor) return;
    const text = editor.text();
    const head = `${text.slice(0, end()).replace(/\s+$/, "")}\n`;
    const tail = text.slice(end()).replace(/^\s+/, "");
    const v = editor.view;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: head } });
    await saver.flush();
    saver.load(null);
    setNote(null);
    setEarlier(null);
    setEarlierShown(false);
    editor.load(tail, tail.length);
    if (tail) saver.changed();
    say("A new capture. The last one is kept as it was.");
  }

  async function done() {
    if (closing) return;
    closing = true;
    // The text is put back and filed while the window closes: none of that needs to be seen.
    setLeaving(true);
    const s = await api();
    dropEmptyTail();
    await routeFromText().catch((e) => console.error(e));
    const text = editor?.text() ?? "";
    if (!(await saver.flush())) {
      // The engine will not take it: keep the words in a file rather than in a window that is about to close.
      const path = await s.rescueText(text).catch(() => null);
      if (!path) {
        closing = false;
        setLeaving(false);
        return setMsg(`Not saved: ${saver.error() ?? "unknown error"}`);
      }
    }
    const n = note();
    let stays = false;
    try {
      if (n && !text.trim()) await s.trashNote(n.id);
      else if (n && target()) await fileCapture({ ...n, body: text }, target()!);
      else if (n) {
        stays = true;
        if (earlier() === null) await nameCapture(n.id, titleFrom(titleLine(text)));
      }
    } catch (e) {
      // The text is safe in the inbox; filing can be done from there.
      console.error(e);
    }
    // A capture left in the inbox can be added to if the window comes back soon.
    await s.setUiSetting(LAST, stays && n ? `${n.id}:${Date.now()}` : "").catch(() => {});
    await s.closeCapture();
    rest();
  }

  const onKey = (e: KeyboardEvent) => {
    if (choosing()) return;
    // The suggestion list takes Esc, Enter and Tab while it is open.
    if (document.querySelector(".cm-tooltip-autocomplete")) return;
    if (help() && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setHelp(false);
    } else if (matches(e, "capToday")) {
      e.preventDefault();
      e.stopPropagation();
      void toggleToday();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && earlier() !== null) {
      e.preventDefault();
      e.stopPropagation();
      void separate();
    } else if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) {
      e.preventDefault();
      e.stopPropagation();
      void done();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      // Ctrl K finds, here too: a place for the capture.
      e.preventDefault();
      e.stopPropagation();
      setChoosing(true);
    }
  };

  const goesToday = () => {
    const t = target() ?? implied();
    return t?.kind === "day" && (!t.date || t.date === today());
  };

  /** Ctrl D: today's page, or back to the inbox. While adding to the last capture, the new words go on their
   * own: the last capture stays in the inbox as it was. */
  async function toggleToday() {
    if (earlier() !== null) await separate();
    if (target()?.kind === "day" && goesToday()) {
      setTarget(null);
      setTargetHome("");
    } else {
      setTarget({ kind: "day", date: today() });
      setTargetHome("journal");
    }
    editor?.view.focus();
  }

  /** The last line of today's page with words in it, `07:02 coffee` as written. */
  async function readToday() {
    const n = await (await api()).dayNote(today()).catch(() => null);
    const lines = (n?.body ?? "").split("\n").map((l) => l.trim()).filter((l) => /[\p{L}\p{N}]/u.test(l) && l !== "_from capture_" && !l.startsWith("#"));
    setTodayLast(lines.length ? lines[lines.length - 1] : "");
  }

  // `@today` typed does the same as Ctrl D: the top line shows where on the page it lands.
  createEffect(() => {
    if (goesToday()) void readToday();
  });

  function showEarlier(on: boolean) {
    setEarlierShown(on);
    editor?.view.dispatch({ effects: setFoldEffect.of(!on) });
    editor?.view.focus();
  }

  /** The last capture, if it was left in the inbox less than two minutes ago. */
  async function lastCapture(settings: Record<string, string>): Promise<Note | null> {
    const [id, at] = (settings[LAST] ?? "").split(":").map(Number);
    if (!id || !(Date.now() - at < KEEP_GOING_MS)) return null;
    const n = await (await api()).peekNote(id).catch(() => null);
    return n && n.folder === "inbox" && n.body.trim() ? n : null;
  }

  onMount(async () => {
    editor = createEditor(host, () => (saver.changed(), readImplied()), { placeholder: "Write it down. @topic, @today or @fri files it." });
    const extra: Extension = [
      earlierEnd,
      earlierDeco,
      earlierFold,
      quoteCard,
      pictureExtensions(() => "inbox"),
      cleanPaste(() => say("Pasted as Markdown. Ctrl Z for plain text.")),
      autocompletion({ override: [suggest], activateOnTyping: true, icons: false, closeOnBlur: true }),
      completionTheme,
    ];
    editor.setExtra(extra);
    void loadFaces();
    await whenOpened(start);
  });

  /** The window was asked for: read what was selected and the last capture, then show. */
  async function start() {
    if (!editor) return;
    editor.view.focus();
    const s = await api();
    const ctx = s.captureContext().catch(() => null);
    const settings = await s.uiSettings().catch(() => ({}) as Record<string, string>);
    applyPrefs(parsePrefs(settings));
    const last = await lastCapture(settings);
    if (last && editor && !editor.text()) {
      const old = last.body.replace(/\s+$/, "");
      // The editor shows the old text and a blank line; the file is only written when something new is typed.
      saver.load({ ...last, body: `${old}\n\n` });
      editor.view.dispatch({ effects: setEndEffect.of(old.length), selection: { anchor: old.length + 2 }, scrollIntoView: true });
      setEarlier(last.body);
    }
    await s.showWindow();
    editor.view.focus();
    places().then((f) => (folders = f), () => {});
    window.addEventListener("keydown", onKey, true);
    const c = await ctx;
    const quote = c ? quoteBlock(c) : "";
    if (quote && editor && (earlier() !== null || !editor.text())) {
      if (earlier() !== null) {
        editor.insert(quote, false);
      } else {
        editor.insert(quote, true);
        editor.select(quote.length, quote.length);
      }
      if (earlier() === null) quoteText = quote;
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
  }
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    editor?.destroy();
  });


  const saveLabel = () => (note() || save() !== "saved" ? { saved: "Saved", dirty: "Editing", saving: "Saving…", error: "Not saved, retrying" }[save()] : "");

  return (
    // No window frame: the empty parts of the panel drag the window (Tauri reads data-tauri-drag-region).
    <div class="capture" classList={{ leaving: leaving() }} data-tauri-drag-region>
      <Show
        when={earlier() !== null}
        fallback={
          <Show when={goesToday() && todayLast() !== null}>
            <div class="cap-top" data-tauri-drag-region>
              <Mark folder="journal" size={12} />
              <span data-tauri-drag-region>{todayLast() ? "Today, after" : "Today's page, the first entry"}</span>
              <Show when={todayLast()}>
                <span class="cap-top-text" data-tauri-drag-region>
                  {todayLast()}
                </span>
              </Show>
              <span class="grow" data-tauri-drag-region />
              <Kbd keys={keyLabel("capToday")} />
              <span data-tauri-drag-region>inbox</span>
            </div>
          </Show>
        }
      >
        <div class="cap-top" data-tauri-drag-region>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 4v7a4 4 0 0 0 4 4h12" />
            <path d="m15 10 5 5-5 5" />
          </svg>
          <span data-tauri-drag-region>Adding after</span>
          <button class="cap-top-text" title={earlierShown() ? "Fold it away" : "Show it"} aria-expanded={earlierShown()} onClick={() => showEarlier(!earlierShown())}>
            {lastLine(earlier() ?? "")}
          </button>
          <span class="grow" data-tauri-drag-region />
          <Kbd keys={keyLabel("capNew")} />
          <span data-tauri-drag-region>start fresh</span>
        </div>
      </Show>
      <div class="capture-text-host" ref={host} />
      <footer class="capture-foot" data-tauri-drag-region>
        <span class="cap-place" classList={{ on: !!(target() ?? implied()), implied: !target() && !!implied() }}>
          <button class="chip" classList={{ on: !!(target() ?? implied()) }} onClick={() => setChoosing(true)} title={`Choose a place (${keyLabel("capChoose")})`}>
            <Mark folder={targetFolder(target() ?? implied(), targetHome())} size={12} />
            {target()?.kind === "note" ? "Add to " : ""}
            {targetLabel(target() ?? implied())}
          </button>
          <Show when={target()}>
            <button
              class="chip-x"
              aria-label="Leave it in the inbox"
              title="Leave it in the inbox"
              onClick={() => {
                setTarget(null);
                setTargetHome("");
                editor?.view.focus();
              }}
            >
              ×
            </button>
          </Show>
        </span>
        <Show when={quoted()}>
          <span class="cap-quote-chip">
            with the quote
            <Show when={quoteText}>
              <button class="chip-x" aria-label="Drop the quote" title="Drop the quote" onClick={dropQuote}>
                ×
              </button>
            </Show>
          </span>
        </Show>
        <span class="grow" data-tauri-drag-region />
        <Show when={msg()} fallback={<Show when={saveLabel()}><span class={`save-dot ${save()}`} role="status" aria-label={saveLabel()} title={saveLabel()} /></Show>}>
          <span class="bad">{msg()}</span>
        </Show>
        <button class="cap-esc" aria-label="Done" title="Done: save and close" onClick={() => void done()}>
          <kbd>{keyLabel("capDone")}</kbd>
        </button>
        <button class="cap-help" aria-label="Keys" title="Keys" aria-expanded={help()} onClick={() => setHelp(!help())}>
          ?
        </button>
      </footer>
      <Show when={help()}>
        <div class="cap-help-pop" role="dialog" aria-label="Keys in this window">
          <For each={SHORTCUTS.filter((k) => k.group === "Capture window")}>
            {(k) => (
              <div class="cap-help-row">
                <Kbd keys={keyLabel(k.id)} />
                <span>{k.label}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
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
      <ToastView />
    </div>
  );
}
