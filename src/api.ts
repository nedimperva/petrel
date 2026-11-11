// What the UI may ask of the shell (src-tauri/src/commands.rs, notes.rs, ai.rs). In a browser (`npm run dev`)
// a fake store in fake.ts stands in, so the screens can be worked on without the engine.

export interface UndoToken {
  token: string;
  count: number;
}

export interface AppInfo {
  version: string;
  dbPath: string;
  debug: boolean;
}

export interface Note {
  id: number;
  /** Relative to the notes folder, `/` between parts. */
  path: string;
  /** `""` for the top of the notes folder. */
  folder: string;
  title: string;
  /** The text without front matter. */
  body: string;
  tags: string[];
  pinned: boolean;
  /** Pass back to `saveNote` so edits made in another app are kept, not overwritten. */
  hash: string;
  createdAt: number;
  modifiedAt: number;
  versionCount: number;
}

export interface NoteSummary {
  id: number;
  path: string;
  folder: string;
  title: string;
  preview: string;
  tags: string[];
  pinned: boolean;
  modifiedAt: number;
}

export interface NoteFolder {
  path: string;
  name: string;
  depth: number;
  count: number;
}

export interface SavedNote {
  hash: string;
  modifiedAt: number;
  /** The file had changed on disk: the other text was kept at this path. */
  conflict: string | null;
}

export interface ScanReport {
  added: number;
  changed: number;
  removed: number;
  skipped: number;
  root: string;
  /** The notes added, changed or gone. */
  paths: string[];
}

export interface NoteChange {
  note: Note;
  token: UndoToken;
  relinked: number;
}

export interface LinkTarget {
  kind: "note" | "draft";
  id: number;
  title: string;
  folder: string;
  uuid: string | null;
  modifiedAt: number;
}

export type Resolved =
  | { kind: "note"; id: number }
  | { kind: "draft"; id: number }
  | { kind: "missing"; title: string; folder: string | null; draft: boolean };

export interface BackRef {
  kind: "note" | "draft";
  id: number;
  title: string;
  line: string;
}

export interface Backlinks {
  linked: BackRef[];
  mentioned: BackRef[];
}

export interface NoteQuery {
  folder?: string | null;
  pinned?: boolean | null;
  limit?: number;
}

export interface NoteVersion {
  id: number;
  /** `edit`, `ai`, `restore`, `merge`. */
  reason: string;
  createdAt: number;
  length: number;
}

export interface DesktopSettings {
  hotkey: string | null;
  hotkeyDefault: string;
  hotkeyActive: boolean;
  hotkeyPaused: boolean;
  hotkeyError: string | null;
  pickerHotkey: string | null;
  pickerHotkeyDefault: string;
  pickerHotkeyActive: boolean;
  pickerHotkeyError: string | null;
  /** False on Wayland: the compositor binds keys there. */
  hotkeySupported: boolean;
  autostart: boolean;
  autostartError: string | null;
}

export interface AiStatus {
  ready: boolean;
  model: string;
  error: string | null;
}

export type AiTask =
  | "tidy"
  | "shorten"
  | "list"
  | "checklist"
  | "custom"
  | "explain"
  | "continue"
  | "summarize"
  | "title"
  | "prompt";

export interface AiSource {
  id: number;
  title: string;
  folder: string;
  preview: string;
}

export interface AiAnswer {
  answer: string;
  sources: AiSource[];
  /** Every note the answer was given from: a follow-up asks the same ones. */
  read: number[];
}

/** One question and its answer, sent back with a follow-up. */
export interface AiExchange {
  question: string;
  answer: string;
}

/** An unticked `- [ ]` in a note. `line` is its line in the file, from 0. */
export interface OpenTask {
  noteId: number;
  title: string;
  folder: string;
  modifiedAt: number;
  line: number;
  text: string;
}

/** A note with a conflict copy beside it (`Title (conflict …)`). */
export interface Conflict {
  original: number;
  copy: number;
  title: string;
  folder: string;
  copiedAt: number;
}

