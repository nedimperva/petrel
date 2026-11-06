import { createSignal, For, lazy, onCleanup, onMount, Show } from "solid-js";
import { api, type Link, type Action, type AppInfo, type Draft, type Folder, type HostRequest, type RunLogEntry, type RunReport, type TagCount, type UndoToken } from "./api";
import ActionList, { firstAction, type ActionListHandle } from "./actions/ActionList";
import type { LogHandle } from "./actions/ActionLog";
import HostDialog from "./actions/HostDialog";
import { fromEvent, isChord, same } from "./actions/shortcut";
import { countWords, createAutosave, createCloser, type SaveState } from "./editor/autosave";
import { createEditor, type EditorHandle } from "./editor/editor";
import { openSearchPanel } from "@codemirror/search";
import { applyEditorPrefs, awayThreshold, parsePrefs, prefs, setPrefs } from "./settings/prefs";
import DraftList, { type ListHandle, type Tab } from "./list/DraftList";
// Not lazy: they take keys the moment they open, and keys typed while a chunk loads would be lost (5 kB gz).
import CommandBar, { type Command } from "./palette/CommandBar";
import Versions, { type VersionsHandle } from "./versions/Versions";
import type { NotesHandle, NotesStart } from "./notes/NotesView";
import type { Extension } from "@codemirror/state";

// Not on the launch path: loaded the first time they open.
const ActionEditor = lazy(() => import("./actions/ActionEditor"));
const ActionLog = lazy(() => import("./actions/ActionLog"));
const Settings = lazy(() => import("./settings/Settings"));
const NotesView = lazy(() => import("./notes/NotesView"));
const Promote = lazy(() => import("./notes/Promote"));
const NoteFinder = lazy(() => import("./notes/NoteFinder"));


/** How long a toast stays in the strip. */
const TOAST_MS = 5000;

/** A run shows as running only after this long; most runs are done by then. The editor stops taking keys at once. */
const RUNNING_AFTER_MS = 150;

const ACTIONS_KEY = "petrel.actions.visible";

// Hidden until asked for: the launch screen is the text and nothing else.
function actionsVisible(): boolean {
  try {
    return localStorage.getItem(ACTIONS_KEY) === "1";
  } catch {
    return false;
  }
}

interface Undoable {
  label: string;
  token: string;
  /** The draft the editor showed when it was archived or trashed from the editor, reopened on undo. */
  reopen?: number;
}

