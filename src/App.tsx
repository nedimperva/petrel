// The main window: Home, the Inbox, a collection, or a note. One top bar, one command bar (Ctrl K), and keys:
// Ctrl N new note, Ctrl 1 home, Ctrl 2 inbox, Ctrl P find a note, Ctrl H history, Ctrl , settings.

import { createEffect, createSignal, lazy, on, onCleanup, onMount, Show, Suspense } from "solid-js";
import { api, errText, inTauri, type AiStatus } from "./api";
import Home from "./home/Home";
import { plainText } from "./copy";
import NotePage, { type NotePageHandle } from "./note/NotePage";
import CommandBar, { type Command } from "./palette/CommandBar";
import { applyPrefs, parsePrefs, prefs, setPrefs } from "./settings/prefs";
import { folderName, Kbd, say, ToastView, typing, undoLast } from "./ui";
import Destination, { type Target } from "./inbox/Destination";

const Inbox = lazy(() => import("./inbox/Inbox"));
const Collection = lazy(() => import("./collection/Collection"));
const Settings = lazy(() => import("./settings/Settings"));
const Versions = lazy(() => import("./versions/Versions"));

type View =
  | { kind: "home" }
  | { kind: "inbox" }
  | { kind: "collection"; folder: string }
  | { kind: "note"; id: number | null; folder: string };