export interface AiSuggestion {
  kind: "merge" | "move";
  noteId: number | null;
  folder: string;
  title: string;
  why: string;
}

export interface AiRelated {
  id: number;
  title: string;
  folder: string;
  why: string;
}

/** What was selected when the capture key was pressed, and the window it was in. */
export interface CaptureContext {
  text: string | null;
  app: string | null;
  title: string | null;
  /** The page's address, when it was a browser. */
  link: string | null;
}

/** A collection's look in the library: colour and mark names from `src/library/faces.ts`; empty is the default. */
export interface TopicFace {
  color: string;
  mark: string;
  /** `yes` things to copy, `no` pages, `""` by its name (library/faces.ts `toCopy`). */
  copy?: string;
}

export interface AppEvents {
  /** Tray "Quit": save, then close this window. */
  quit(): void;
  /** The picker's "Open in Petrel". */
  openNote(id: number): void;
  /** A capture was made in its window: lists are out of date. */
  changed(): void;
  /** The window came back to the front: the folder may have changed (Drive, another app). */
  focus(): void;
  /** The file watcher saw notes change in the folder and read them again. */
  folder?(report: ScanReport): void;
}

export interface Api {
  appInfo(): Promise<AppInfo>;
  rescueText(text: string): Promise<string>;
  closeWindow(): Promise<void>;
  showWindow(): Promise<void>;
  closeCapture(): Promise<void>;
  openCapture(): Promise<void>;
  openPicker(): Promise<void>;
  closePicker(): Promise<void>;
  showNoteInMain(id: number): Promise<void>;
  /** `html`: also as rich text, from the Markdown. */
  copyText(text: string, html: boolean): Promise<void>;
  desktopSettings(): Promise<DesktopSettings>;
  uiSettings(): Promise<Record<string, string>>;
  setUiSetting(key: string, value: string): Promise<void>;
  setHotkey(which: "capture" | "picker", hotkey: string | null): Promise<DesktopSettings>;
  setAutostart(on: boolean): Promise<DesktopSettings>;
  pickFolder(): Promise<string | null>;
  listen(events: AppEvents): Promise<void>;

  notesInfo(): Promise<{ root: string }>;
  setNotesRoot(root: string): Promise<ScanReport>;
  scanNotes(): Promise<ScanReport>;
  listNotes(query: NoteQuery): Promise<NoteSummary[]>;
  /** By title. */
  findNotes(text: string, limit: number): Promise<NoteSummary[]>;
  /** By the words in the text. */
  searchNotes(text: string, limit: number): Promise<NoteSummary[]>;
  noteFolders(): Promise<NoteFolder[]>;
  openNote(id: number): Promise<Note>;
  peekNote(id: number): Promise<Note>;
  createNote(folder: string, title: string, body: string, tags: string[]): Promise<Note>;
  captureNote(body: string): Promise<Note>;
  saveNote(id: number, body: string, baseHash: string): Promise<SavedNote>;
  renameNote(id: number, title: string): Promise<NoteChange>;
  moveNote(id: number, folder: string, title: string): Promise<NoteChange>;
  mergeNote(from: number, into: number): Promise<NoteChange>;
  pinNote(id: number, pinned: boolean): Promise<Note>;
  setNoteTags(id: number, tags: string[]): Promise<Note>;
  trashNote(id: number): Promise<UndoToken>;
  undo(token: string): Promise<number>;
  noteVersions(id: number): Promise<NoteVersion[]>;
  noteVersionText(versionId: number): Promise<string>;
  restoreNoteVersion(id: number, versionId: number): Promise<Note>;
  /** `app`: the app in front of the picker, so it can offer what is used there first. */
  recordCopy(id: number, app?: string | null): Promise<number>;
  copyCounts(): Promise<Record<string, number>>;
  copyCountsIn(app: string): Promise<Record<string, number>>;
  /** The app in front when the picker opened, and what was selected there. Once per picker. */
  pickerContext(): Promise<CaptureContext>;
  readClipboard(): Promise<string>;
  openTasks(): Promise<OpenTask[]>;
  tickTask(id: number, line: number, text: string): Promise<UndoToken>;
  conflicts(): Promise<Conflict[]>;
  /** `left` keeps the note, `right` the copy's text, `both` renames the copy. */
  settleConflict(original: number, copy: number, keep: "left" | "right" | "both"): Promise<UndoToken>;
  linkTargets(text: string, limit: number): Promise<LinkTarget[]>;
  resolveLink(inner: string): Promise<Resolved>;
  backlinks(id: number): Promise<Backlinks>;

