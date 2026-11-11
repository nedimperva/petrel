// The main window is the page you write on. It opens on an empty page (or the note you left less than ten minutes
// ago); Ctrl L swaps the page for the library of cards and Esc brings it back. Ctrl K finds, runs or asks, Ctrl N
// is a new page, Ctrl D today's page (Alt ← and Alt → the days around it), Ctrl H history, Ctrl , settings. The
// inbox review is a mode of the inbox's cards in the library. Panels opened from Ctrl K (tasks, the week, history)
// go back to Ctrl K on Esc. The title bar is Petrel's own (TitleBar.tsx).
// Ctrl Tab goes back to the note before (held, it lists the last few); Ctrl \ opens a second note beside.

import { createResource, createSignal, For, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import { api, errText, inTauri, type AiStatus, type Note, type NoteSummary, type ScanReport } from "./api";
import { plainText } from "./copy";
import TitleBar from "./TitleBar";
import Sidebar, { type Place } from "./Sidebar";
import { loadLibrary } from "./library/Library";
import NotePage, { type NotePageHandle } from "./note/NotePage";
import CommandBar, { type Command } from "./palette/CommandBar";
import { applyPrefs, changePref, parsePrefs, prefs, setPrefs } from "./settings/prefs";
import { folderName, say, ToastView, typing, undoLast } from "./ui";
import { pushRecent } from "./palette/match";
import Beside, { type BesideHandle } from "./note/Beside";
import Destination, { type Target } from "./inbox/Destination";
import { addDays, JOURNAL, today } from "./journal/days";
import { typingSound } from "./joy/sound";
import { loadFaces } from "./library/Mark";

const Library = lazy(() => import("./library/Library"));
const Settings = lazy(() => import("./settings/Settings"));
const Versions = lazy(() => import("./versions/Versions"));

const Week = lazy(() => import("./journal/Week"));
const Tasks = lazy(() => import("./palette/Tasks"));

type View =
  | { kind: "library"; tab: string; review?: boolean }
  | { kind: "note"; id: number | null; folder: string; day?: string };

/** What the empty page files into: like the capture window, it goes to the inbox until you move it. */
const NEW_FOLDER = "inbox";
/** Coming back within this long opens the note you left instead of an empty page. */
const RESUME_MS = 10 * 60 * 1000;
/** From this width the sidebar sits beside the page; below it, it slides over and closes after a pick. */
const SIDEBAR_DOCK_PX = 1000;
/** Notes remembered for Back and for Ctrl K's empty list. */
const RECENT_MAX = 12;
/** Ctrl held this long on Ctrl Tab shows the list; a quick press just swaps. */
const SWITCH_SHOW_MS = 280;

const summaryOf = (n: Note): NoteSummary => ({
  id: n.id,
  path: n.path,
  folder: n.folder,
  title: n.title,
  preview: n.body.slice(0, 200),
  tags: n.tags,
  pinned: n.pinned,
  modifiedAt: n.modifiedAt,
});

/** The notes for these ids that still exist, in order. */
async function summaries(ids: number[]): Promise<NoteSummary[]> {
  const s = await api();
  const ns = await Promise.all(ids.map((id) => s.peekNote(id).then(summaryOf, () => null)));
  return ns.filter((n): n is NoteSummary => !!n);
}

export default function App() {
  const [view, setView] = createSignal<View>({ kind: "note", id: null, folder: NEW_FOLDER });
  const [title, setTitle] = createSignal("");
  const [tab, setTab] = createSignal("all");
  const [bar, setBar] = createSignal<"all" | "notes" | "beside" | null>(null);
  const [beside, setBeside] = createSignal<number | null>(null);
  // The sidebar: shown unless hidden with Ctrl 0 (ui.sidebar); docked on a wide window, over the page on a narrow one.
  const [sideOn, setSideOn] = createSignal(true);
  const [wide, setWide] = createSignal(innerWidth >= SIDEBAR_DOCK_PX);
  const docked = () => sideOn() && wide();
  const toggleSide = () => {
    const on = !sideOn();
    setSideOn(on);
    void api().then((s) => s.setUiSetting("ui.sidebar", on ? "1" : "0")).catch(() => {});
  };
  let besideH: BesideHandle | undefined;
  const [recent, setRecent] = createSignal<number[]>([]);
  // The open note's folder, as a signal for the sidebar (the page handle is not reactive).
  const [noteFolder, setNoteFolder] = createSignal<string | null>(null);
  const [switcher, setSwitcher] = createSignal<{ ids: number[]; i: number; shown: boolean; notes: NoteSummary[] } | null>(null);
  const [settings, setSettings] = createSignal<false | "all" | "ai">(false);
  const [history, setHistory] = createSignal(false);
  const [moving, setMoving] = createSignal(false);
  const [week, setWeek] = createSignal(false);
  const [tasks, setTasks] = createSignal(false);
  // A line in the page's footer for a moment ("Updated from Drive").
  const [notice, setNotice] = createSignal<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const tell = (text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setNotice(null), 5000);
  };
  const [ai, setAi] = createSignal<AiStatus>({ ready: false, model: "", error: null });
  const [root, setRoot] = createSignal("");
  const [rev, setRev] = createSignal(0);
  const [lib] = createResource(rev, loadLibrary);
  let page: NotePageHandle | undefined;
  const back: View[] = [];

  const go = async (v: View, remember = true) => {
    lastGo = Date.now();
    if (view().kind === "note") await page?.flush();
    // The note beside is never also the main one.
    if (v.kind === "note" && v.id !== null && v.id === beside()) await closeBeside(false);
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
  /** A day's page: its file if it has one, else an empty page that becomes the file when written on. */
  const openDay = async (day: string) => {
    const n = await (await api()).dayNote(day).catch(() => null);
    return go({ kind: "note", id: n?.id ?? null, folder: JOURNAL, day });
  };
  const review = () => (setTab("inbox"), go({ kind: "library", tab: "inbox", review: true }));
  const reviewing = () => {
    const v = view();
    return v.kind === "library" && !!v.review;
  };

  // A panel opened from Ctrl K goes back to it on Esc; one closed because a note was opened from it does not.
  let barClosedAt = 0;
  let lastGo = 0;
  const panels = { tasks: false, week: false, history: false };
  const openPanel = (which: keyof typeof panels, set: (on: boolean) => void) => {
    panels[which] = Date.now() - barClosedAt < 400;
    set(true);
  };
  const closePanel = (which: keyof typeof panels, set: (on: boolean) => void) => {
    set(false);
    const back = panels[which];
    const at = Date.now();
    setTimeout(() => {
      if (back && lastGo < at) setBar("all");
      else page?.focus();
    });
  };
  /** The day of the page being written on, if it is a day's page. */
  const onDay = () => {
    const v = view();
    if (v.kind !== "note") return null;
    if (v.day) return v.day;
    const n = page?.note();
    return n && n.folder === JOURNAL && /^\d{4}-\d{2}-\d{2}$/.test(n.title) ? n.title : null;
  };
  /** Back to the page you were writing on, or an empty one. */
  const writing = () => {
    for (let i = back.length - 1; i >= 0; i--) if (back[i].kind === "note") return go(back.splice(i)[0], false);
    return newNote();
  };
  const remember = async () => {
    const n = current();
    await (await api()).setUiSetting("last.note", n ? `${n.id}:${Date.now()}` : "").catch(() => {});
  };
  /** What the sidebar marks: today, the inbox, open tasks, or the collection you are in. */
  const here = (): Place => {
    const v = view();
    if (tasks()) return "tasks";
    if (v.kind === "library") return v.tab === "inbox" ? "inbox" : v.tab.startsWith("c:") ? (v.tab as Place) : null;
    if (v.day === today() || onDay() === today()) return "today";
    const f = noteFolder();
    if (f === "inbox") return "inbox";
    return f ? `c:${f}` : null;
  };
  const libraryTitle = () => {
    const t = tab();
    return t === "inbox" ? "Inbox" : t.startsWith("c:") ? folderName(t.slice(2)) : "All";
  };
  /** A collection was renamed or trashed in the sidebar: what was open in it follows, or goes back to writing. */
  async function folderMoved(from: string, to: string | null) {
    const v = view();
    const inside = (f: string) => f === from || f.startsWith(`${from}/`);
    if (v.kind === "library" && v.tab.startsWith("c:") && inside(v.tab.slice(2))) {
      await (to ? library(`c:${to}${v.tab.slice(2 + from.length)}`) : library("all"));
    } else if (v.kind === "note" && inside(noteFolder() ?? "")) {
      if (to) await page?.reload();
      else await newNote();
    }
    setRev(rev() + 1);
  }
  const current = () => (view().kind === "note" ? (page?.note() ?? null) : null);
  const onNote = () => view().kind === "note" && !!current();

  // ---- a note beside, and Back -------------------------------------------------------------------------------

  async function openBeside(id: number) {
    if (current()?.id === id) return say("That note is already open here");
    if (view().kind !== "note") await writing();
    await besideH?.flush();
    setBeside(id);
  }
  async function closeBeside(refocus = true) {
    await besideH?.flush();
    besideH = undefined;
    setBeside(null);
    if (refocus) page?.focus();
  }
  /** "Open here": the note beside becomes the main one, and the main one goes beside. */
  async function swapBeside(id: number) {
    const main = current()?.id ?? null;
    await closeBeside(false);
    await openNote(id);
    if (main !== null && main !== id) setBeside(main);
  }

  let recentTimer: ReturnType<typeof setTimeout> | undefined;
  const seen = (id: number | null) => {
    if (id === null) return;
    setRecent(pushRecent(recent().map(String), String(id), RECENT_MAX).map(Number));
    clearTimeout(recentTimer);
    recentTimer = setTimeout(() => void api().then((s) => s.setUiSetting("ui.recent", JSON.stringify(recent()))).catch(() => {}), 1000);
  };
  /** The recent notes without the one being written on: Ctrl K's empty list. */
  const others = () => recent().filter((id) => id !== current()?.id);

  /** Ctrl Tab: the note before this one at once; held, the list of the last few to step through. */
  function switchStep(back: boolean) {
    const s = switcher();
    if (s) return setSwitcher({ ...s, i: (s.i + (back ? s.ids.length - 1 : 1)) % s.ids.length });
    const here = current()?.id;
    const ids = here !== undefined ? [here, ...others()] : others();
    if (ids.length < (here !== undefined ? 2 : 1)) return say("No other note yet");
    const start = here !== undefined ? 1 : 0;
    setSwitcher({ ids, i: back ? ids.length - 1 : start, shown: false, notes: [] });
    void summaries(ids.slice(0, 8)).then((notes) => switcher() && setSwitcher({ ...switcher()!, notes }));
    setTimeout(() => switcher() && setSwitcher({ ...switcher()!, shown: true }), SWITCH_SHOW_MS);
  }
  function switchDone(go = true) {
    const s = switcher();
    setSwitcher(null);
    if (go && s && s.ids[s.i] !== current()?.id) void openNote(s.ids[s.i]);
  }

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
      } else if (t.kind === "day") {
        const ch = await s.fileIntoDay(n.id, t.date ?? today());
        say(t.date && t.date !== today() ? "Added to that day's page" : "Added to today's page", { undo: () => s.undo(ch.token.token).then(() => openNote(n.id)) });
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
    { id: "picker", label: "Quick picker: copy a prompt or snippet", keys: "Ctrl Shift Space", run: () => void api().then((s) => s.openPicker()) },
    { id: "library", label: "Library", keys: "Ctrl L", run: () => void library("all") },
    { id: "today", label: "Today's page", keys: "Ctrl D", run: () => void openDay(today()) },
    { id: "inbox", label: "Inbox", run: () => void library("inbox") },
    { id: "review", label: "Review the Inbox, one card at a time", run: () => void review() },
    { id: "week", label: "The week: what you wrote, what is open, and a few words from Claude", run: () => openPanel("week", setWeek) },
    {
      id: "tasks",
      label: "Open tasks in every note",
      run: () => {
        panels.tasks = true;
        void (page ? page.flush() : Promise.resolve(true)).then(() => setTasks(true));
      },
    },
    { id: "copy", label: "Copy", when: onNote, run: () => void copy("plain") },
    { id: "copy-md", label: "Copy as Markdown", keys: "Ctrl Shift C", when: onNote, run: () => void copy("markdown") },
    { id: "copy-html", label: "Copy formatted (for mail and docs)", when: onNote, run: () => void copy("html") },
    { id: "tidy", label: "AI: Tidy this note", when: onNote, run: () => page?.ai("tidy") },
    { id: "continue", label: "AI: Continue writing", when: onNote, run: () => page?.ai("continue") },
    { id: "summarize", label: "AI: Summarize this note", when: onNote, run: () => page?.ai("summarize") },
    { id: "title", label: "AI: Suggest a title", when: onNote, run: () => page?.ai("title") },
    { id: "related", label: "AI: Find related notes", when: onNote, run: () => page?.findRelated() },
    { id: "move", label: "Move to a note or collection…", when: onNote, run: () => setMoving(true) },
    { id: "task", label: "Add a task, or tick one", keys: "Ctrl Shift X", when: () => view().kind === "note", run: () => page?.task() },
    { id: "beside", label: "Open a note beside this one", keys: "Ctrl \\", run: () => setTimeout(() => setBar("beside")) },
    { id: "beside-close", label: "Close the note beside", when: () => beside() !== null, run: () => void closeBeside() },
    { id: "back", label: "Back to the note before", keys: "Ctrl Tab", when: () => others().length > 0, run: () => void openNote(others()[0]) },
    {
      id: "focus",
      label: "Paragraph focus: fade the other paragraphs (on or off)",
      run: () => {
        const on = !prefs().focus;
        void changePref("focus", on, async (k, v) => (await api()).setUiSetting(k, v));
        say(on ? "Paragraph focus is on" : "Paragraph focus is off");
      },
    },
    { id: "pin", label: "Pin or unpin this note", when: onNote, run: () => void pin() },
    { id: "history", label: "History", keys: "Ctrl H", when: onNote, run: () => openPanel("history", setHistory) },
    { id: "delete", label: "Delete this note", when: onNote, run: () => void trash() },
    { id: "rescan", label: "Look for changes in the folder", run: () => void rescan(true) },
    { id: "settings", label: "Settings", keys: "Ctrl ,", run: () => setSettings("all") },
  ];

  /** Notes changed on disk (the watcher, or a rescan): the lists redraw, and the open note reloads where you
   * were if you have not typed in it since it was saved. If you have, the save keeps the other text as a
   * conflict copy, as always. */
  async function folderChanged(r: ScanReport) {
    if (view().kind !== "note") return setRev(rev() + 1);
    const n = current();
    if (!n || !r.paths.includes(n.path) || page?.dirty()) return;
    if (await page?.refresh()) tell(/google drive|googledrive|my drive/i.test(root()) ? "Updated from Drive" : "Updated from the folder");
  }

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
      else await folderChanged(r);
      if (loud) say(n ? `${r.added} new, ${r.changed} changed, ${r.removed} gone` : "Up to date");
    } catch (e) {
      if (loud) say(errText(e), { error: true });
    }
  }

  const overlay = () => !!(bar() || settings() || history() || moving() || week() || tasks());

  // Ctrl Tab and Ctrl \ come before the editor, which would indent or type them.
  const earlyKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === "Tab" && !overlay()) {
      e.preventDefault();
      e.stopPropagation();
      switchStep(e.shiftKey);
    } else if (switcher() && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      switchDone(false);
    } else if (mod && !e.altKey && (e.key === "\\" || e.code === "Backslash") && !overlay()) {
      e.preventDefault();
      e.stopPropagation();
      if (beside() !== null) void closeBeside();
      else setBar("beside");
    }
  };
  const keyUp = (e: KeyboardEvent) => {
    if (switcher() && (e.key === "Control" || e.key === "Meta")) switchDone();
  };

  const key = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "k") setBar(bar() ? null : "all");
    else if (mod && k === "p") setBar(bar() ? null : "notes");
    else if (overlay()) return;
    else if (mod && e.key === "0") toggleSide();
    else if (mod && k === "n") void newNote();
    else if (mod && k === "l") void (view().kind === "library" ? writing() : library());
    else if (mod && e.key === ",") setSettings("all");
    else if (mod && k === "h" && onNote()) setHistory(true);
    else if (e.altKey && !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight") && onDay()) {
      void openDay(addDays(onDay()!, e.key === "ArrowLeft" ? -1 : 1));
    }
    else if (mod && e.shiftKey && k === "c" && onNote()) void copy("markdown");
    else if (e.key === "Escape" && view().kind === "library" && !reviewing()) {
      if (document.querySelector(".scrim")) return;
      void writing();
    } else if (e.key === "Escape" && beside() !== null && view().kind === "note" && !e.defaultPrevented && !document.querySelector(".scrim, .menu, .explain")) {
      void closeBeside();
    } else if (!mod && !typing(e) && e.key === "z" && view().kind === "note") {
      if (!undoLast()) return;
    } else return;
    e.preventDefault();
  };

  // Ctrl D is the editor's "select next match"; today's page comes first.
  const dayKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "d" && !overlay()) {
      e.preventDefault();
      e.stopPropagation();
      if (onDay() !== today()) void openDay(today());
    }
  };
  const stopSound = typingSound(() => prefs().sound);
  onCleanup(stopSound);

  onMount(async () => {
    document.addEventListener("keydown", key);
    document.addEventListener("keydown", dayKey, true);
    document.addEventListener("keydown", earlyKey, true);
    document.addEventListener("keyup", keyUp, true);
    window.addEventListener("resize", () => setWide(innerWidth >= SIDEBAR_DOCK_PX));
    window.addEventListener("blur", () => switcher() && switchDone(false));
    void loadFaces();
    const s = await api();
    try {
      const p = parsePrefs(await s.uiSettings());
      setPrefs(p);
      applyPrefs(p);
    } catch {
      applyPrefs(prefs());
    }
    setRoot((await s.notesInfo().catch(() => ({ root: "" }))).root);
    const stored = await s.uiSettings().catch(() => ({}) as Record<string, string>);
    setSideOn(stored["ui.sidebar"] !== "0" && innerWidth >= SIDEBAR_DOCK_PX);
    try {
      const r = JSON.parse(stored["ui.recent"] ?? "[]");
      if (Array.isArray(r)) setRecent(r.filter((x) => typeof x === "number").slice(0, RECENT_MAX));
    } catch {
      // A bad list is no list.
    }
    const [lastId, at] = ((stored["last.note"] ?? "") as string).split(":").map(Number);
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
      folder: (r) => void folderChanged(r),
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
  onCleanup(() => {
    document.removeEventListener("keydown", key);
    document.removeEventListener("keydown", dayKey, true);
    document.removeEventListener("keydown", earlyKey, true);
    document.removeEventListener("keyup", keyUp, true);
  });

  const noteView = () => {
    const v = view();
    return v.kind === "note" ? v : null;
  };

  return (
    <div class="app" classList={{ "in-library": view().kind === "library" }}>
      <TitleBar
        title={view().kind === "library" ? `Library · ${libraryTitle()}` : title() || (noteView()?.id === null ? "New note" : "")}
        sidebar={sideOn()}
        onSidebar={toggleSide}
        onNew={() => void newNote()}
        onSearch={() => setBar("all")}
      />

      <div class="app-body">
      <Show when={sideOn()}>
        <Show when={!docked()}>
          <div class="side-scrim" onMouseDown={() => setSideOn(false)} />
        </Show>
        <Sidebar
          rev={rev()}
          here={here()}
          docked={docked()}
          root={root()}
          onNew={() => void newNote()}
          onToday={() => void openDay(today())}
          onInbox={() => void library("inbox")}
          onTasks={() => void (page ? page.flush() : Promise.resolve(true)).then(() => ((panels.tasks = false), setTasks(true)))}
          onCollection={(f) => void library(`c:${f}`)}
          onFolderChanged={(from, to) => void folderMoved(from, to)}
          onSettings={() => setSettings("all")}
          onClose={() => setSideOn(false)}
        />
      </Show>
      <main class="view" classList={{ split: beside() !== null && view().kind === "note" }}>
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
              onReview={() => void review()}
              reviewing={reviewing()}
              onReviewDone={() => void library("inbox")}
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
                day={v().day ?? null}
                onDay={(d) => void openDay(d)}
                onNoteId={(id) => (seen(id), setNoteFolder(page?.note()?.folder ?? null))}
                onBeside={(id) => void openBeside(id)}
                besideOpen={beside() !== null}
                notice={notice()}
                ref={(h) => (page = h)}
              />
            )}
          </Show>
          <Show when={view().kind === "note" && beside()}>
            {(id) => (
              <Beside
                id={id()}
                onClose={() => void closeBeside()}
                onSwap={(i) => void swapBeside(i)}
                onFollow={(i) => (i === current()?.id ? say("That note is already open here") : setBeside(i))}
                ref={(h) => (besideH = h)}
              />
            )}
          </Show>
        </Suspense>
      </main>
      </div>
      <Show when={switcher()?.shown && switcher()}>
        {(s) => (
          <div class="switcher" role="listbox" aria-label="Recent notes">
            <For each={s().ids.slice(0, 8)}>
              {(id, k) => {
                const n = () => s().notes.find((x) => x.id === id);
                return (
                  <div class="switcher-row" role="option" aria-selected={k() === s().i} classList={{ on: k() === s().i }} onMouseDown={(e) => (e.preventDefault(), setSwitcher({ ...s(), i: k() }), switchDone())}>
                    <span class="row-label">{n() ? (n()!.folder === "inbox" ? n()!.preview.split("\n")[0] : n()!.title) : "…"}</span>
                    <span class="row-sub">{n() ? folderName(n()!.folder) : ""}</span>
                  </div>
                );
              }}
            </For>
            <p class="muted small">Tab next · Shift Tab back · let go of Ctrl to open</p>
          </div>
        )}
      </Show>

      <Show when={bar()}>
        <CommandBar
          commands={commands}
          notesOnly={bar() === "notes" || bar() === "beside"}
          placeholder={bar() === "beside" ? "Open a note beside this one…" : undefined}
          recent={others()}
          aiReady={ai().ready}
          onOpen={bar() === "beside" ? (id) => void openBeside(id) : openNote}
          onAiSetup={() => setSettings("ai")}
          onClose={() => {
            barClosedAt = Date.now();
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
        <Show when={tasks()}>
          <Tasks
            onClose={() => closePanel("tasks", setTasks)}
            onOpen={(id) => void openNote(id)}
            onTicked={(id) => {
              if (current()?.id === id) void page?.refresh();
            }}
          />
        </Show>
        <Show when={week()}>
          <Week
            aiReady={ai().ready}
            onClose={() => closePanel("week", setWeek)}
            onOpen={openNote}
            onAiSetup={() => (setWeek(false), setSettings("ai"))}
            onReview={() => void review()}
          />
        </Show>
        <Show when={history() && current()}>
          {(n) => (
            <Versions
              noteId={n().id}
              title={n().title}
              current={page?.text() ?? ""}
              onClose={() => closePanel("history", setHistory)}
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
