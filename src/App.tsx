// The main window is the page you write on. It opens on an empty page (or the note you left less than ten minutes
// ago); Ctrl L swaps the page for the library of cards and Esc brings it back. Ctrl K finds, runs or asks, Ctrl N
// is a new page, Ctrl H history, Ctrl , settings. The title bar is Petrel's own (TitleBar.tsx).

import { createResource, createSignal, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import { api, errText, inTauri, type AiStatus } from "./api";
import { plainText } from "./copy";
import TitleBar from "./TitleBar";
import { libraryTabs, loadLibrary } from "./library/Library";
import NotePage, { type NotePageHandle } from "./note/NotePage";
import CommandBar, { type Command } from "./palette/CommandBar";
import { applyPrefs, parsePrefs, prefs, setPrefs } from "./settings/prefs";
import { folderName, say, ToastView, typing, undoLast } from "./ui";
import Destination, { type Target } from "./inbox/Destination";

const Library = lazy(() => import("./library/Library"));
const Settings = lazy(() => import("./settings/Settings"));
const Versions = lazy(() => import("./versions/Versions"));

type View = { kind: "library"; tab: string } | { kind: "note"; id: number | null; folder: string };

/** What the empty page files into: like the capture window, it goes to the inbox until you move it. */
const NEW_FOLDER = "inbox";
/** Coming back within this long opens the note you left instead of an empty page. */
const RESUME_MS = 10 * 60 * 1000;

export default function App() {
  const [view, setView] = createSignal<View>({ kind: "note", id: null, folder: NEW_FOLDER });
  const [title, setTitle] = createSignal("");
  const [tab, setTab] = createSignal("all");
  const [bar, setBar] = createSignal<"all" | "notes" | null>(null);
  const [settings, setSettings] = createSignal<false | "all" | "ai">(false);
  const [history, setHistory] = createSignal(false);
  const [moving, setMoving] = createSignal(false);
  const [ai, setAi] = createSignal<AiStatus>({ ready: false, model: "", error: null });
  const [root, setRoot] = createSignal("");
  const [rev, setRev] = createSignal(0);
  const [lib] = createResource(rev, loadLibrary);
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
  const openNote = (id: number) => go({ kind: "note", id, folder: "" });
  const newNote = (folder?: string) => go({ kind: "note", id: null, folder: folder ?? NEW_FOLDER });
  const library = (t = tab()) => (setTab(t), go({ kind: "library", tab: t }));
  /** Back to the page you were writing on, or an empty one. */
  const writing = () => {
    for (let i = back.length - 1; i >= 0; i--) if (back[i].kind === "note") return go(back.splice(i)[0], false);
    return newNote();
  };
  const remember = async () => {
    const n = current();
    await (await api()).setUiSetting("last.note", n ? `${n.id}:${Date.now()}` : "").catch(() => {});
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
      void newNote();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function pin() {
    const n = current();
    if (!n) return;
    await (await api()).pinNote(n.id, !n.pinned);
    await page?.reload();
    say(n.pinned ? "Unpinned" : "Pinned to the front of its collection");
  }

  const commands: Command[] = [
    { id: "new", label: "New note", keys: "Ctrl N", run: () => void newNote() },
    { id: "capture", label: "Quick capture window", keys: "Ctrl Alt Space", run: () => void api().then((s) => s.openCapture()) },
    { id: "picker", label: "Quick picker: copy a prompt or snippet", keys: "Ctrl Alt V", run: () => void api().then((s) => s.openPicker()) },
    { id: "library", label: "Library", keys: "Ctrl L", run: () => void library("all") },
    { id: "inbox", label: "Inbox", run: () => void library("inbox") },
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

  const overlay = () => !!(bar() || settings() || history() || moving());

  const key = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "k") setBar(bar() ? null : "all");
    else if (mod && k === "p") setBar(bar() ? null : "notes");
    else if (overlay()) return;
    else if (mod && k === "n") void newNote();
    else if (mod && k === "l") void (view().kind === "library" ? writing() : library());
    else if (mod && e.key === ",") setSettings("all");
    else if (mod && k === "h" && onNote()) setHistory(true);
    else if (mod && e.shiftKey && k === "c" && onNote()) void copy("markdown");
    else if (e.key === "Escape" && view().kind === "library") {
      if (document.querySelector(".scrim")) return;
      void writing();
    } else if (!mod && !typing(e) && e.key === "z" && view().kind === "note") {
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
    const [lastId, at] = (((await s.uiSettings().catch(() => ({}) as Record<string, string>))["last.note"] ?? "") as string).split(":").map(Number);
    if (lastId && Date.now() - at < RESUME_MS) void go({ kind: "note", id: lastId, folder: "" }, false);
    setAi(await s.aiStatus().catch(() => ({ ready: false, model: "", error: null })));
    await s.scanNotes().catch((e) => say(`The Petrel folder cannot be read: ${errText(e)}`, { error: true }));
    setRev(rev() + 1);
    await s.showWindow();
    await s.listen({
      quit: async () => {
        await page?.flush();
        await remember();
        await s.closeWindow();
      },
      openNote: (id) => void openNote(id),
      focus: () => void rescan(),
      // Hidden to the tray counts as leaving: coming back soon opens the same note.
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
        await remember();
        await s.closeWindow();
      });
    }
  });
  onCleanup(() => document.removeEventListener("keydown", key));

  const noteView = () => {
    const v = view();
    return v.kind === "note" ? v : null;
  };

  return (
    <div class="app" classList={{ "in-library": view().kind === "library" }}>
      <TitleBar
        library={view().kind === "library"}
        title={title() || (noteView()?.id === null ? "New note" : "")}
        tabs={libraryTabs(lib())}
        tab={tab()}
        onTab={(t) => void library(t)}
        onLibrary={() => void (view().kind === "library" ? writing() : library())}
        onNew={() => void newNote()}
        onSearch={() => setBar("all")}
      />

      <main class="view">
        <Suspense>
          <Show when={view().kind === "library"}>
            <Library
              tab={tab()}
              data={lib()}
              aiReady={ai().ready}
              onTab={(t) => void library(t)}
              onEdit={(id) => void openNote(id)}
              onNew={(folder) => void newNote(folder)}
              onChanged={() => setRev(rev() + 1)}
              onAiSetup={() => setSettings("ai")}
            />
          </Show>
          <Show when={noteView()}>
            {(v) => (
              <NotePage
                id={v().id}
                folder={v().folder}
                root={root()}
                aiReady={ai().ready}
                onOpen={openNote}
                onFolder={(folder) => void library(folder === "inbox" ? "inbox" : `c:${folder.split("/")[0]}`)}
                onHome={() => void newNote()}
                onHistory={() => setHistory(true)}
                onAiSetup={() => setSettings("ai")}
                onTitle={setTitle}
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