  /** A day's page (`YYYY-MM-DD`), or null when the day has none yet. */
  dayNote(date: string): Promise<Note | null>;
  /** Files a capture onto a day's page under the time, making the page if needed. */
  fileIntoDay(id: number, date: string): Promise<NoteChange>;
  /** Notes changed between two moments (ms), with their text. */
  notesBetween(from: number, to: number): Promise<Note[]>;
  /** Ids of the notes with a `[[link]]`, a picture or an open task. */
  notesHaving(what: "link" | "picture" | "task"): Promise<number[]>;
  topicFaces(): Promise<Record<string, TopicFace>>;
  setTopicFace(top: string, face: TopicFace): Promise<TopicFace>;
  /** Writes a pasted picture next to notes in `folder`; returns the link (`attachments/<name>`). */
  saveAttachment(folder: string, name: string, bytes: Uint8Array): Promise<string>;
  /** A picture's bytes, for a note in `folder` linking `link`. */
  attachment(folder: string, link: string): Promise<Uint8Array>;
  /** Once per capture window. */
  captureContext(): Promise<CaptureContext>;

  aiStatus(): Promise<AiStatus>;
  setAiKey(key: string | null): Promise<AiStatus>;
  aiWrite(o: {
    task: AiTask;
    text: string;
    context?: string;
    instruction?: string;
    noteId?: number;
  }): Promise<string>;
  /** With `earlier` and `notes`, a follow-up: the same notes, the talk so far. */
  aiAsk(question: string, earlier?: AiExchange[], notes?: number[]): Promise<AiAnswer>;
  aiSuggestHome(noteId: number): Promise<AiSuggestion[]>;
  aiRelated(noteId: number): Promise<AiRelated[]>;
  /** A few sentences on the notes changed between two moments. */
  aiWeek(from: number, to: number): Promise<string>;
}

export const inTauri = "__TAURI_INTERNALS__" in window;