export default function App() {
  let editorEl!: HTMLDivElement;
  let tagInput: HTMLInputElement | undefined;
  let editor: EditorHandle | undefined;
  let list: ListHandle | undefined;
  let actionList: ActionListHandle | undefined;
  let actionLog: LogHandle | undefined;
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [save, setSave] = createSignal<SaveState>("saved");
  const [words, setWords] = createSignal(0);
  const [info, setInfo] = createSignal<AppInfo | null>(null);
  const [listOpen, setListOpen] = createSignal(false);
  /** Where the list opens next (the command bar picks a tab or a tag). */
  const [listStart, setListStart] = createSignal<{ tab?: Tab; tag?: string; query?: string } | undefined>(undefined);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  /** The history panel (`Ctrl H`) for the open draft. */
  const [historyOpen, setHistoryOpen] = createSignal(false);
  let history: VersionsHandle | undefined;
  /** Notes (`Ctrl 3`): the home of cards or a note page, over the draft editor. */
  const [notesOpen, setNotesOpen] = createSignal(false);
  const [notesStart, setNotesStart] = createSignal<NotesStart>({ kind: "home" });
  let notes: NotesHandle | undefined;
  /** `Ctrl P`. */
  const [finderOpen, setFinderOpen] = createSignal(false);
  /** `Ctrl Shift N`: the promote dialog, on a new note or adding to one. */
  const [promoting, setPromoting] = createSignal<"new" | "append" | null>(null);
  /** The `[[link]]` extension, loaded after the first paint and shared with the note editor. */
  const [links, setLinks] = createSignal<Extension | undefined>(undefined);
  /** Focus mode (`Ctrl Shift D`): the text alone, the paragraph being written in full colour. */
  const [focusMode, setFocusMode] = createSignal(false);
  const [tagging, setTagging] = createSignal(false);
  const [allTags, setAllTags] = createSignal<TagCount[]>([]);
  const [toast, setToast] = createSignal<{ text: string; undo: boolean; log?: boolean } | null>(null);
  const [actions, setActions] = createSignal<Action[]>([]);
  const [actionsOpen, setActionsOpen] = createSignal(actionsVisible());
  /** The action editor is open; `action` null is a new one. */
  const [editing, setEditing] = createSignal<{ action: Action | null } | null>(null);
  const [logOpen, setLogOpen] = createSignal(false);
  const [requests, setRequests] = createSignal<HostRequest[]>([]);
  /** The action that is running, and whether it has run long enough to show. */
  const [running, setRunning] = createSignal<{ name: string; shown: boolean } | null>(null);
  let undoStack: Undoable[] = [];
  let toastTimer: number | undefined;
  let wordsTimer: number | undefined;
  let awaySince: number | null = null;
  let gPending = false;

  const autosave = createAutosave({ store: () => api, editor: () => editor, draft, setDraft, setSave });
  const closeDraft = createCloser({
    autosave,
    text: () => editor?.text() ?? "",
    rescue: async (text) => (await api).rescueText(text),
    close: async () => (await api).closeWindow(),
    say,
  });

  /** Both editors are saved before the window goes: a note page that will not save keeps the window open. */
  async function close() {
    if (notes && !(await notes.flush())) {
      say("A note is not saved yet. The text stays here until it is.");
      return;
    }
    await closeDraft();
  }

  function countLater() {
    window.clearTimeout(wordsTimer);
    wordsTimer = window.setTimeout(() => setWords(editor ? countWords(editor.text()) : 0), 300);
  }

  function onChange() {
    autosave.changed();
    countLater();
  }

  /** Saves what is typed. False, said in the strip, when it can't be: the text stays in the editor (saving keeps
   * retrying), so nothing may replace it. */
  async function saved(): Promise<boolean> {
    if (await autosave.flush()) return true;
    say(`Not saved: ${autosave.error() ?? "unknown error"}. The text stays here until it is.`);
    return false;
  }

  /** Shows a draft without saving the editor's text; callers have saved it, or must not (after an action). */
  function show(d: Draft | null) {
    autosave.load(d);
    setListOpen(false);
    setWords(d ? countWords(d.content) : 0);
  }

  /** Saves, then shows what `next` loads. Nothing is awaited between the last save and the switch, so keys typed
   * while the next draft loads are saved first rather than dropped. */
  async function leaveFor(next: () => Promise<Draft | null>) {
    for (let round = 0; round < 3; round++) {
      if (!(await saved())) return;
      let d: Draft | null;
      try {
        d = await next();
      } catch (e) {
        return say(`Cannot open: ${e}`);
      }
      if (!autosave.dirty()) return show(d);
    }
  }

  const newDraft = () => leaveFor(async () => null);

  async function openDraft(id: number) {
    await leaveFor(async () => (await api).openDraft(id));
  }

  function say(text: string, undo = false, log = false) {
    window.clearTimeout(toastTimer);
    setToast({ text, undo, log });
    toastTimer = window.setTimeout(() => setToast(null), TOAST_MS);
  }

  function remember(u: Undoable, count: number) {
    if (count === 0) {
      say(`${u.label}: nothing changed.`);
      return;
    }
    undoStack.push(u);
    if (undoStack.length > 20) undoStack.shift();
    say(u.label, true);
  }

  async function undo() {
    const u = undoStack.pop();
    if (!u) {
      say("Nothing to undo.");
      return;
    }
    try {
      const n = await (await api).undo(u.token);
      say(`Undone: ${u.label.toLowerCase()} (${n}).`);
      if (u.reopen && !draft() && editor?.text() === "") await openDraft(u.reopen);
      else if (draft()) refreshDraft();
      list?.reload();
      if (notesOpen()) void notes?.rescan();
    } catch (e) {
      say(String(e).replace(/^Error: /, ""));
    }
  }

  async function refreshDraft() {
    const d = draft();
    if (d) setDraft({ ...(await (await api).openDraft(d.id)), content: d.content });
  }

  /** Archive or trash the draft in the editor, then start a new one (Drafts' habit: the next thing is new). */
  async function moveCurrent(folder: "archive" | "trash") {
    if (!(await saved())) return;
    const d = draft();
    if (!d) return;
    const label = folder === "archive" ? "Archived" : "Trashed";
    try {
      const t: UndoToken = await (await api).moveDrafts([d.id], folder);
      await newDraft();
      remember({ label: `${label} “${d.title || "untitled"}”`, token: t.token, reopen: d.id }, t.count);
    } catch (e) {
      say(`${label} failed: ${e}`);
    }
  }

  async function flagCurrent() {
    if (!(await saved())) return;
    const d = draft();
    if (!d) return;
    const flagged = !d.flagged;
    const t = await (await api).flagDrafts([d.id], flagged);
    setDraft({ ...d, flagged });
    remember({ label: flagged ? "Flagged" : "Unflagged", token: t.token }, t.count);
  }

  async function startTagging() {
    if (!(await saved())) return;
    if (!draft()) {
      say("Type something first: an empty draft has nothing to tag.");
      return;
    }
    setAllTags(await (await api).tagCounts(null));
    setTagging(true);
    queueMicrotask(() => {
      if (!tagInput) return;
      tagInput.value = draft()!.tags.join(", ");
      tagInput.focus();
      tagInput.select();
    });
  }

  async function saveTags() {
    const d = draft();
    const names = (tagInput?.value ?? "").split(/[,\s]+/).filter(Boolean);
    setTagging(false);
    editor?.view.focus();
    if (!d) return;
    try {
      const tags = await (await api).setTags(d.id, names);
      setDraft({ ...d, tags });
      say(tags.length ? `Tags: ${tags.join(", ")}` : "Tags cleared.");
    } catch (e) {
      say(`Tagging failed: ${e}`);
    }
  }

  function toggleList() {
    if (listOpen()) {
      setListOpen(false);
      editor?.view.focus();
    } else {
      openList();
    }
  }

  /** Opens the list, fresh, on `start` (Inbox when not given). */
  function openList(start?: { tab?: Tab; tag?: string; query?: string }) {
    void autosave.flush();
    setLogOpen(false);
    // The list reads where to start when it mounts, so an open one is remounted.
    setListOpen(false);
    setListStart(start);
    setListOpen(true);
  }

  // ---- command bar (package 05) ----------------------------------------------------------------------------

  const TAB_NAMES: [Tab, string][] = [
    ["inbox", "Inbox"],
    ["flagged", "Flagged"],
    ["archive", "Archive"],
    ["trash", "Trash"],
    ["all", "All drafts"],
  ];

  /** Every command the bar offers, with the key that does the same, so the bar teaches the keys. */
  function commands(): Command[] {
    const inTauri = "__TAURI_INTERNALS__" in window;
    const list: Command[] = [
      { id: "new", name: "New draft", keys: "Ctrl N", run: newDraft },
      { id: "drafts", name: "Show drafts", keys: "Ctrl L", run: () => openList() },
      ...TAB_NAMES.map(([tab, name]): Command => ({ id: `tab:${tab}`, name: `Go to ${name}`, run: () => openList({ tab }) })),
      { id: "find", name: "Find in this draft", keys: "Ctrl F", run: () => editor && openSearchPanel(editor.view) },
      { id: "archive", name: "Archive this draft", keys: "Ctrl E", run: () => moveCurrent("archive") },
      { id: "trash", name: "Move this draft to Trash", keys: "Ctrl #", run: () => moveCurrent("trash") },
      { id: "flag", name: "Flag or unflag this draft", keys: "Ctrl Shift F", run: flagCurrent },
      { id: "tags", name: "Tag this draft", keys: "Ctrl T", run: startTagging },
      { id: "focus", name: "Focus mode", keys: "Ctrl Shift D", run: toggleFocus },
      { id: "history", name: "History of this draft: see and restore older text", keys: "Ctrl H", run: openHistory },
      { id: "undo", name: "Undo the last move, flag or tag", run: undo },
      { id: "actions", name: "Show or hide actions", keys: "Ctrl 2", run: toggleActions },
      { id: "new-action", name: "New action", keys: "Ctrl Shift A", run: () => editAction(null) },
      { id: "log", name: "Action log", run: openLog },
      { id: "settings", name: "Settings: capture hotkey, start at login, notes folder", keys: "Ctrl ,", run: () => setSettingsOpen(true) },
      { id: "notes", name: "Notes home", keys: "Ctrl 3", run: () => openNotes({ kind: "home" }) },
      { id: "find-note", name: "Find a note", keys: "Ctrl P", run: () => setFinderOpen(true) },
      { id: "new-note", name: "New note", run: () => openNotes({ kind: "new" }) },
      { id: "promote", name: "Promote this draft to a note", keys: "Ctrl Shift N", run: () => startPromote("new") },
      { id: "append-note", name: "Add this draft to the end of a note", run: () => startPromote("append") },
      { id: "pin-note", name: "Pin or unpin this note", run: () => (notesOpen() ? notes?.pin() : say("Open a note first: Ctrl P finds one.")) },
    ];
    if (inTauri) {
      list.splice(2, 0, { id: "capture", name: "Open the capture window", run: async () => (await api).openCapture() });
    }
    return list;
  }

  function closePalette() {
    setPaletteOpen(false);
    editor?.view.focus();
  }

  // ---- notes (docs/design/notes.md) -------------------------------------------------------------------------

  /** Shows the notes view on `start`, saving the draft first. */
  async function openNotes(start: NotesStart) {
    if (!(await saved())) return;
    setListOpen(false);
    setHistoryOpen(false);
    setLogOpen(false);
    setTagging(false);
    leaveEditor();
    if (notesOpen() && notes) return notes.show(start);
    setNotesStart(start);
    setNotesOpen(true);
  }

  /** Back to the draft editor, once the note is saved. */
  async function closeNotes(): Promise<boolean> {
    if (notes && !(await notes.flush())) {
      say("The note is not saved yet. The text stays here until it is.");
      return false;
    }
    setNotesOpen(false);
    notes = undefined;
    editor?.view.focus();
    return true;
  }

  async function startPromote(mode: "new" | "append") {
    if (notesOpen()) return say("That is a note already. Promote works on a draft (Esc goes back to drafts).");
    if (!(await saved())) return;
    if (!draft()) return say("Type something first: an empty draft has nothing to keep.");
    leaveEditor();
    setPromoting(mode);
  }

  async function promoted(c: import("./api").NoteChange, mode: "new" | "append") {
    setPromoting(null);
    const links = c.relinked ? ` Links in ${c.relinked} ${c.relinked === 1 ? "text" : "texts"} now go to the note.` : "";
    // Drafts' habit: the draft is filed away, the editor is ready for the next one.
    await newDraft();
    list?.reload();
    remember({ label: `${mode === "new" ? "Promoted to" : "Added to"} “${c.note.title}”.${links}`, token: c.token.token }, Math.max(1, c.token.count));
  }

  /** Follows `[[inner]]` from either editor. A note that is not there yet is made, in the open note's folder. */
  async function followWikiLink(inner: string) {
    const a = await api;
    let r: import("./api").Resolved;
    try {
      r = await a.resolveLink(inner);
    } catch (e) {
      return say(String(e).replace(/^Error: /, ""));
    }
    if (r.kind === "note") return openNotes({ kind: "note", id: r.id });
    if (r.kind === "draft") {
      if (notesOpen() && !(await closeNotes())) return;
      return openDraft(r.id);
    }
    if (r.draft) return say(`No draft called “${r.title}”.`);
    try {
      if (notesOpen() && notes && !(await notes.flush())) return;
      const n = await a.createNote(r.folder ?? notes?.folder() ?? "", r.title, "", []);
      say(`New note “${n.title}”.`);
      await openNotes({ kind: "note", id: n.id });
    } catch (e) {
      say(String(e).replace(/^Error: /, ""));
    }
  }

  async function loadLinks() {
    const m = await import("./notes/links");
    const ext = m.linkExtensions({
      open: (inner) => void followWikiLink(inner),
      resolve: async (inner) => (await api).resolveLink(inner),
      preview: async (r) => {
        const a = await api;
        if (r.kind === "note") {
          const n = await a.peekNote(r.id);
          return { title: n.title, where: n.folder ? `Note · ${n.folder}` : "Note", text: n.body.replace(/\s+/g, " ").trim().slice(0, 180) };
        }
        if (r.kind === "draft") {
          const d = await a.peekDraft(r.id);
          return { title: d.title || "untitled", where: `Draft · ${d.folder}`, text: d.content.split("\n").slice(1).join(" ").trim().slice(0, 180) };
        }
        return null;
      },
      targets: async (text) => (await api).linkTargets(text, 8),
      create: async (title) => {
        const n = await (await api).createNote(notes?.folder() ?? "", title, "", []);
        say(`New note “${n.title}”.`);
      },
    });
    editor?.setExtra(ext);
    setLinks(ext);
  }

  // ---- petrel:// links (package 07) ------------------------------------------------------------------------

  /** Runs the links that arrived. One at a time, in order: each may switch the open draft. */
  async function takeLinks() {
    let links: Link[];
    try {
      links = await (await api).takeLinks();
    } catch (e) {
      return say(`Links cannot be read: ${e}`);
    }
    for (const l of links) {
      try {
        await followLink(l);
      } catch (e) {
        say(`Link failed: ${String(e).replace(/^Error: /, "")}`);
      }
    }
  }

  async function followLink(l: Link) {
    const a = await api;
    if (l.kind === "unknown") return say(`Link not followed: ${l.why}.`);
    if (l.kind === "search") return openList({ tab: "all", query: l.query });
    if (l.kind === "create") {
      if (!l.text.trim()) return newDraft();
      if (!(await saved())) return;
      const d = await a.newDraft(l.text);
      if (l.tags.length) await a.setTags(d.id, l.tags);
      await openDraft(d.id);
      return say("New draft from a link.");
    }
    const id = await a.findDraft(l.uuid);
    if (id === null) return say("That link's draft is not in this Petrel.");
    if (l.kind === "open") return openDraft(id);
    // The open draft is changed in the editor, so the next autosave keeps the addition instead of overwriting it.
    if (id === draft()?.id && editor) {
      editor.insert(l.text, l.prepend);
      return say(l.prepend ? "Added at the top from a link." : "Added at the end from a link.");
    }
    const d = await a.peekDraft(id);
    const glue = (x: string, y: string) => (!x ? y : !y ? x : x.endsWith("\n") ? x + y : `${x}\n${y}`);
    const content = l.prepend ? glue(l.text, d.content) : glue(d.content, l.text);
    if (!(await a.saveDraft(id, content, d.cursor))) return say("That link's draft is in the Trash or gone.");
    list?.reload();
    say(`Added to “${d.title || "untitled"}” from a link.`);
  }

  /** Panels that take keys: until one has loaded and focused itself, keys must not land in the text. */
  function leaveEditor() {
    editor?.view.contentDOM.blur();
  }

  function openPalette() {
    leaveEditor();
    setTagging(false);
    setPaletteOpen(true);
    // The actions may have changed in the editor since they were loaded; the bar shows what is there now.
    void loadActions();
  }

  // ---- actions ------------------------------------------------------------------------------------------------

  async function loadActions() {
    try {
      setActions(await (await api).listActions());
    } catch (e) {
      say(`Actions cannot be read: ${e}`);
    }
  }

  /** `Ctrl 2`: show and focus the column; from inside it, hide it. */
  function toggleActions() {
    const inside = !!document.activeElement?.closest("aside.actions");
    const show = !actionsOpen() || !inside;
    setActionsOpen(show);
    try {
      localStorage.setItem(ACTIONS_KEY, show ? "1" : "0");
    } catch {
      // Remembering is a convenience.
    }
    if (show) queueMicrotask(() => actionList?.focus());
    else editor?.view.focus();
  }

  function openLog() {
    setListOpen(false);
    setLogOpen(true);
  }

  function closeLog() {
    setLogOpen(false);
    editor?.view.focus();
  }

  function editAction(a: Action | null) {
    setListOpen(false);
    setLogOpen(false);
    setEditing({ action: a });
  }

  function closeEditor() {
    setEditing(null);
    editor?.view.focus();
  }

  async function runAction(a: Action, source: "ui" | "shortcut", draftId?: number) {
    if (running()) {
      say(`${running()!.name} is still running. Esc stops it.`);
      return;
    }
    const onEditor = draftId === undefined || draftId === draft()?.id;
    const folder = draft()?.folder ?? "inbox";
    setRunning({ name: a.name, shown: false });
    // From here until the result is shown, a key typed would be overwritten by the result or would overwrite it.
    if (onEditor) editor?.setReadOnly(true);
    const slow = window.setTimeout(() => setRunning((r) => r && { ...r, shown: true }), RUNNING_AFTER_MS);
    try {
      if (!(await saved())) return;
      const id = draftId ?? draft()?.id;
      if (id === undefined) return say("Type something first: an action needs a draft.");
      const report = await (await api).runAction(a.uuid, id, onEditor && editor ? editor.selection() : null, source);
      await afterRun(report, onEditor, folder);
    } catch (e) {
      say(`${a.name}: ${String(e).replace(/^Error: /, "")}`);
    } finally {
      window.clearTimeout(slow);
      editor?.setReadOnly(false);
      setRunning(null);
      if (logOpen()) actionLog?.reload();
    }
  }

  async function afterRun(r: RunReport, onEditor: boolean, folder: Folder) {
    const o = r.outcome;
    if (o.status === "failed") {
      say(`${r.action}: failed at step ${o.step}: ${o.message}`, false, true);
      return;
    }
    if (o.status === "cancelled") return say(`${r.action}: cancelled.`);
    if (o.status === "conflict") return say(`${r.action}: not applied, ${o.message}.`, false, true);
    // Stopped is a clean exit (a dismissed prompt): nothing to say.
    if (o.status === "stopped") return;
    const unknown = r.unknownTags.length ? ` Unknown tags left as written: ${r.unknownTags.join(", ")}.` : "";
    const last = r.log.length ? ` ${r.log[r.log.length - 1]}` : "";
    say(`${r.action}: done.${last}${unknown}`, false, !!unknown);
    list?.reload();
    if (!onEditor) return r.openDraft !== null ? openDraft(r.openDraft) : undefined;
    // The editor still holds the text the run started from (saved, and read-only since), while the stored draft
    // may now be the action's result: show what is stored, never save the old text over it.
    if (autosave.dirty()) return;
    if (r.openDraft !== null) return show(await (await api).openDraft(r.openDraft));
    const fresh = await (await api).openDraft(r.draftId);
    // Drafts' habit: a draft the action filed away makes room for the next one.
    if (r.newDraft || fresh.folder !== folder) return show(null);
    if (!r.changed) return setDraft(fresh);
    show({ ...fresh, cursor: r.selection.head });
    editor?.select(r.selection.anchor, r.selection.head);
  }

  async function runAgain(e: RunLogEntry) {
    const a = actions().find((x) => x.uuid === e.actionUuid);
    if (!a) return say("That action is gone.");
    if (e.draftId !== null && e.draftId !== draft()?.id) await openDraft(e.draftId);
    await runAction(a, "ui", e.draftId ?? undefined);
  }

  async function answer(r: HostRequest, value: unknown) {
    setRequests((q) => q.filter((x) => x.id !== r.id));
    await (await api).hostReply(r.id, value);
  }

  function onKey(e: KeyboardEvent) {
    // A dialog, the action editor or the command bar takes every key.
    if (requests().length || editing() || paletteOpen() || settingsOpen() || finderOpen() || promoting()) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && !e.altKey && k === "k") return stop(e, openPalette);
    if (ctrl && !e.shiftKey && !e.altKey && e.key === ",") return stop(e, () => setSettingsOpen(true));
    if (ctrl && !e.shiftKey && !e.altKey && k === "p") return stop(e, () => (leaveEditor(), setFinderOpen(true)));
    if (ctrl && !e.shiftKey && !e.altKey && e.key === "3") {
      return stop(e, () => (notesOpen() && !notes?.current() ? closeNotes() : openNotes({ kind: "home" })));
    }
    if (notesOpen()) return notesKey(e, k, ctrl);
    if (ctrl && e.shiftKey && !e.altKey && k === "n") return stop(e, () => startPromote("new"));
    if (ctrl && !e.shiftKey && !e.altKey && k === "h") return stop(e, openHistory);
    if (e.key === "Escape" && running()) return stop(e, async () => (await api).cancelRun());
    if (ctrl && e.shiftKey && !e.altKey && k === "a") {
      const inside = !!document.activeElement?.closest("aside.actions");
      return stop(e, () => editAction(inside ? (actionList?.current() ?? null) : null));
    }
    if (ctrl && !e.shiftKey && !e.altKey) {
      if (k === "n") return stop(e, newDraft);
      if (k === "l") return stop(e, toggleList);
      if (k === "2") return stop(e, toggleActions);
      if (k === "enter") {
        const first = actionList?.first() ?? firstAction(actions());
        return stop(e, () => (first ? runAction(first, "shortcut") : say("No actions yet. Ctrl Shift A makes one.")));
      }
      if (k === "e" && !listOpen()) return stop(e, () => moveCurrent("archive"));
      if (k === "t" && !listOpen()) return stop(e, startTagging);
    }
    if (ctrl && e.shiftKey && !e.altKey && !listOpen()) {
      if (k === "f") return stop(e, flagCurrent);
      if (k === "d") return stop(e, toggleFocus);
      // `Ctrl #` is Ctrl Shift 3 on most layouts; match the key and the physical key.
      if (e.key === "#" || e.code === "Digit3") return stop(e, () => moveCurrent("trash"));
    }
    // An action's own chord works anywhere.
    const chord = fromEvent(e);
    if (chord && isChord(chord)) {
      const a = actions().find((x) => x.shortcut && isChord(x.shortcut) && same(x.shortcut, chord));
      if (a) return stop(e, () => runAction(a, "shortcut"));
    }
    const el = e.target as HTMLElement | null;
    const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    if (typing) return;
    if (logOpen()) {
      if (actionLog?.key(e)) e.preventDefault();
      return;
    }
    if (historyOpen()) {
      if (history?.key(e)) e.preventDefault();
      return;
    }
    if (listOpen()) {
      if (list?.key(e)) e.preventDefault();
      return;
    }
    if (el?.closest("aside.actions") && !ctrl && !e.altKey) {
      if (gPending) {
        gPending = false;
        if (e.key === "l") return stop(e, openLog);
        if ("ifatd".includes(e.key)) return stop(e, toggleList);
      }
      if (e.key === "g") {
        gPending = true;
        return stop(e, () => {});
      }
      if (actionList?.key(e)) e.preventDefault();
    }
  }

  /** Keys while the notes view is up. Draft keys that make no sense on a note say so instead of acting on the
   * draft hidden behind it. */
  function notesKey(e: KeyboardEvent, k: string, ctrl: boolean) {
    if (ctrl && !e.altKey && !e.shiftKey) {
      if (k === "n") return stop(e, () => notes?.show({ kind: "new" }));
      if (k === "l") return stop(e, async () => (await closeNotes()) && openList());
      if (k === "t") return stop(e, () => notes?.tag());
      if (k === "h") return stop(e, () => say("Notes keep their versions; a History panel for notes comes next."));
      if (k === "e" || k === "enter" || k === "2") return stop(e, () => say("That works on drafts. Esc goes back to them."));
    }
    if (ctrl && e.shiftKey && !e.altKey) {
      if (e.key === "#" || e.code === "Digit3") return stop(e, () => notes?.trash());
      if (k === "f" || k === "n") return stop(e, () => say("That works on drafts. Esc goes back to them."));
    }
    // A completion list or the search panel takes its own Escape.
    if (e.key === "Escape" && document.querySelector(".notes .cm-tooltip-autocomplete, .notes .cm-panels")) return;
    if (notes?.key(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function stop(e: KeyboardEvent, run: () => unknown) {
    e.preventDefault();
    e.stopPropagation();
    run();
  }

  async function openHistory() {
    if (historyOpen()) return closeHistory();
    if (!(await saved())) return;
    if (!draft()) return say("Type something first: a new draft has no history.");
    setListOpen(false);
    setLogOpen(false);
    leaveEditor();
    setHistoryOpen(true);
  }

  function closeHistory() {
    setHistoryOpen(false);
    editor?.view.focus();
  }

  async function restoreVersion(versionId: number) {
    const d = draft();
    if (!d || !(await saved())) return;
    try {
      const restored = await (await api).restoreVersion(d.id, versionId);
      setHistoryOpen(false);
      show(restored);
      say("Restored. The text it replaced is kept in History (Ctrl H).");
    } catch (e) {
      say(`Restore failed: ${String(e).replace(/^Error: /, "")}`);
    }
  }

  function toggleFocus() {
    const on = !focusMode();
    setFocusMode(on);
    editor?.setFocusMode(on);
    say(on ? "Focus mode. Ctrl Shift D to leave." : "Focus mode off.");
  }

  /** Back after the "open to a new draft" time with a draft open: start a new one, as Drafts does. The old one
   * is saved. */
  function away(hidden: boolean) {
    if (hidden) {
      awaySince ??= Date.now();
      void autosave.flush();
      void notes?.flush();
      return;
    }
    if (notesOpen()) void notes?.rescan();
    const since = awaySince;
    awaySince = null;
    const after = awayThreshold(prefs());
    if (since !== null && after !== null && Date.now() - since >= after && draft() && !listOpen() && !tagging() && !notesOpen()) {
      newDraft();
    }
  }

  onMount(async () => {
    editor = createEditor(editorEl, onChange);
    editor.view.focus();
    const a = await api;
    await a.showWindow();
    setInfo(await a.appInfo());
    // After the window is up: preferences only change the type, never what is on screen first.
    try {
      const p = parsePrefs(await a.uiSettings());
      setPrefs(p);
      applyEditorPrefs(p);
      editor.setTypewriter(p.typewriter);
    } catch (e) {
      console.error("preferences:", e);
    }
    window.addEventListener("blur", () => away(true));
    window.addEventListener("focus", () => away(false));
    window.addEventListener("beforeunload", () => void autosave.flush());
    document.addEventListener("visibilitychange", () => away(document.hidden));
    window.addEventListener("keydown", onKey, true);
    if ("__TAURI_INTERNALS__" in window) {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      // Closing waits for the save: `beforeunload` can't wait for one.
      await getCurrentWebviewWindow().onCloseRequested((e) => {
        e.preventDefault();
        void close();
      });
    }
    await a.listenHost({
      request: (r) => setRequests((q) => [...q, r]),
      closed: (id) => setRequests((q) => q.filter((x) => x.id !== id)),
      message: (_kind, text) => say(text),
    });
    await a.listenApp({
      // Tray "New draft" or `petrel --new`: the window is already being shown.
      newDraft: async () => {
        await newDraft();
        editor?.view.focus();
      },
      quit: () => void close(),
      links: () => void takeLinks(),
    });
    // Links that started Petrel, or came before the window listened.
    void takeLinks();
    loadActions();
    // After everything on the way to the first keystroke: `[[links]]` in the editor.
    void loadLinks().catch((e) => console.error("links:", e));
  });
  onCleanup(() => editor?.destroy());

  return (
    <div class="app" classList={{ focus: focusMode() }}>
      <div class="work">
        <div class="center">
          <main class="editor" ref={editorEl} />
          <Show when={!notesOpen() && !listOpen() && draft()?.promoted}>
            {(p) => (
              <div class="promoted" role="status">
                <span>
                  {p().kind === "append" ? "Added to" : "Promoted to"} <b>{p().noteTitle}</b> on{" "}
                  {new Date(p().at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}. Edits
                  here stay in this draft.
                </span>
                <button
                  class="primary"
                  onClick={() => (p().noteId !== null ? openNotes({ kind: "note", id: p().noteId! }) : say("That note's file is no longer in the notes folder."))}
                >
                  Open note
                </button>
              </div>
            )}
          </Show>
          <Show when={notesOpen()}>
            <NotesView
              ref={(h) => (notes = h)}
              start={notesStart()}
              links={links()}
              onClose={closeNotes}
              onOpenDraft={async (id) => (await closeNotes()) && openDraft(id)}
              onUndoable={(label, t) => remember({ label, token: t.token }, Math.max(1, t.count))}
              say={say}
            />
          </Show>
          <Show when={listOpen()}>
            <DraftList
              ref={(h) => (list = h)}
              start={listStart()}
              openId={draft()?.id ?? null}
              onOpen={openDraft}
              onClose={toggleList}
              onBatch={(label, t) => remember({ label, token: t.token }, t.count)}
              onUndo={undo}
              onToast={say}
              onLog={openLog}
            />
          </Show>
          <Show when={historyOpen() && draft()}>
            {(d) => (
              <Versions
                ref={(h) => (history = h)}
                draftId={d().id}
                title={d().title}
                current={() => editor?.text() ?? ""}
                actions={actions()}
                onRestore={restoreVersion}
                onClose={closeHistory}
              />
            )}
          </Show>
          <Show when={logOpen()}>
            <ActionLog
              ref={(h) => (actionLog = h)}
              onRunAgain={runAgain}
              onOpenDraft={(id) => {
                setLogOpen(false);
                openDraft(id);
              }}
              onClose={closeLog}
            />
          </Show>
          <Show when={editing()}>
            {(a) => (
              <ActionEditor
                action={a().action}
                all={actions()}
                onSaved={async (saved) => {
                  await loadActions();
                  actionList?.reveal(saved.uuid);
                  say(`Saved “${saved.name}”.`);
                }}
                onDeleted={() => {
                  loadActions();
                  closeEditor();
                  say("Action deleted.");
                }}
                onClose={closeEditor}
              />
            )}
          </Show>
          <Show when={tagging()}>
            <div class="bar tagbar">
              <span>Tags:</span>
              <input
                ref={tagInput}
                list="petrel-tags"
                placeholder="work, idea"
                onKeyDown={(e) => {
                  e.stopPropagation();
                  // preventDefault: focus moves to the editor before the key's default action would type there.
                  if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
                  if (e.key === "Enter") saveTags();
                  else if (e.key === "Escape") {
                    setTagging(false);
                    editor?.view.focus();
                  }
                }}
              />
              <span class="hint">
                <kbd>Enter</kbd> save <kbd>Esc</kbd> cancel
              </span>
            </div>
          </Show>
        </div>
        <Show when={actionsOpen()}>
          <ActionList
            ref={(h) => (actionList = h)}
            actions={actions()}
            running={running()?.shown ? running()!.name : null}
            onRun={runAction}
            onEdit={editAction}
            onBack={() => editor?.view.focus()}
          />
        </Show>
      </div>
      <Show when={paletteOpen()}>
        <CommandBar
          commands={commands()}
          actions={actions()}
          onAction={(a) => runAction(a, "ui")}
          onDraft={async (id) => (!notesOpen() || (await closeNotes())) && openDraft(id)}
          onNote={(id) => openNotes({ kind: "note", id })}
          onTag={(tag) => openList({ tag })}
          onClose={closePalette}
        />
      </Show>
      <Show when={settingsOpen()}>
        <Settings
          onPrefs={(p) => editor?.setTypewriter(p.typewriter)}
          onClose={() => {
            setSettingsOpen(false);
            editor?.view.focus();
          }}
        />
      </Show>
      <Show when={finderOpen()}>
        <NoteFinder
          onOpen={(id) => {
            setFinderOpen(false);
            void openNotes({ kind: "note", id });
          }}
          onCreate={(title) => {
            setFinderOpen(false);
            void openNotes({ kind: "new", title, folder: notes?.folder() ?? "" });
          }}
          onClose={() => {
            setFinderOpen(false);
            if (notesOpen()) notes?.editor()?.view.focus();
            else editor?.view.focus();
          }}
        />
      </Show>
      <Show when={promoting() && draft()}>
        {(d) => (
          <Promote
            draft={d()}
            mode={promoting()!}
            onDone={promoted}
            onClose={() => {
              setPromoting(null);
              editor?.view.focus();
            }}
          />
        )}
      </Show>
      <Show when={requests()[0]}>
        {(r) => <HostDialog request={r()} onAnswer={(v) => answer(r(), v)} />}
      </Show>
      <datalist id="petrel-tags">
        <For each={allTags()}>{(t) => <option value={t.name} />}</For>
      </datalist>
      {/* Quiet by design: what the writer needs to trust (saved), a count, and the two ways out. */}
      <footer class="strip">
        <span class={`save save-${save()}`}>
          {save() === "saved" && "saved"}
          {save() === "dirty" && "…"}
          {save() === "saving" && "saving…"}
          {save() === "error" && "not saved — retrying"}
        </span>
        <Show when={words()}>
          <span class="meta">{words() === 1 ? "1 word" : `${words().toLocaleString()} words`}</span>
        </Show>
        <Show when={draft()}>
          {(d) => (
            <>
              <Show when={d().flagged}>
                <span class="flag on" title="Flagged" />
              </Show>
              <Show when={d().folder !== "inbox"}>
                <span class="meta">{d().folder}</span>
              </Show>
              <For each={d().tags}>{(t) => <span class="meta">#{t}</span>}</For>
            </>
          )}
        </Show>
        <Show when={toast()}>
          {(t) => (
            <>
              <span class="toast">{t().text}</span>
              <Show when={t().log}>
                <button class="link" onClick={openLog}>
                  Log
                </button>
              </Show>
              <Show when={t().undo}>
                <button class="link" onClick={undo}>
                  Undo
                </button>
              </Show>
            </>
          )}
        </Show>
        <span class="grow" />
        <Show when={running()?.shown}>
          <span class="meta">
            {running()!.name} running · <kbd>Esc</kbd> stop
          </span>
        </Show>
        <Show when={notesOpen()}>
          <span class="meta keys">
            <span>
              <kbd>Ctrl P</kbd> find
            </span>
            <span>
              <kbd>Ctrl N</kbd> new note
            </span>
            <span>
              <kbd>[[</kbd> link
            </span>
            <span>
              <kbd>Esc</kbd> back
            </span>
          </span>
        </Show>
        <Show
          when={listOpen() || notesOpen()}
          fallback={
            <span class="meta keys">
              <span>
                <kbd>Ctrl K</kbd> commands
              </span>
              <span>
                <kbd>Ctrl L</kbd> drafts
              </span>
              <span>
                <kbd>Ctrl 2</kbd> actions
              </span>
              <span>
                <kbd>Ctrl 3</kbd> notes
              </span>
            </span>
          }
        >
          <Show when={listOpen()}>
          <span class="meta keys">
            <span>
              <kbd>j k</kbd> move
            </span>
            <span>
              <kbd>Enter</kbd> write
            </span>
            <span>
              <kbd>x</kbd> select
            </span>
            <span>
              <kbd>e</kbd> archive
            </span>
            <span>
              <kbd>f</kbd> flag
            </span>
            <span>
              <kbd>z</kbd> undo
            </span>
            <span>
              <kbd>Esc</kbd> back
            </span>
          </span>
          </Show>
        </Show>
        <Show when={info()?.debug}>
          <span class="meta" title={info()?.dbPath}>
            dev
          </span>
        </Show>
      </footer>
    </div>
  );
}
