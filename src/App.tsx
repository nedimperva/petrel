// The unified Petrel workspace: one calm window with zero stacked modals and zero read-only detours.
// - Click any Pages collection → slim note list beside the LIVE editable NotePage (click straight into text).
// - Click any To-copy collection → slim list beside the inline Copy Card (edit `{{blanks}}` in place, Enter copies).
// - Click Inbox → queue beside the active capture with a 1-Click Filing Bar right underneath (no Review detour, no modal).
// - Click Open tasks → grouped tasks in the list pane beside the task's live editable note (never a modal trap).
// - Ctrl E toggles Read view in place; Ctrl . toggles the unified Inspector (About + History); Ctrl H jumps to History.
// - Ctrl 0 toggles Zen writing focus; Ctrl K finds, runs commands, or asks Claude.

import "./styles/library.css";
import "./styles/day.css";
import "./styles/margin.css";
import "./styles/panels.css";
import "./styles/sidebar.css";
import "./styles/settings.css";

import { createEffect, createResource, createSignal, For, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import { api, errText, inTauri, type AiStatus, type AiSuggestion, type Conflict, type Note, type NoteSummary, type ScanReport } from "./api";
import { copyBody } from "./collection/snippetText";
import { plainText } from "./copy";
import { showSteps, startSteps, stepDone, STEPS_KEY } from "./firstSteps";
import Destination, { type Target } from "./inbox/Destination";
import { fileCapture } from "./inbox/file";
import { keepUntil, laterOf, parseLater } from "./inbox/later";
import { addDays, JOURNAL, listName, today } from "./journal/days";
import Petrel from "./joy/Petrel";
import { typingSound } from "./joy/sound";
import { keyLabel, matches, parseKeyMap, setCustomKeys, setSystemKeys } from "./keys";
import { learnKeys, USED_KEY } from "./learned";
import { loadLibrary } from "./library/data";
import FacePicker from "./library/FacePicker";
import { toCopy } from "./library/faces";
import { faces, loadFaces } from "./library/Mark";
import Sheet from "./library/Sheet";
import WorkspaceList from "./library/WorkspaceList";
import Beside, { type BesideHandle } from "./note/Beside";
import NotePage, { type NotePageHandle } from "./note/NotePage";
import { watchQuiet } from "./note/quiet";
import CommandBar, { type Command } from "./palette/CommandBar";
import { pushRecent } from "./palette/match";
import Tasks from "./palette/Tasks";
import { applyPrefs, changePref, parsePrefs, prefs, setPrefs, stepSize } from "./settings/prefs";
import type { Section } from "./settings/Settings";
import Shortcuts from "./Shortcuts";
import Sidebar, { type Place } from "./Sidebar";
import { syncStatus, watchSync } from "./sync";
import TitleBar from "./TitleBar";
import { folderName, say, ToastView, typing, undoLast } from "./ui";
import UpdateNotice from "./UpdateNotice";
import { setBeforeInstall, watchUpdates } from "./updates";

const Settings = lazy(() => import("./settings/Settings"));
const Week = lazy(() => import("./journal/Week"));
const Trash = lazy(() => import("./palette/Trash"));
const Settle = lazy(() => import("./library/Settle"));

type Pane = null | { kind: "tasks" } | { kind: "list"; place: string };
type Stage =
  | { kind: "note"; id: number | null; folder: string; day?: string; focus?: boolean }
  | { kind: "copy"; id: number; folder: string }
  | { kind: "inbox-clear" };

const NEW_FOLDER = "inbox";
const RESUME_MS = 10 * 60 * 1000;
const SIDEBAR_DOCK_PX = 1000;
const RECENT_MAX = 12;
const SWITCH_SHOW_MS = 280;
const LATER_KEY = "ui.review.later";

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

async function summaries(ids: number[]): Promise<NoteSummary[]> {
  const s = await api();
  const ns = await Promise.all(ids.map((id) => s.peekNote(id).then(summaryOf, () => null)));
  return ns.filter((n): n is NoteSummary => !!n);
}

export default function App() {
  const [pane, setPane] = createSignal<Pane>(null);
  const [lastPlace, setLastPlace] = createSignal<string>("inbox");
  const [stage, setStage] = createSignal<Stage>({ kind: "note", id: null, folder: NEW_FOLDER, focus: true });
  const [title, setTitle] = createSignal("");
  const [readMode, setReadMode] = createSignal(false);
  const [inspector, setInspector] = createSignal<"about" | "history" | null>(null);
  const [bar, setBar] = createSignal<"all" | "notes" | "beside" | "about" | null>(null);
  const [asking, setAsking] = createSignal<{ id: number; title: string; ask?: string } | null>(null);
  const [askAll, setAskAll] = createSignal("");
  const [beside, setBeside] = createSignal<number | null>(null);

  const [sideOn, setSideOn] = createSignal(true);
  const [wide, setWide] = createSignal(innerWidth >= SIDEBAR_DOCK_PX);
  const docked = () => sideOn() && wide();
  let sidePref = true;
  const toggleSide = () => {
    const on = !sideOn();
    setSideOn(on);
    if (wide()) {
      sidePref = on;
      void api().then((s) => s.setUiSetting("ui.sidebar", on ? "1" : "0")).catch(() => {});
    }
  };

  let besideH: BesideHandle | undefined;
  let page: NotePageHandle | undefined;
  const [recent, setRecent] = createSignal<number[]>([]);
  const [noteFolder, setNoteFolder] = createSignal<string | null>(null);
  const [switcher, setSwitcher] = createSignal<{ ids: number[]; i: number; shown: boolean; notes: NoteSummary[] } | null>(null);
  const [settings, setSettings] = createSignal<false | Section | "all">(false);
  const [moving, setMoving] = createSignal<{ note: Note; anchor?: { x: number; y: number } } | null>(null);
  const [movingMany, setMovingMany] = createSignal<NoteSummary[] | null>(null);
  const [facing, setFacing] = createSignal<string | null>(null);
  const [week, setWeek] = createSignal(false);
  const [trashOpen, setTrash] = createSignal(false);
  const [keysOpen, setKeysOpen] = createSignal(false);
  const [settling, setSettling] = createSignal<Conflict | null>(null);
  const [laterMap, setLaterMap] = createSignal<Record<string, number>>({});
  const snoozed = () => laterOf(laterMap(), Date.now());

  const [notice, setNotice] = createSignal<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const tell = (text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setNotice(null), 5000);
  };
  const [ai, setAi] = createSignal<AiStatus>({ ready: false, model: "", fastModel: "", error: null });
  const [root, setRoot] = createSignal("");
  const [rev, setRev] = createSignal(0);
  const [pinRev, setPinRev] = createSignal(0);

  // Load collection/inbox data whenever the list pane is open.
  const [lib] = createResource(() => (pane()?.kind === "list" ? rev() + 1 : false), loadLibrary);

  let barClosedAt = 0;
  let lastGo = 0;
  const panels = { week: false, trash: false };
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

  const current = () => (stage().kind === "note" ? (page?.note() ?? null) : null);
  const onNote = () => stage().kind === "note" && !!current();

  const onDay = () => {
    const st = stage();
    if (st.kind !== "note") return null;
    if (st.day) return st.day;
    const n = page?.note();
    return n && n.folder === JOURNAL && /^\d{4}-\d{2}-\d{2}$/.test(n.title) ? n.title : null;
  };

  async function setNoteStage(next: { id: number | null; folder: string; day?: string; focus?: boolean }) {
    lastGo = Date.now();
    if (stage().kind === "note") await page?.flush();
    if (next.id !== null && next.id === beside()) await closeBeside(false);
    setReadMode(false);
    setStage({ kind: "note", ...next });
    setRev((r) => r + 1);
  }

  const openNote = (id: number, keepPane = false) => {
    if (!keepPane) setPane(null);
    return setNoteStage({ id, folder: "", focus: true });
  };

  const newNote = (folder?: string) => {
    if (!folder) setPane(null);
    return setNoteStage({ id: null, folder: folder ?? NEW_FOLDER, focus: true });
  };

  const openDay = async (day: string) => {
    setPane(null);
    const n = await (await api()).dayNote(day).catch(() => null);
    return setNoteStage({ id: n?.id ?? null, folder: JOURNAL, day, focus: true });
  };

  const openPlace = async (place: string) => {
    if (stage().kind === "note") await page?.flush();
    setLastPlace(place);
    setPane({ kind: "list", place });
    setReadMode(false);
    setRev((r) => r + 1);
  };

  const openTasksPane = async () => {
    if (stage().kind === "note") await page?.flush();
    setPane({ kind: "tasks" });
    setReadMode(false);
    setRev((r) => r + 1);
  };

  // Auto-select the first relevant item in a newly opened list (or after filing/deleting the active item).
  createEffect(() => {
    const pn = pane();
    const d = lib();
    if (pn?.kind !== "list" || !d) return;
    const isInbox = pn.place === "inbox";
    const folder = pn.place.startsWith("c:") ? pn.place.slice(2) : "";
    const isCopy = !isInbox && toCopy(folder, faces());
    const sn = snoozed();
    const list = isInbox
      ? d.notes.filter((n) => n.folder === "inbox" && !sn.has(n.path)).sort((a, b) => b.modifiedAt - a.modifiedAt)
      : d.notes
          .filter((n) => (folder === "" ? n.folder === "" : n.folder === folder || n.folder.startsWith(`${folder}/`)))
          .sort((a, b) =>
            isCopy
              ? Number(b.pinned) - Number(a.pinned) || (d.copies[b.path] ?? 0) - (d.copies[a.path] ?? 0) || b.modifiedAt - a.modifiedAt
              : Number(b.pinned) - Number(a.pinned) || b.modifiedAt - a.modifiedAt,
          );

    const st = stage();
    if (isInbox) {
      if (!list.length) {
        if (st.kind !== "inbox-clear") setStage({ kind: "inbox-clear" });
        return;
      }
      if ((st.kind === "copy" || st.kind === "note") && st.id !== null && list.some((n) => n.id === st.id)) return;
      setStage({ kind: "copy", id: list[0].id, folder: "inbox" });
      return;
    }

    if (isCopy) {
      if (!list.length) return;
      if ((st.kind === "copy" || st.kind === "note") && st.id !== null && list.some((n) => n.id === st.id)) return;
      setStage({ kind: "copy", id: list[0].id, folder });
      return;
    }

    // Pages collection: live editable NotePage right beside the list!
    if (st.kind === "note" && (st.id === null || list.some((n) => n.id === st.id))) return;
    if (list.length) setStage({ kind: "note", id: list[0].id, folder, focus: false });
    else setStage({ kind: "note", id: null, folder, focus: false });
  });

  const selectFromList = (n: NoteSummary) => {
    const pn = pane();
    if (pn?.kind !== "list") return void openNote(n.id);
    const isInbox = pn.place === "inbox";
    const isCopy = !isInbox && toCopy(pn.place.slice(2), faces());
    if (isInbox || isCopy) {
      setStage({ kind: "copy", id: n.id, folder: n.folder });
    } else {
      void setNoteStage({ id: n.id, folder: n.folder, focus: false });
    }
  };

  const remember = async () => {
    const n = current();
    await (await api()).setUiSetting("last.note", n ? `${n.id}:${Date.now()}` : "").catch(() => {});
  };

  const here = (): Place => {
    const pn = pane();
    if (pn?.kind === "tasks") return "tasks";
    if (pn?.kind === "list") return pn.place === "inbox" ? "inbox" : (pn.place as Place);
    const st = stage();
    if (st.kind === "note" && (st.day === today() || onDay() === today())) return "today";
    const f = noteFolder();
    if (f === "inbox") return "inbox";
    return f ? `c:${f}` : null;
  };

  async function folderMoved(from: string, to: string | null) {
    const pn = pane();
    const inside = (f: string) => f === from || f.startsWith(`${from}/`);
    if (pn?.kind === "list" && pn.place.startsWith("c:") && inside(pn.place.slice(2))) {
      if (to) await openPlace(`c:${to}${pn.place.slice(2 + from.length)}`);
      else setPane(null);
    } else if (stage().kind === "note" && inside(noteFolder() ?? "")) {
      if (to) await page?.reload();
      else await newNote();
    }
    setRev((r) => r + 1);
  }

  // ---- a note beside, and Back -------------------------------------------------------------------------------

  async function openBeside(id: number) {
    if (current()?.id === id) return say("That note is already open here");
    if (stage().kind !== "note") await setNoteStage({ id: null, folder: NEW_FOLDER, focus: true });
    await besideH?.flush();
    setInspector(null);
    setBeside(id);
  }
  async function closeBeside(refocus = true) {
    await besideH?.flush();
    besideH = undefined;
    setBeside(null);
    if (refocus) page?.focus();
  }
  async function swapBeside(id: number) {
    const main = current()?.id ?? null;
    await closeBeside(false);
    await openNote(id, pane() !== null);
    if (main !== null && main !== id) setBeside(main);
  }

  let recentTimer: ReturnType<typeof setTimeout> | undefined;
  const seen = (id: number | null) => {
    if (id === null) return;
    setRecent(pushRecent(recent().map(String), String(id), RECENT_MAX).map(Number));
    clearTimeout(recentTimer);
    recentTimer = setTimeout(() => void api().then((s) => s.setUiSetting("ui.recent", JSON.stringify(recent()))).catch(() => {}), 1000);
  };
  const others = () => recent().filter((id) => id !== current()?.id);

  function switchStep(back: boolean) {
    const s = switcher();
    if (s) return setSwitcher({ ...s, i: (s.i + (back ? s.ids.length - 1 : 1)) % s.ids.length });
    const h = current()?.id;
    const ids = h !== undefined ? [h, ...others()] : others();
    if (ids.length < (h !== undefined ? 2 : 1)) return say("No other note yet");
    const start = h !== undefined ? 1 : 0;
    setSwitcher({ ids, i: back ? ids.length - 1 : start, shown: false, notes: [] });
    void summaries(ids.slice(0, 8)).then((notes) => switcher() && setSwitcher({ ...switcher()!, notes }));
    setTimeout(() => switcher() && setSwitcher({ ...switcher()!, shown: true }), SWITCH_SHOW_MS);
  }
  function switchDone(go = true) {
    const s = switcher();
    setSwitcher(null);
    if (go && s && s.ids[s.i] !== current()?.id) void openNote(s.ids[s.i]);
  }

  // ---- note & list actions -----------------------------------------------------------------------------------

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

  async function fileOne(n: Note, t: Target) {
    setMoving(null);
    if (current()?.id === n.id) await page?.flush();
    try {
      const { change, text } = await fileCapture(n, t);
      const s = await api();
      say(text, {
        undo: () =>
          s.undo(change.token.token).then(() => {
            setRev((r) => r + 1);
            if (stage().kind === "note") void openNote(n.id, pane() !== null);
          }),
      });
      if (stage().kind === "note" && current()?.id === n.id) {
        if (t.kind === "folder") await page?.reload();
        else await openNote(change.note.id, pane() !== null);
      }
      setRev((r) => r + 1);
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function fileMany(ns: NoteSummary[], t: Target) {
    setMovingMany(null);
    try {
      const s = await api();
      const whole = await s.peekNotes(ns.map((x) => x.id));
      const tokens: string[] = [];
      for (const n of whole) {
        const { change } = await fileCapture(n, t);
        tokens.push(change.token.token);
      }
      if (tokens.length) {
        say(`Moved ${tokens.length} ${tokens.length === 1 ? "note" : "notes"}`, {
          undo: async () => {
            for (const tok of [...tokens].reverse()) await s.undo(tok);
            setRev((r) => r + 1);
          },
        });
        setRev((r) => r + 1);
      }
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  const fileSuggested = (n: Note, sg: AiSuggestion) =>
    fileOne(n, sg.kind === "merge" && sg.noteId != null ? { kind: "note", id: sg.noteId, title: sg.title } : { kind: "folder", folder: sg.folder });

  function keepLater(n: Note) {
    const next = keepUntil(laterMap(), n.path);
    setLaterMap(next);
    void api().then((s) => s.setUiSetting(LATER_KEY, JSON.stringify(next)).catch(() => {}));
    say("Kept for tomorrow", {
      undo: () => {
        const undoMap = { ...laterMap() };
        delete undoMap[n.path];
        setLaterMap(undoMap);
        return api().then((s) => s.setUiSetting(LATER_KEY, JSON.stringify(undoMap)));
      },
    });
  }

  async function trashNote(n: Pick<Note, "id" | "title">) {
    if (current()?.id === n.id) await page?.flush();
    const s = await api();
    try {
      const t = await s.trashNote(n.id);
      say(`Deleted “${n.title}”`, {
        undo: () =>
          s.undo(t.token).then(() => {
            setRev((r) => r + 1);
            if (pane() === null) void openNote(n.id);
          }),
      });
      if (pane() === null) void newNote();
      else setRev((r) => r + 1);
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function removeMany(ns: NoteSummary[]) {
    try {
      const s = await api();
      const tokens: string[] = [];
      for (const n of ns) tokens.push((await s.trashNote(n.id)).token);
      if (tokens.length) {
        say(`Deleted ${tokens.length} ${tokens.length === 1 ? "note" : "notes"}`, {
          undo: async () => {
            for (const tok of [...tokens].reverse()) await s.undo(tok);
            setRev((r) => r + 1);
          },
        });
        setRev((r) => r + 1);
      }
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function pinOne(n: Pick<Note, "id" | "pinned">) {
    await (await api()).pinNote(n.id, !n.pinned);
    if (current()?.id === n.id) await page?.reload();
    setPinRev((p) => p + 1);
    setRev((r) => r + 1);
    say(n.pinned ? "Unpinned" : "Pinned in the sidebar");
  }

  async function pinMany(ns: NoteSummary[]) {
    const s = await api();
    const wantPin = ns.some((n) => !n.pinned);
    for (const n of ns) await s.pinNote(n.id, wantPin);
    setPinRev((p) => p + 1);
    setRev((r) => r + 1);
    say(`${wantPin ? "Pinned" : "Unpinned"} ${ns.length} ${ns.length === 1 ? "note" : "notes"}`);
  }

  async function copyMany(ns: NoteSummary[]) {
    const s = await api();
    const whole = await s.peekNotes(ns.map((n) => n.id));
    const joined = whole.map((n) => copyBody(n)).filter(Boolean).join("\n\n---\n\n");
    if (!joined) return;
    await s.copyText(joined, false);
    say(`Copied ${whole.length} ${whole.length === 1 ? "item" : "items"}`);
  }

  const commands: Command[] = [
    { id: "new", label: "New note", get keys() { return keyLabel("new"); }, run: () => void newNote() },
    { id: "capture", label: "Quick Bar: Capture", get keys() { return keyLabel("capture"); }, run: () => void api().then((s) => s.openCapture()) },
    { id: "picker", label: "Quick Bar: Copy prompt or snippet", get keys() { return keyLabel("picker"); }, run: () => void api().then((s) => s.openPicker()) },
    { id: "library", label: "Toggle collection list", get keys() { return keyLabel("library"); }, run: () => void (pane()?.kind === "list" ? setPane(null) : openPlace(lastPlace())) },
    { id: "today", label: "Today's page", get keys() { return keyLabel("today"); }, run: () => void openDay(today()) },
    { id: "inbox", label: "Inbox", run: () => void openPlace("inbox") },
    { id: "tasks", label: "Open tasks", run: () => void openTasksPane() },
    { id: "week", label: "The week: what you wrote, what is open, and a few words from Claude", run: () => openPanel("week", setWeek) },
    { id: "trash", label: "Trash: put back a deleted note, or empty the old ones", run: () => openPanel("trash", setTrash) },
    { id: "copy", label: "Copy", when: onNote, run: () => void copy("plain") },
    { id: "copy-md", label: "Copy as Markdown", get keys() { return keyLabel("copyMd"); }, when: onNote, run: () => void copy("markdown") },
    { id: "copy-html", label: "Copy formatted (for mail and docs)", when: onNote, run: () => void copy("html") },
    { id: "tidy", label: "AI: Tidy this note", when: onNote, run: () => page?.ai("tidy") },
    { id: "continue", label: "AI: Continue writing", when: onNote, run: () => page?.ai("continue") },
    { id: "summarize", label: "AI: Summarize this note", when: onNote, run: () => page?.ai("summarize") },
    { id: "title", label: "AI: Suggest a title", when: onNote, run: () => page?.ai("title") },
    { id: "related", label: "AI: Find related notes", when: onNote, run: () => (setInspector("about"), page?.findRelated()) },
    { id: "move", label: "Move to a note or collection…", get keys() { return keyLabel("move"); }, when: onNote, run: () => current() && setMoving({ note: current()! }) },
    { id: "task", label: "Add a task, or tick one", get keys() { return keyLabel("task"); }, when: () => stage().kind === "note", run: () => page?.task() },
    { id: "beside", label: "Open a note beside this one", get keys() { return keyLabel("beside"); }, run: () => setTimeout(() => setBar("beside")) },
    { id: "beside-close", label: "Close the note beside", when: () => beside() !== null, run: () => void closeBeside() },
    { id: "back", label: "Back to the note before", get keys() { return keyLabel("back"); }, when: () => others().length > 0, run: () => void openNote(others()[0]) },
    {
      id: "focus",
      label: "Paragraph focus: fade the other paragraphs",
      run: () => {
        const on = !prefs().focus;
        void changePref("focus", on, async (k, v) => (await api()).setUiSetting(k, v));
        say(on ? "Paragraph focus is on" : "Paragraph focus is off");
      },
    },
    { id: "pin", label: "Pin or unpin this note", when: onNote, run: () => current() && void pinOne(current()!) },
    { id: "inspector", label: "Toggle Inspector (Outline, Links & History)", get keys() { return keyLabel("inspector"); }, when: () => stage().kind === "note", run: () => setInspector(inspector() ? null : "about") },
    { id: "history", label: "History of this note", get keys() { return keyLabel("history"); }, when: onNote, run: () => setInspector(inspector() === "history" ? null : "history") },
    { id: "read", label: "Toggle Read view (in place)", get keys() { return keyLabel("read"); }, when: onNote, run: () => setReadMode(!readMode()) },
    { id: "delete", label: "Delete this note", when: onNote, run: () => current() && void trashNote(current()!) },
    { id: "rescan", label: "Look for changes in the folder", run: () => void rescan(true) },
    { id: "settings", label: "Settings", get keys() { return keyLabel("settings"); }, run: () => setSettings("all") },
    { id: "first-steps", label: "First steps: five things to try", run: () => (showSteps(), void newNote()) },
    { id: "shortcuts", label: "All shortcuts", get keys() { return keyLabel("shortcuts"); }, run: () => setKeysOpen(true) },
  ];

  async function folderChanged(r: ScanReport) {
    setRev((v) => v + 1);
    const n = current();
    if (!n || !r.paths.includes(n.path) || page?.dirty()) return;
    if (await page?.refresh()) tell(/google drive|googledrive|my drive/i.test(root()) ? "Updated from Drive" : "Updated from the folder");
  }

  let lastScan = 0;
  async function rescan(loud = false) {
    if (!loud && Date.now() - lastScan < 5000) return;
    lastScan = Date.now();
    try {
      await page?.flush();
      const r = await (await api()).scanNotes();
      const n = r.added + r.changed + r.removed;
      await folderChanged(r);
      if (loud) say(n ? `${r.added} new, ${r.changed} changed, ${r.removed} gone` : "Up to date");
    } catch (e) {
      if (loud) say(errText(e), { error: true });
    }
  }

  const overlay = () => !!(bar() || settings() || moving() || movingMany() || facing() || week() || trashOpen() || keysOpen() || settling());

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
    } else if ((matches(e, "beside") || (mod && !e.altKey && !e.shiftKey && (e.key === "\\" || e.code === "Backslash"))) && !overlay()) {
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
    if (matches(e, "find")) setBar(bar() ? null : "all");
    else if (matches(e, "notes")) setBar(bar() ? null : "notes");
    else if (matches(e, "shortcuts") || (e.key === "?" && !typing(e) && !overlay())) setKeysOpen(!keysOpen());
    else if (overlay()) return;
    else if (matches(e, "sidebar")) toggleSide();
    else if (matches(e, "new")) void newNote();
    else if (matches(e, "library")) void (pane()?.kind === "list" ? setPane(null) : openPlace(lastPlace()));
    else if (matches(e, "settings")) setSettings("all");
    else if (matches(e, "inspector") && stage().kind === "note") setInspector(inspector() ? null : "about");
    else if (matches(e, "history") && onNote()) setInspector(inspector() === "history" ? null : "history");
    else if (matches(e, "read") && onNote()) setReadMode(!readMode());
    else if (matches(e, "move") && onNote()) setMoving({ note: current()! });
    else if (e.altKey && !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight") && onDay()) {
      void openDay(addDays(onDay()!, e.key === "ArrowLeft" ? -1 : 1));
    } else if (matches(e, "copyMd") && onNote()) void copy("markdown");
    else if (mod && !e.altKey && ["=", "+", "-", "_"].includes(e.key) && stage().kind === "note") {
      const size = stepSize(prefs().editorSize, e.key === "-" || e.key === "_" ? -1 : 1);
      void changePref("editorSize", size, async (k, v) => (await api()).setUiSetting(k, v));
      say(`Type ${size} px`);
    } else if (e.key === "Escape" && readMode()) {
      setReadMode(false);
      page?.focus();
    } else if (e.key === "Escape" && inspector() !== null && !typing(e)) {
      setInspector(null);
      page?.focus();
    } else if (e.key === "Escape" && beside() !== null && !e.defaultPrevented && !document.querySelector(".scrim, .menu, .explain")) {
      void closeBeside();
    } else if (e.key === "Escape" && pane() !== null && !typing(e) && !document.querySelector(".scrim")) {
      setPane(null);
      if (stage().kind !== "note") void newNote();
    } else if (!mod && !typing(e) && e.key === "z") {
      if (!undoLast()) return;
    } else return;
    e.preventDefault();
  };

  const dayKey = (e: KeyboardEvent) => {
    if (matches(e, "today") && !overlay()) {
      e.preventDefault();
      e.stopPropagation();
      if (onDay() !== today() || pane() !== null) void openDay(today());
    }
  };
  const stopSound = typingSound(() => prefs().sound);
  onCleanup(stopSound);
  onCleanup(watchQuiet());
  setBeforeInstall(async () => (await page?.flush(), await remember()));

  onMount(async () => {
    void watchSync();
    void api()
      .then((s) => s.desktopSettings())
      .then((d) => d.hotkeySupported !== false && setSystemKeys({ capture: d.hotkey, picker: d.pickerHotkey }), () => {});
    document.addEventListener("keydown", key);
    document.addEventListener("keydown", dayKey, true);
    document.addEventListener("keydown", earlyKey, true);
    document.addEventListener("keyup", keyUp, true);
    window.addEventListener("resize", () => {
      const w = innerWidth >= SIDEBAR_DOCK_PX;
      if (w !== wide()) setSideOn(w && sidePref);
      setWide(w);
    });
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
    await s.showWindow();
    setRoot((await s.notesInfo().catch(() => ({ root: "" }))).root);
    watchUpdates(() => prefs().updates);
    const stored = await s.uiSettings().catch(() => ({}) as Record<string, string>);
    sidePref = stored["ui.sidebar"] !== "0";
    setSideOn(sidePref && innerWidth >= SIDEBAR_DOCK_PX);
    setCustomKeys(parseKeyMap(stored["ui.keys"] ?? "{}"));
    setLaterMap(parseLater(stored[LATER_KEY]));
    learnKeys(stored[USED_KEY], (k, v) => s.setUiSetting(k, v));
    startSteps(stored[STEPS_KEY], (k, v) => s.setUiSetting(k, v));
    try {
      const r = JSON.parse(stored["ui.recent"] ?? "[]");
      if (Array.isArray(r)) setRecent(r.filter((x) => typeof x === "number").slice(0, RECENT_MAX));
    } catch {
      // ignore
    }
    const [lastId, at] = ((stored["last.note"] ?? "") as string).split(":").map(Number);
    if (lastId && Date.now() - at < RESUME_MS) void setNoteStage({ id: lastId, folder: "", focus: true });
    void s.aiStatus().then(setAi, () => {});
    await s.scanNotes().catch((e) => say(`The Petrel folder cannot be read: ${errText(e)}`, { error: true }));
    setRev((r) => r + 1);
    await s.listen({
      quit: async () => {
        await page?.flush();
        await remember();
        await s.closeWindow();
      },
      openNote: (id) => void openNote(id),
      lastSync: () => {
        void page?.flush();
        say("Sending the last changes to Drive before closing…");
      },
      focus: () => {
        void rescan();
        if (syncStatus()?.on) void api().then((s) => s.syncNow());
      },
      folder: (r) => void folderChanged(r),
      changed: () => (stepDone("capture"), setRev((r) => r + 1)),
    });
    if (inTauri) {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
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

  const noteStage = () => {
    const st = stage();
    return st.kind === "note" ? st : null;
  };
  const copyStage = () => {
    const st = stage();
    return st.kind === "copy" ? st : null;
  };

  const barTitle = () => {
    if (settings()) return "Settings";
    const pn = pane();
    const st = stage();
    if (st.kind === "inbox-clear") return "Inbox";
    if (st.kind === "copy") {
      const n = lib()?.notes.find((x) => x.id === st.id);
      return n ? (n.folder === "inbox" ? "Capture" : n.title) : pn?.kind === "list" && pn.place === "inbox" ? "Inbox" : "";
    }
    return title() || (noteStage()?.id === null ? "New note" : "");
  };

  const activeFolder = () => {
    const st = stage();
    if (st.kind === "note") return onDay() ? "journal" : (noteFolder() ?? st.folder);
    if (st.kind === "copy") return st.folder;
    return null;
  };

  return (
    <div class="app">
      <TitleBar
        title={barTitle()}
        folder={settings() ? null : activeFolder()}
        canMove={onNote() && !onDay()}
        onMove={(anchor) => current() && setMoving({ note: current()!, anchor })}
        sidebar={sideOn()}
        onSidebar={toggleSide}
        onSearch={() => setBar("all")}
        onNote={onNote()}
        readMode={readMode()}
        onToggleRead={() => setReadMode(!readMode())}
        inspectorOpen={inspector() !== null}
        onToggleInspector={() => setInspector(inspector() ? null : "about")}
      />

      <div class="app-body">
        <Show when={sideOn()}>
          <Show when={!docked()}>
            <div class="side-scrim" onMouseDown={() => setSideOn(false)} />
          </Show>
          <Sidebar
            rev={rev()}
            pinRev={pinRev()}
            noteId={stage().kind === "note" ? (current()?.id ?? null) : null}
            onNote={(id) => void openNote(id)}
            here={here()}
            docked={docked()}
            root={root()}
            onNew={() => void newNote()}
            onToday={() => void openDay(today())}
            onInbox={() => void openPlace("inbox")}
            onTasks={() => void openTasksPane()}
            onCollection={(f) => void openPlace(`c:${f}`)}
            onFolderChanged={(from, to) => void folderMoved(from, to)}
            onSettings={() => setSettings("all")}
            onSync={() => setSettings("sync")}
            onClose={() => setSideOn(false)}
          />
        </Show>

        {/* Middle Context Pane (Slim list for Collection / Inbox, or Open Tasks — hidden in pure writing / Today) */}
        <Show when={pane()?.kind === "list"}>
          <WorkspaceList
            place={(pane() as { kind: "list"; place: string }).place}
            data={lib()}
            activeId={stage().kind === "note" || stage().kind === "copy" ? (stage() as { id: number | null }).id : null}
            snoozed={snoozed()}
            busy={overlay()}
            onSelect={selectFromList}
            onNew={(folder) => void setNoteStage({ id: null, folder, focus: true })}
            onMoveMany={(ns) => setMovingMany(ns)}
            onPinMany={(ns) => void pinMany(ns)}
            onCopyMany={(ns) => void copyMany(ns)}
            onDeleteMany={(ns) => void removeMany(ns)}
            onSettle={setSettling}
            onFace={(top) => setFacing(top)}
            onPin={(n) => void pinOne(n)}
          />
        </Show>

        <Show when={pane()?.kind === "tasks"}>
          <Tasks
            rev={rev()}
            activeNoteId={stage().kind === "note" ? (current()?.id ?? null) : null}
            onSelect={(id) => void setNoteStage({ id, folder: "", focus: false })}
            onTicked={(id) => {
              setRev((r) => r + 1);
              if (current()?.id === id) void page?.refresh();
            }}
          />
        </Show>

        {/* Main Direct Stage */}
        <main class="view" classList={{ split: beside() !== null && stage().kind === "note" }}>
          <Suspense>
            <Show when={stage().kind === "inbox-clear"}>
              <div class="inbox-clear-stage">
                <Petrel />
                <p class="review-clear-title">Inbox clear.</p>
                <p class="muted small">Captures from {keyLabel("capture")} land here for 1-click filing.</p>
                <button type="button" class="btn" onClick={() => void newNote()}>
                  Start writing <kbd>Ctrl N</kbd>
                </button>
              </div>
            </Show>

            <Show when={copyStage()} keyed>
              {(c) => (
                <Sheet
                  inline
                  id={c.id}
                  copies={lib()?.copies[lib()?.notes.find((x) => x.id === c.id)?.path ?? ""] ?? 0}
                  aiReady={ai().ready}
                  onClose={() => {}}
                  onCopied={() => setRev((r) => r + 1)}
                  onEdit={(id) => void setNoteStage({ id, folder: c.folder, focus: true })}
                  onMove={(n) => setMoving({ note: n })}
                  onFileTarget={(n, t) => void fileOne(n, t)}
                  onFile={(n, sg) => void fileSuggested(n, sg)}
                  onLater={c.folder === "inbox" ? keepLater : undefined}
                  onDelete={(n) => void trashNote(n)}
                  onAiSetup={() => setSettings("ai")}
                />
              )}
            </Show>

            <Show when={noteStage()}>
              {(v) => (
                <NotePage
                  id={v().id}
                  folder={v().folder}
                  root={root()}
                  aiReady={ai().ready}
                  autoFocus={v().focus}
                  readMode={readMode()}
                  onExitRead={() => (setReadMode(false), page?.focus())}
                  inspector={inspector()}
                  onInspector={setInspector}
                  onOpen={(id) => void openNote(id, pane() !== null)}
                  onFolder={(folder) => void openPlace(folder === "inbox" ? "inbox" : `c:${folder.split("/")[0]}`)}
                  onHome={() => void newNote()}
                  onHistory={() => setInspector("history")}
                  onAiSetup={() => setSettings("ai")}
                  onTitle={setTitle}
                  day={v().day ?? null}
                  onDay={(d) => void openDay(d)}
                  onNoteId={(id) => (seen(id), setNoteFolder(page?.note()?.folder ?? null))}
                  onBeside={(id) => void openBeside(id)}
                  onAsk={(about) => (setAsking(about), setBar("about"))}
                  onAskNotes={(q) => (setAskAll(q ?? ""), setBar("all"))}
                  besideOpen={beside() !== null}
                  notice={notice()}
                  ref={(h) => (page = h)}
                />
              )}
            </Show>

            <Show when={stage().kind === "note" && beside()}>
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

      {/* Ctrl Tab Recent Switcher */}
      <Show when={switcher()?.shown && switcher()}>
        {(s) => (
          <div class="switcher" role="listbox" aria-label="Recent notes">
            <For each={s().ids.slice(0, 8)}>
              {(id, k) => {
                const n = () => s().notes.find((x) => x.id === id);
                return (
                  <div class="switcher-row" role="option" aria-selected={k() === s().i} classList={{ on: k() === s().i }} onMouseDown={(e) => (e.preventDefault(), setSwitcher({ ...s(), i: k() }), switchDone())}>
                    <span class="row-label">{n() ? (n()!.folder === "inbox" ? n()!.preview.split("\n")[0] : listName(n()!)) : "…"}</span>
                    <span class="row-sub">{n() ? folderName(n()!.folder) : ""}</span>
                  </div>
                );
              }}
            </For>
            <p class="muted small">Tab next · Shift Tab back · let go of Ctrl to open</p>
          </div>
        )}
      </Show>

      {/* Single Omnibox (Ctrl K) */}
      <Show when={bar()}>
        <CommandBar
          commands={commands}
          notesOnly={bar() === "notes" || bar() === "beside"}
          placeholder={bar() === "beside" ? "Open a note beside this one…" : undefined}
          recent={others()}
          aiReady={ai().ready}
          about={bar() === "about" ? (asking() ?? undefined) : undefined}
          ask={bar() === "about" ? asking()?.ask : bar() === "all" ? askAll() || undefined : undefined}
          onOpen={bar() === "beside" ? (id) => void openBeside(id) : (id) => void openNote(id)}
          onAiSetup={() => setSettings("ai")}
          onSettle={setSettling}
          onClose={() => {
            barClosedAt = Date.now();
            setAskAll("");
            setBar(null);
            page?.focus();
          }}
        />
      </Show>

      {/* Lightweight Move Popover / Picker */}
      <Show when={moving()}>
        {(m) => (
          <Destination
            exclude={m().note.id}
            what={m().note.folder === "inbox" ? undefined : m().note.title}
            from={m().note.folder === "inbox" ? undefined : m().note.folder}
            anchored={m().anchor}
            onPick={(t) => void fileOne(m().note, t)}
            onClose={() => setMoving(null)}
          />
        )}
      </Show>
      <Show when={movingMany()}>
        {(ns) => (
          <Destination
            exclude={ns().map((n) => n.id)}
            what={`${ns().length} selected ${ns().length === 1 ? "note" : "notes"}`}
            onPick={(t) => void fileMany(ns(), t)}
            onClose={() => setMovingMany(null)}
          />
        )}
      </Show>
      <Show when={facing()}>{(top) => <FacePicker top={top()} onClose={() => (setFacing(null), setRev((r) => r + 1))} />}</Show>

      <Suspense>
        <Show when={settings()}>
          <Settings
            section={settings() || undefined}
            onClose={() => setSettings(false)}
            onRoot={(r) => (setRoot(r), setRev((v) => v + 1))}
            onAi={setAi}
            onOpen={(id) => (setSettings(false), void openNote(id))}
          />
        </Show>
        <Show when={settling()}>
          {(c) => (
            <Settle
              conflict={c()}
              onClose={() => (setSettling(null), page?.focus())}
              onDone={() => {
                const id = c().original;
                setSettling(null);
                setRev((r) => r + 1);
                if (current()?.id === id) void page?.refresh();
              }}
            />
          )}
        </Show>
        <Show when={trashOpen()}>
          <Trash onClose={() => closePanel("trash", setTrash)} onOpen={(id) => void openNote(id)} onChanged={() => setRev((r) => r + 1)} />
        </Show>
        <Show when={week()}>
          <Week
            aiReady={ai().ready}
            onClose={() => closePanel("week", setWeek)}
            onOpen={(id) => void openNote(id)}
            onAiSetup={() => (setWeek(false), setSettings("ai"))}
            onReview={() => (setWeek(false), void openPlace("inbox"))}
          />
        </Show>
        <Show when={keysOpen()}>
          <Shortcuts onClose={() => setKeysOpen(false)} onSettings={() => (setKeysOpen(false), setSettings("keys"))} />
        </Show>
      </Suspense>
      <UpdateNotice />
      <ToastView />
    </div>
  );
}