async function tauriApi(): Promise<Api> {
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    appInfo: () => invoke("app_info"),
    rescueText: (text) => invoke("rescue_text", { text }),
    closeWindow: () => invoke("close_window"),
    showWindow: () => invoke("show_window"),
    closeCapture: () => invoke("close_capture"),
    openCapture: () => invoke("open_capture_window"),
    openPicker: () => invoke("open_picker_window"),
    closePicker: () => invoke("close_picker"),
    showNoteInMain: (id) => invoke("show_note_in_main", { id }),
    copyText: (text, html) => invoke("copy_text", { text, html }),
    desktopSettings: () => invoke("desktop_settings"),
    uiSettings: () => invoke("ui_settings"),
    setUiSetting: (key, value) => invoke("set_ui_setting", { key, value }),
    setHotkey: (which, hotkey) => invoke("set_hotkey", { which, hotkey }),
    setAutostart: (on) => invoke("set_autostart", { on }),
    pickFolder: async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, title: "Choose the Petrel folder" });
      return typeof picked === "string" ? picked : null;
    },
    listen: async (events) => {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const win = getCurrentWebviewWindow();
      await win.listen("petrel-quit", () => events.quit());
      await win.listen<number>("petrel-open-note", (e) => events.openNote(e.payload));
      await win.listen("petrel-changed", () => events.changed());
      await win.onFocusChanged(({ payload }) => payload && events.focus());
      if (events.folder) await win.listen<ScanReport>("petrel-folder", (e) => events.folder!(e.payload));
    },

    notesInfo: () => invoke("notes_info"),
    setNotesRoot: (root) => invoke("set_notes_root", { root }),
    scanNotes: () => invoke("scan_notes"),
    listNotes: (query) => invoke("list_notes", { query }),
    findNotes: (text, limit) => invoke("find_notes", { text, limit }),
    searchNotes: (text, limit) => invoke("search_notes", { text, limit }),
    noteFolders: () => invoke("note_folders"),
    openNote: (id) => invoke("open_note", { id }),
    peekNote: (id) => invoke("peek_note", { id }),
    createNote: (folder, title, body, tags) => invoke("create_note", { folder, title, body, tags }),
    captureNote: (body) => invoke("capture_note", { body }),
    saveNote: (id, body, baseHash) => invoke("save_note", { id, body, baseHash }),
    renameNote: (id, title) => invoke("rename_note", { id, title }),
    moveNote: (id, folder, title) => invoke("move_note", { id, folder, title }),
    mergeNote: (from, into) => invoke("merge_note", { from, into }),
    pinNote: (id, pinned) => invoke("pin_note", { id, pinned }),
    setNoteTags: (id, tags) => invoke("set_note_tags", { id, tags }),
    trashNote: (id) => invoke("trash_note", { id }),
    undo: (token) => invoke("undo_note", { token }),
    noteVersions: (id) => invoke("note_versions", { id }),
    noteVersionText: (versionId) => invoke("note_version_text", { versionId }),
    restoreNoteVersion: (id, versionId) => invoke("restore_note_version", { id, versionId }),
    recordCopy: (id, app) => invoke("record_copy", { id, app: app ?? null }),
    copyCounts: () => invoke("copy_counts"),
    copyCountsIn: (app) => invoke("copy_counts_in", { app }),
    pickerContext: () => invoke("picker_context"),
    readClipboard: () => invoke("read_clipboard"),
    openTasks: () => invoke("open_tasks"),
    tickTask: (id, line, text) => invoke("tick_task", { id, line, text }),
    conflicts: () => invoke("conflicts"),
    settleConflict: (original, copy, keep) => invoke("settle_conflict", { original, copy, keep }),
    linkTargets: (text, limit) => invoke("link_targets", { text, limit }),
    resolveLink: (inner) => invoke("resolve_link", { inner }),
    backlinks: (id) => invoke("backlinks", { id }),

    dayNote: (date) => invoke("day_note", { date }),
    fileIntoDay: (id, date) => invoke("file_into_day", { id, date }),
    notesBetween: (from, to) => invoke("notes_between", { from, to }),
    notesHaving: (what) => invoke("notes_having", { what }),
    topicFaces: () => invoke("topic_faces"),
    setTopicFace: (top, face) => invoke("set_topic_face", { top, color: face.color, mark: face.mark, copy: face.copy ?? "" }),
    saveAttachment: (folder, name, bytes) =>
      invoke("save_attachment", bytes, {
        headers: { "x-petrel-folder": encodeURIComponent(folder), "x-petrel-name": encodeURIComponent(name) },
      }),
    attachment: async (folder, link) => new Uint8Array(await invoke<ArrayBuffer>("attachment", { folder, link })),
    captureContext: () => invoke("capture_context"),

    aiStatus: () => invoke("ai_status"),
    setAiKey: (key) => invoke("set_ai_key", { key }),
    aiWrite: (o) => invoke("ai_write", { ...o }),
    aiAsk: (question, earlier, notes) => invoke("ai_ask", { question, earlier: earlier ?? null, notes: notes ?? null }),
    aiSuggestHome: (noteId) => invoke("ai_suggest_home", { noteId }),
    aiRelated: (noteId) => invoke("ai_related", { noteId }),
    aiWeek: (from, to) => invoke("ai_week", { from, to }),
  };
}

let cached: Promise<Api> | undefined;

export function api(): Promise<Api> {
  cached ??= inTauri ? tauriApi() : import("./fake").then((m) => m.fakeApi());
  return cached;
}

/** The message of a rejected call, without the `Error: ` the bridge adds. */
export function errText(e: unknown): string {
  return String(e).replace(/^Error: /, "");
}