export default function App() {
  const [view, setView] = createSignal<View>({ kind: "home" });
  const [bar, setBar] = createSignal<"all" | "notes" | null>(null);
  const [settings, setSettings] = createSignal<false | "all" | "ai">(false);
  const [history, setHistory] = createSignal(false);
  const [moving, setMoving] = createSignal(false);
  const [ai, setAi] = createSignal<AiStatus>({ ready: false, model: "", error: null });
  const [root, setRoot] = createSignal("");
  const [rev, setRev] = createSignal(0);
  const [inboxCount, setInboxCount] = createSignal(0);
  let page: NotePageHandle | undefined;
  const back: View[] = [];

  const go = async (v: View, remember = true) => {
    if (view().kind === "note") await page?.flush();
    if (remember) {
      back.push(view());
      if (back.length > 30) back.shift();
    }
    setView(v);
    if (v.kind !== "note") page = undefined;
    setRev(rev() + 1);
  };
  const goBack = () => void go(back.pop() ?? { kind: "home" }, false);
  const openNote = (id: number) => go({ kind: "note", id, folder: "" });
  const newNote = (folder?: string) => {
    const v = view();
    return go({ kind: "note", id: null, folder: folder ?? (v.kind === "collection" ? v.folder : "") });
  };
  const current = () => (view().kind === "note" ? (page?.note() ?? null) : null);
  const onNote = () => view().kind === "note" && !!current();

  async function copy(how: "plain" | "markdown" | "html") {
    const n = current();
    if (!n || !page) return;
    const text = page.selectedText();
    const whole = text === page.text();
    const md = how !== "plain" && whole ? `# ${n.title}\n\n${text}` : text;
    try {
      await (await api()).copyText(how === "plain" ? plainText(text) : md, how === "html");
      say(how === "plain" ? "Copied as text" : how === "markdown" ? "Copied as Markdown" : "Copied with formatting");
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function moveTo(t: Target) {
    setMoving(false);
    const n = current();
    if (!n) return;
    await page?.flush();
    const s = await api();
    try {
      if (t.kind === "note") {
        const ch = await s.mergeNote(n.id, t.id);
        say(`Added to ${t.title}`, { undo: () => s.undo(ch.token.token).then(() => openNote(n.id)) });
        void openNote(ch.note.id);
      } else {
        const ch = await s.moveNote(n.id, t.folder, n.title);
        say(`Moved to ${folderName(t.folder)}`, { undo: () => s.undo(ch.token.token).then(() => page?.reload()) });
        await page?.reload();
      }
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function trash() {
    const n = current();
    if (!n) return;
    await page?.flush();
    const s = await api();
    try {
      const t = await s.trashNote(n.id);
      say(`Deleted “${n.title}”`, { undo: () => s.undo(t.token).then(() => openNote(n.id)) });
      void go({ kind: "home" });
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function pin() {
    const n = current();
    if (!n) return;
    await (await api()).pinNote(n.id, !n.pinned);
    await page?.reload();
    say(n.pinned ? "Unpinned" : "Pinned to Home");
  }

  const commands: Command[] = [
    { id: "new", label: "New note", keys: "Ctrl N", run: () => void newNote() },
    { id: "capture", label: "Quick capture window", keys: "Ctrl Alt Space", run: () => void api().then((s) => s.openCapture()) },
    { id: "picker", label: "Quick picker: copy a prompt or snippet", keys: "Ctrl Alt V", run: () => void api().then((s) => s.openPicker()) },
    { id: "home", label: "Home", keys: "Ctrl 1", run: () => void go({ kind: "home" }) },
    { id: "inbox", label: "Inbox", keys: "Ctrl 2", run: () => void go({ kind: "inbox" }) },
    { id: "copy", label: "Copy", when: onNote, run: () => void copy("plain") },
    { id: "copy-md", label: "Copy as Markdown", keys: "Ctrl Shift C", when: onNote, run: () => void copy("markdown") },
    { id: "copy-html", label: "Copy formatted (for mail and docs)", when: onNote, run: () => void copy("html") },
    { id: "tidy", label: "AI: Tidy this note", when: onNote, run: () => page?.ai("tidy") },
    { id: "continue", label: "AI: Continue writing", when: onNote, run: () => page?.ai("continue") },
    { id: "summarize", label: "AI: Summarize this note", when: onNote, run: () => page?.ai("summarize") },
    { id: "title", label: "AI: Suggest a title", when: onNote, run: () => page?.ai("title") },
    { id: "related", label: "AI: Find related notes", when: onNote, run: () => page?.findRelated() },
    { id: "move", label: "Move to a note or collection…", when: onNote, run: () => setMoving(true) },
    { id: "pin", label: "Pin or unpin this note", when: onNote, run: () => void pin() },
    { id: "history", label: "History", keys: "Ctrl H", when: onNote, run: () => setHistory(true) },
    { id: "delete", label: "Delete this note", when: onNote, run: () => void trash() },
    { id: "rescan", label: "Look for changes in the folder", run: () => void rescan(true) },
    { id: "settings", label: "Settings", keys: "Ctrl ,", run: () => setSettings("all") },
  ];

  /** Drive (or another app) may have changed the folder while Petrel was in the background. */
  let lastScan = 0;
  async function rescan(loud = false) {
    if (!loud && Date.now() - lastScan < 5000) return;
    lastScan = Date.now();
    try {
      await page?.flush();
      const r = await (await api()).scanNotes();
      const n = r.added + r.changed + r.removed;
      // The capture window and the picker write through the same index, so a zero here can still mean new
      // captures: always redraw the lists.
      if (view().kind !== "note") setRev(rev() + 1);
      else if (r.changed) await page?.reload();
      if (loud) say(n ? `${r.added} new, ${r.changed} changed, ${r.removed} gone` : "Up to date");
    } catch (e) {
      if (loud) say(errText(e), { error: true });
    }
  }

  createEffect(on(rev, async () => setInboxCount((await (await api()).listNotes({ folder: "inbox", limit: 999 })).length)));

  const overlay = () => !!(bar() || settings() || history() || moving());

  const key = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "k") setBar(bar() ? null : "all");
    else if (mod && k === "p") setBar(bar() ? null : "notes");
    else if (overlay()) return;
    else if (mod && k === "n") void newNote();
    else if (mod && e.key === "1") void go({ kind: "home" });
    else if (mod && e.key === "2") void go({ kind: "inbox" });
    else if (mod && e.key === ",") setSettings("all");
    else if (mod && k === "h" && onNote()) setHistory(true);
    else if (mod && e.shiftKey && k === "c" && onNote()) void copy("markdown");
    else if (e.key === "Escape" && view().kind !== "home") {
      if (document.querySelector(".ai-bar, .menu.slash, .explain, .ai-suggest, .scrim")) return;
      if (typing(e) && view().kind !== "note") return;
      goBack();
    } else if (!mod && !typing(e) && e.key === "z" && view().kind !== "inbox" && view().kind !== "collection") {
      if (!undoLast()) return;
    } else return;
    e.preventDefault();
  };

  onMount(async () => {
    document.addEventListener("keydown", key);
    const s = await api();
    try {
      const p = parsePrefs(await s.uiSettings());
      setPrefs(p);
      applyPrefs(p);
    } catch {
      applyPrefs(prefs());
    }
    setRoot((await s.notesInfo().catch(() => ({ root: "" }))).root);
    setAi(await s.aiStatus().catch(() => ({ ready: false, model: "", error: null })));
    await s.scanNotes().catch((e) => say(`The Petrel folder cannot be read: ${errText(e)}`, { error: true }));
    setRev(rev() + 1);
    await s.showWindow();
    await s.listen({
      quit: async () => {
        await page?.flush();
        await s.closeWindow();
      },
      openNote: (id) => void openNote(id),
      focus: () => void rescan(),
      changed: () => view().kind !== "note" && setRev(rev() + 1),
    });
    if (inTauri) {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      // The close button waits for the text to be saved; a save that keeps failing goes to a file instead.
      await getCurrentWebviewWindow().onCloseRequested(async (e) => {
        e.preventDefault();
        if (page && !(await page.flush())) {
          const path = await s.rescueText(page.text()).catch(() => null);
          if (path) say(`Saved to ${path}`);
        }
        await s.closeWindow();
      });
    }
  });
  onCleanup(() => document.removeEventListener("keydown", key));

  const title = () => {
    const v = view();
    if (v.kind === "inbox") return "Inbox";
    if (v.kind === "collection") return folderName(v.folder);
    return "";
  };
  const noteView = () => {
    const v = view();
    return v.kind === "note" ? v : null;
  };
  const folderView = () => {
    const v = view();
    return v.kind === "collection" ? v : null;
  };

  return (
    <div class="app">
      <header class="topbar">
        <button class="brand" onClick={() => go({ kind: "home" })} title="Home (Ctrl 1)">
          <span class="mark" aria-hidden="true" />
          Petrel
        </button>
        <Show when={title()}>
          <span class="sep">/</span>
          <span class="here">{title()}</span>
        </Show>
        <span class="grow" />
        <button class="top-link" classList={{ on: view().kind === "inbox" }} onClick={() => go({ kind: "inbox" })}>
          Inbox
          <Show when={inboxCount()}>
            <span class="count">{inboxCount()}</span>
          </Show>
        </button>
        <button class="top-search" onClick={() => setBar("all")}>
          <span class="spark">✦</span> Search or ask <Kbd keys="Ctrl K" />
        </button>
        <button class="icon-btn" title="Settings (Ctrl ,)" aria-label="Settings" onClick={() => setSettings("all")}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </header>

      <main class="view">
        <Suspense>
          <Show when={view().kind === "home"}>
            <Home
              rev={rev()}
              onSearch={() => setBar("all")}
              onNew={() => newNote("")}
              onCapture={() => void api().then((s) => s.openCapture())}
              onOpen={openNote}
              onInbox={() => go({ kind: "inbox" })}
              onFolder={(folder) => go({ kind: "collection", folder })}
            />
          </Show>
          <Show when={view().kind === "inbox"}>
            <Inbox aiReady={ai().ready} onOpen={openNote} onAiSetup={() => setSettings("ai")} onCount={setInboxCount} />
          </Show>
          <Show when={folderView()} keyed>
            {(v) => <Collection folder={v.folder} onOpen={openNote} onNew={() => newNote(v.folder)} />}
          </Show>
          <Show when={noteView()}>
            {(v) => (
              <NotePage
                id={v().id}
                folder={v().folder}
                root={root()}
                aiReady={ai().ready}
                onOpen={openNote}
                onFolder={(folder) => go(folder === "inbox" ? { kind: "inbox" } : { kind: "collection", folder })}
                onHome={() => go({ kind: "home" })}
                onHistory={() => setHistory(true)}
                onAiSetup={() => setSettings("ai")}
                ref={(h) => (page = h)}
              />
            )}
          </Show>
        </Suspense>
      </main>

      <Show when={bar()}>
        <CommandBar
          commands={commands}
          notesOnly={bar() === "notes"}
          aiReady={ai().ready}
          onOpen={openNote}
          onAiSetup={() => setSettings("ai")}
          onClose={() => {
            setBar(null);
            page?.focus();
          }}
        />
      </Show>
      <Show when={moving()}>
        <Destination exclude={current()?.id} onPick={moveTo} onClose={() => setMoving(false)} />
      </Show>
      <Suspense>
        <Show when={settings()}>
          <Settings
            section={settings() === "ai" ? "ai" : undefined}
            onClose={() => setSettings(false)}
            onRoot={(r) => (setRoot(r), setRev(rev() + 1))}
            onAi={setAi}
          />
        </Show>
        <Show when={history() && current()}>
          {(n) => (
            <Versions
              noteId={n().id}
              title={n().title}
              current={page?.text() ?? ""}
              onClose={() => (setHistory(false), page?.focus())}
              onRestored={() => {
                setHistory(false);
                void page?.reload();
              }}
            />
          )}
        </Show>
      </Suspense>
      <ToastView />
    </div>
  );
}
