// The only file that knows whether Petrel runs inside Tauri. Everything else calls these functions.
// Without Tauri (`npm run dev` in a browser) a fake in-memory store with a few drafts stands in, so the UI
// can be worked on without a Rust toolchain.

export type Folder = "inbox" | "archive" | "trash";

export interface Draft {
  id: number;
  uuid: string;
  content: string;
  title: string;
  folder: Folder;
  flagged: boolean;
  syntax: string;
  cursor: number;
  createdAt: number;
  modifiedAt: number;
  accessedAt: number;
  tags: string[];
  versionCount: number;
}

export interface DraftSummary {
  id: number;
  uuid: string;
  title: string;
  preview: string;
  folder: Folder;
  flagged: boolean;
  modifiedAt: number;
}

export type Sort = "modified" | "created" | "accessed" | "title";

/** Keyset cursor; pass back `ListPage.next` unchanged. */
export interface Cursor {
  key: number | string;
  id: number;
  flagged: boolean;
}

export interface ListPage {
  rows: DraftSummary[];
  next: Cursor | null;
}

/** Every field is optional; the engine fills defaults (Inbox, modified, newest first, 50 rows). */
export interface ListQuery {
  /** `null` is Inbox and Archive together. */
  folder?: Folder | null;
  flaggedOnly?: boolean;
  tagsAll?: string[];
  tagsNone?: string[];
  fts?: string;
  sort?: Sort;
  desc?: boolean;
  flaggedTop?: boolean;
  cursor?: Cursor | null;
  limit?: number;
}

export interface SearchHit {
  id: number;
  title: string;
  /** The match is wrapped in U+0001 … U+0002. */
  snippet: string;
  modifiedAt: number;
}

export interface TagCount {
  name: string;
  count: number;
}

export interface UndoToken {
  token: string;
  count: number;
}

export interface SweepReport {
  tombstoned: number;
  purged: number;
  tagsRemoved: number;
  versionsThinned: number;
}

export interface AppInfo {
  version: string;
  dbPath: string;
  debug: boolean;
}

// ---- actions (package 03) ---------------------------------------------------------------------------------

export type AfterSuccess = "nothing" | "archive" | "trash" | "new";

/** A step as the engine reads it: `type` plus that type's fields (docs/design/actions.md, "Built-in steps"). */
export interface Step {
  type: string;
  [field: string]: unknown;
}

export interface Action {
  uuid: string;
  name: string;
  /** Empty for a new action: the engine files it under "Actions". */
  group: string;
  description: string;
  icon: string;
  color: string;
  /** A bare key (`c`, used when the action list has focus) or a chord with Ctrl/Alt (`Ctrl+Alt+J`, anywhere). */
  shortcut: string | null;
  steps: Step[];
  afterSuccess: AfterSuccess;
  addTags: string[];
  confirm: boolean;
  hidden: boolean;
  disabled: boolean;
  /** Read-only: the steps are the ones the person last saw or confirmed. */
  trusted: boolean;
}

/** UTF-16 offsets, as CodeMirror reports them. */
export interface Selection {
  anchor: number;
  head: number;
}

export type RunOutcome =
  | { status: "ok" }
  | { status: "stopped" }
  | { status: "cancelled" }
  | { status: "failed"; step: number; message: string }
  /** The draft was saved while the steps ran: nothing committed, the action's text kept as a version. */
  | { status: "conflict"; message: string };

export interface RunReport {
  runId: number;
  action: string;
  draftId: number;
  outcome: RunOutcome;
  openDraft: number | null;
  newDraft: boolean;
  unknownTags: string[];
  log: string[];
  selection: Selection;
  /** The stored content changed; reload the editor. */
  changed: boolean;
}

export interface RunLogEntry {
  id: number;
  /** Empty if the action was deleted since. */
  action: string;
  actionUuid: string | null;
  draftId: number | null;
  draftTitle: string | null;
  startedAt: number;
  endedAt: number | null;
  status: RunOutcome["status"];
  step: number | null;
  message: string;
  source: string;
}

export type ScopeItem = { kind: "command" | "path"; text: string };

export interface PromptField {
  key: string;
  kind: "text" | "textarea" | "select" | "switch" | "date";
  label: string;
  default: string;
  options: string[];
}

export interface PromptSpec {
  title: string;
  message: string;
  buttons: string[];
  fields: PromptField[];
  cancelButton: boolean;
}

/** Something a running action needs from the person. Answer with `hostReply(id, …)`. */
export type HostRequest =
  | { id: number; kind: "confirm"; payload: { title: string; message: string } }
  | { id: number; kind: "scope"; payload: { action: string; items: ScopeItem[] } }
  | { id: number; kind: "prompt"; payload: PromptSpec }
  | { id: number; kind: "preview"; payload: { html: string; css: string; continueButton: boolean } };

export interface HostEvents {
  request(r: HostRequest): void;
  /** The run was cancelled while the request was up; close it. */
  closed(id: number): void;
  message(kind: "info" | "warning", text: string): void;
}

export interface Api {
  appInfo(): Promise<AppInfo>;
  newDraft(content: string): Promise<Draft>;
  openDraft(id: number): Promise<Draft>;
  /** The draft as `openDraft` returns it, without marking it accessed (the list's preview). */
  peekDraft(id: number): Promise<Draft>;
  saveDraft(id: number, content: string, cursor: number): Promise<boolean>;
  /** The cursor of a draft whose text is saved; not an edit. */
  saveCursor(id: number, cursor: number): Promise<void>;
  /** Writes text the database would not take to a file next to it. Returns the file's path. */
  rescueText(text: string): Promise<string>;
  /** Closes this window (its close button is intercepted until the text is saved). */
  closeWindow(): Promise<void>;
  listDrafts(query: ListQuery): Promise<ListPage>;
  /** The search box: free words plus `tag:x`, `-tag:x`, `is:flagged`, `in:archive`, `"a phrase"`. */
  searchDrafts(query: string, limit: number): Promise<SearchHit[]>;
  setTags(id: number, tags: string[]): Promise<string[]>;
  /** `null`: Inbox and Archive. */
  tagCounts(folder: Folder | null): Promise<TagCount[]>;
  renameTag(from: string, to: string): Promise<number>;
  mergeTags(from: string[], into: string): Promise<number>;
  moveDrafts(ids: number[], folder: Folder): Promise<UndoToken>;
  flagDrafts(ids: number[], flagged: boolean): Promise<UndoToken>;
  /** Adds tags, keeping the ones each draft has. */
  addTags(ids: number[], tags: string[]): Promise<UndoToken>;
  /** Rejects when the token is unknown (too old, used, or from before a restart). */
  undo(token: string): Promise<number>;
  /** No undo. */
  emptyTrash(): Promise<number>;
  sweep(): Promise<SweepReport>;
  /** Shows the (initially hidden) window once the UI has rendered. No-op outside Tauri. */
  showWindow(): Promise<void>;
  /** The capture window is done: close it (and quit if the main window was never shown). */
  closeCapture(): Promise<void>;

  listActions(): Promise<Action[]>;
  /** From the action editor, so the saved steps are trusted. Returns the stored action (uuid, group filled). */
  saveAction(action: Action): Promise<Action>;
  deleteAction(uuid: string): Promise<boolean>;
  actionLog(limit: number): Promise<RunLogEntry[]>;
  /** `key` is a uuid or a name. Rejects when the action or draft is missing or another run is going. */
  runAction(key: string, draftId: number, editor: Selection | null, source: "ui" | "shortcut"): Promise<RunReport>;
  /** Stops the running action. */
  cancelRun(): Promise<boolean>;
  hostReply(id: number, value: unknown): Promise<boolean>;
  listenHost(events: HostEvents): Promise<void>;
  /** The tray and a second launch: `newDraft` (tray "New draft", `petrel --new`) and `quit` (tray "Quit": save,
   * then close this window). No-op outside Tauri. */
  listenApp(events: { newDraft(): void; quit(): void }): Promise<void>;
  /** Opens the capture window, or focuses it. */
  openCapture(): Promise<void>;
  /** A folder from the system picker, or null when cancelled. */
  pickFolder(): Promise<string | null>;
}

const inTauri = "__TAURI_INTERNALS__" in window;

async function tauriApi(): Promise<Api> {
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    appInfo: () => invoke("app_info"),
    newDraft: (content) => invoke("new_draft", { content }),
    openDraft: (id) => invoke("open_draft", { id }),
    peekDraft: (id) => invoke("peek_draft", { id }),
    saveDraft: (id, content, cursor) => invoke("save_draft", { id, content, cursor }),
    saveCursor: (id, cursor) => invoke("save_cursor", { id, cursor }),
    rescueText: (text) => invoke("rescue_text", { text }),
    closeWindow: () => invoke("close_window"),
    listDrafts: (query) => invoke("list_drafts", { query }),
    searchDrafts: (query, limit) => invoke("search_drafts", { query, limit }),
    setTags: (id, tags) => invoke("set_tags", { id, tags }),
    tagCounts: (folder) => invoke("tag_counts", { folder }),
    renameTag: (from, to) => invoke("rename_tag", { from, to }),
    mergeTags: (from, into) => invoke("merge_tags", { from, into }),
    moveDrafts: (ids, folder) => invoke("move_drafts", { ids, folder }),
    flagDrafts: (ids, flagged) => invoke("flag_drafts", { ids, flagged }),
    addTags: (ids, tags) => invoke("add_tags", { ids, tags }),
    undo: (token) => invoke("undo", { token }),
    emptyTrash: () => invoke("empty_trash"),
    sweep: () => invoke("sweep"),
    showWindow: () => invoke("show_window"),
    closeCapture: () => invoke("close_capture"),
    listActions: () => invoke("list_actions"),
    saveAction: (action) => invoke("save_action", { action }),
    deleteAction: (uuid) => invoke("delete_action", { uuid }),
    actionLog: (limit) => invoke("action_log", { limit }),
    runAction: (key, draftId, editor, source) => invoke("run_action", { key, draftId, editor, source }),
    cancelRun: () => invoke("cancel_run"),
    hostReply: (id, value) => invoke("host_reply", { id, value }),
    pickFolder: async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, title: "Choose a folder" });
      return typeof picked === "string" ? picked : null;
    },
    listenApp: async (events) => {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const win = getCurrentWebviewWindow();
      await win.listen("petrel-new", () => events.newDraft());
      await win.listen("petrel-quit", () => events.quit());
    },
    openCapture: () => invoke("open_capture_window"),
    listenHost: async (events) => {
      // This window's events only: a run's dialogs go to the window that started it.
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const win = getCurrentWebviewWindow();
      await win.listen<HostRequest>("host-request", (e) => events.request(e.payload));
      await win.listen<number>("host-closed", (e) => events.closed(e.payload));
      await win.listen<{ kind: "info" | "warning"; text: string }>("host-message", (e) =>
        events.message(e.payload.kind, e.payload.text),
      );
    },
  };
}

function fakeApi(): Api {
  const drafts = new Map<number, Draft>();
  let nextId = 1;
  const now = () => Date.now();
  const title = (c: string) =>
    (c.split("\n").map((l) => l.trim()).find((l) => l) ?? "").replace(/^#+\s*/, "").slice(0, 200);
  const preview = (c: string) => {
    const lines = c.split("\n").map((l) => l.trim());
    const i = lines.findIndex((l) => l);
    return lines.slice(i + 1).join(" ").replace(/\s+/g, " ").trim().slice(0, 160);
  };
  const seed = [
    "# Welcome to Petrel\n\nThis is the fake store: nothing is saved. Run `npm run tauri dev` for the real one.",
    "Groceries\n\n- [ ] milk\n- [ ] eggs\n- [x] bread",
    "Idea: actions should show their rendered command before the first run.",
  ];
  const make = (content: string): Draft => {
    const t = now();
    const d: Draft = {
      id: nextId++,
      uuid: crypto.randomUUID(),
      content,
      title: title(content),
      folder: "inbox",
      flagged: false,
      syntax: "markdown",
      cursor: 0,
      createdAt: t,
      modifiedAt: t,
      accessedAt: t,
      tags: [],
      versionCount: 0,
    };
    drafts.set(d.id, d);
    return d;
  };
  seed.forEach(make);
  // Enough drafts to scroll, page, filter and tag in the list.
  const topics = ["meeting", "garden", "travel", "recipe", "release", "journal"];
  for (let i = 1; i <= 40; i++) {
    const topic = topics[i % topics.length];
    const d = make(`${topic[0].toUpperCase()}${topic.slice(1)} note ${i}\n\nSome words about ${topic} and milk ${i}.`);
    d.tags = i % 3 === 0 ? ["work"] : i % 5 === 0 ? ["home", "idea"] : [];
    d.flagged = i % 7 === 0;
    d.folder = i % 9 === 0 ? "archive" : "inbox";
    d.createdAt = d.modifiedAt = d.accessedAt = Date.now() - i * 3_600_000;
  }
  const summary = (d: Draft): DraftSummary => ({
    id: d.id,
    uuid: d.uuid,
    title: d.title,
    preview: preview(d.content),
    folder: d.folder,
    flagged: d.flagged,
    modifiedAt: d.modifiedAt,
  });
  const undos = new Map<string, () => number>();
  function batch<K extends "folder" | "flagged">(ids: number[], key: K, value: Draft[K]): UndoToken {
    const changed = ids.map((id) => drafts.get(id)).filter((d): d is Draft => !!d && d[key] !== value);
    const before = changed.map((d) => [d, d[key], d.modifiedAt] as const);
    const t = now();
    changed.forEach((d) => Object.assign(d, { [key]: value, modifiedAt: t }));
    const token = crypto.randomUUID();
    undos.set(token, () => {
      before.forEach(([d, old, modified]) => Object.assign(d, { [key]: old, modifiedAt: modified }));
      return before.length;
    });
    return { token, count: changed.length };
  }
  function mergeTags(from: string[], into: string): number {
    const target = into.trim().toLowerCase();
    if (!target) throw new Error("a tag needs a name");
    const names = from.map((t) => t.trim().toLowerCase());
    let n = 0;
    for (const d of drafts.values()) {
      if (!d.tags.some((t) => names.includes(t))) continue;
      n++;
      d.tags = [...new Set(d.tags.map((t) => (names.includes(t) ? target : t)))].sort();
    }
    return n;
  }
  return {
    appInfo: async () => ({ version: "dev", dbPath: "(memory)", debug: true }),
    newDraft: async (content) => make(content),
    openDraft: async (id) => {
      const d = drafts.get(id);
      if (!d) throw new Error(`draft ${id} does not exist`);
      return d;
    },
    peekDraft: async (id) => {
      const d = drafts.get(id);
      if (!d) throw new Error(`draft ${id} does not exist`);
      return { ...d };
    },
    saveDraft: async (id, content, cursor) => {
      const d = drafts.get(id);
      if (!d) return false;
      Object.assign(d, { content, cursor, title: title(content), modifiedAt: now() });
      return true;
    },
    saveCursor: async (id, cursor) => {
      const d = drafts.get(id);
      if (d) d.cursor = cursor;
    },
    rescueText: async (text) => {
      console.warn("rescued:", text);
      return "(the console, in the browser)";
    },
    closeWindow: async () => location.reload(),
    // The fake lists without paging and searches by substring; the real rules live in the engine's tests.
    listDrafts: async (q) => {
      const folders: Folder[] = q.folder === null ? ["inbox", "archive"] : [q.folder ?? "inbox"];
      const words = (q.fts ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const rows = [...drafts.values()]
        .filter((d) => folders.includes(d.folder) && (!q.flaggedOnly || d.flagged))
        .filter((d) => (q.tagsAll ?? []).every((t) => d.tags.includes(t.toLowerCase())))
        .filter((d) => !(q.tagsNone ?? []).some((t) => d.tags.includes(t.toLowerCase())))
        .filter((d) => words.every((w) => d.content.toLowerCase().includes(w)))
        .sort((a, b) => {
          const key = (d: Draft) =>
            ({ modified: d.modifiedAt, created: d.createdAt, accessed: d.accessedAt, title: 0 })[q.sort ?? "modified"];
          const order =
            q.sort === "title" ? a.title.localeCompare(b.title) || a.id - b.id : key(a) - key(b) || a.id - b.id;
          const flagged = q.flaggedTop ? Number(b.flagged) - Number(a.flagged) : 0;
          return flagged || (q.desc === false ? order : -order);
        })
        .slice(0, q.limit ?? 50)
        .map(summary);
      return { rows, next: null };
    },
    searchDrafts: async (query, limit) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      return [...drafts.values()]
        .filter((d) => d.folder !== "trash" && words.every((w) => d.content.toLowerCase().includes(w)))
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
        .slice(0, limit)
        .map((d) => ({ id: d.id, title: d.title, snippet: preview(d.content), modifiedAt: d.modifiedAt }));
    },
    setTags: async (id, tags) => {
      const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
      const d = drafts.get(id);
      if (d) Object.assign(d, { tags: clean, modifiedAt: now() });
      return clean;
    },
    tagCounts: async (folder) => {
      const counts = new Map<string, number>();
      for (const d of drafts.values()) {
        if (folder === null ? d.folder === "trash" : d.folder !== folder) continue;
        for (const t of d.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count }));
    },
    renameTag: async (from, to) => mergeTags([from], to),
    mergeTags: async (from, into) => mergeTags(from, into),
    moveDrafts: async (ids, folder) => batch(ids, "folder", folder),
    flagDrafts: async (ids, flagged) => batch(ids, "flagged", flagged),
    addTags: async (ids, tags) => {
      const clean = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
      const changed = ids
        .map((id) => drafts.get(id))
        .filter((d): d is Draft => !!d && clean.some((t) => !d.tags.includes(t)));
      const before = changed.map((d) => [d, d.tags, d.modifiedAt] as const);
      const t = now();
      changed.forEach((d) => Object.assign(d, { tags: [...new Set([...d.tags, ...clean])].sort(), modifiedAt: t }));
      const token = crypto.randomUUID();
      undos.set(token, () => {
        before.forEach(([d, tags, modified]) => Object.assign(d, { tags, modifiedAt: modified }));
        return before.length;
      });
      return { token, count: changed.length };
    },
    undo: async (token) => {
      const restore = undos.get(token);
      if (!restore) throw new Error("nothing to undo: that change is too old or was already undone");
      undos.delete(token);
      return restore();
    },
    emptyTrash: async () => {
      const trashed = [...drafts.values()].filter((d) => d.folder === "trash");
      trashed.forEach((d) => drafts.delete(d.id));
      return trashed.length;
    },
    sweep: async () => ({ tombstoned: 0, purged: 0, tagsRemoved: 0, versionsThinned: 0 }),
    showWindow: async () => {},
    // A browser tab cannot close itself; a fresh capture is the nearest thing.
    closeCapture: async () => location.reload(),
    ...fakeActions((id) => drafts.get(id)),
  };
}

/** Actions without the engine: a few step types are acted out, the rest are logged. Enough to work on the list,
 *  the editor, the dialogs and the log in a browser. */
function fakeActions(draft: (id: number) => Draft | undefined) {
  const base = { description: "", hidden: false, disabled: false, confirm: false, addTags: [], afterSuccess: "nothing" as const };
  const make = (name: string, icon: string, color: string, steps: Step[], more: Partial<Action> = {}): Action => ({
    ...base,
    uuid: crypto.randomUUID(),
    name,
    group: "Basics",
    icon,
    color,
    shortcut: null,
    steps,
    trusted: true,
    ...more,
  });
  const actions: Action[] = [
    make("Copy to clipboard", "copy", "blue", [{ type: "clipboard", text: "[[draft]]", mode: "replace" }], { shortcut: "c", description: "Copies the whole draft." }),
    make("Save to file", "save", "green", [{ type: "file", path: "~/Documents/Petrel/[[safe_title]].md", text: "[[draft]]", mode: "overwrite", createDirs: true }], { description: "Saves the draft as a Markdown file named after its title in ~/Documents/Petrel." }),
    make("Search the web", "search", "teal", [{ type: "url", url: "https://duckduckgo.com/?q=[[selection]]", encode: true, openIn: "default" }]),
    make("Ask then append", "edit", "purple", [
      { type: "prompt", title: "Append", message: "What should go at the end?", buttons: ["Append"], fields: [{ key: "text", kind: "text", label: "Text", default: "", options: [] }], cancelButton: true },
      { type: "insertText", text: "\n[[prompt_text]]", position: "end", moveCursor: false },
    ], { group: "Writing", afterSuccess: "nothing" }),
    make("Preview", "eye", "grey", [{ type: "htmlPreview", template: "[[draft]]", html: false, css: null, continueButton: false }], { group: "Writing" }),
    make("Word count (untrusted)", "terminal", "orange", [{ type: "runCommand", command: "wc -w", stdin: "[[draft]]", shell: null, timeoutSecs: null, output: "ignore", cwd: null }], { group: "Writing", trusted: false }),
    make("Fails", "x", "red", [{ type: "runCommand", command: "false", stdin: "", shell: null, timeoutSecs: null, output: "ignore", cwd: null }], { group: "Writing" }),
  ];
  const log: RunLogEntry[] = [];
  let events: HostEvents | null = null;
  let nextRequest = 1;
  const waiting = new Map<number, (v: unknown) => void>();
  let cancel: (() => void) | null = null;
  function ask(kind: HostRequest["kind"], payload: unknown): Promise<unknown> {
    const id = nextRequest++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      events?.request({ id, kind, payload } as HostRequest);
    });
  }
  const escape = (t: string) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  async function run(key: string, draftId: number, editor: Selection | null, source: string): Promise<RunReport> {
    const a = actions.find((x) => x.uuid === key || x.name.toLowerCase() === key.toLowerCase());
    const d = draft(draftId);
    if (!a) throw new Error(`there is no action named ${key}`);
    if (!d) throw new Error(`draft ${draftId} does not exist`);
    if (cancel) throw new Error("another action is running");
    let cancelled = false;
    cancel = () => {
      cancelled = true;
      waiting.forEach((_, id) => events?.closed(id));
      waiting.forEach((resolve) => resolve(null));
      waiting.clear();
    };
    const tags: Record<string, string> = {};
    let content = d.content;
    let outcome: RunOutcome = { status: "ok" };
    const lines: string[] = [];
    const render = (t: string) =>
      t.replace(/\[\[(\w+)\]\]/g, (m, k: string) => (k === "draft" ? content : k === "title" ? d.title : k === "safe_title" ? d.title.replace(/[\/\\:*?"<>|]/g, "-") : (tags[k] ?? m)));
    try {
      if (!a.trusted) {
        const items = a.steps.filter((s) => s.type === "runCommand").map((s) => ({ kind: "command" as const, text: render(String(s.command)) }));
        if (items.length && !(await ask("scope", { action: a.name, items }))) {
          outcome = { status: "cancelled" };
        } else a.trusted = true;
      }
      for (const [i, s] of a.steps.entries()) {
        if (outcome.status !== "ok") break;
        if (cancelled) {
          outcome = { status: "cancelled" };
          break;
        }
        if (s.type === "clipboard") {
          await navigator.clipboard?.writeText(render(String(s.text))).catch(() => {});
        } else if (s.type === "prompt") {
          const reply = (await ask("prompt", s)) as { button: string; values: Record<string, string> } | null;
          if (!reply) outcome = cancelled ? { status: "cancelled" } : { status: "stopped" };
          else {
            tags.prompt_button = reply.button;
            Object.entries(reply.values).forEach(([k, v]) => (tags[`prompt_${k}`] = v));
          }
        } else if (s.type === "insertText") {
          const t = render(String(s.text));
          content = s.position === "start" ? t + content : content + t;
        } else if (s.type === "htmlPreview") {
          const html = `<pre style="white-space:pre-wrap;font:14px/1.5 system-ui">${escape(render(String(s.template)))}</pre>`;
          if (!(await ask("preview", { html, css: "", continueButton: s.continueButton }))) outcome = { status: "stopped" };
        } else if (s.type === "runCommand") {
          await new Promise((r) => setTimeout(r, 400));
          if (String(s.command) === "false") outcome = { status: "failed", step: i + 1, message: "exited with 1" };
          else lines.push(`ran ${render(String(s.command))}`);
        } else {
          lines.push(`(fake store) ${s.type} skipped`);
        }
        if (cancelled) outcome = { status: "cancelled" };
      }
    } finally {
      cancel = null;
    }
    const changed = outcome.status === "ok" && content !== d.content;
    if (changed) Object.assign(d, { content, modifiedAt: Date.now() });
    if (outcome.status === "ok" && a.afterSuccess === "archive") d.folder = "archive";
    if (outcome.status === "ok" && a.afterSuccess === "trash") d.folder = "trash";
    const t = Date.now();
    log.unshift({
      id: log.length + 1,
      action: a.name,
      actionUuid: a.uuid,
      draftId,
      draftTitle: d.title,
      startedAt: t,
      endedAt: t,
      status: outcome.status,
      step: outcome.status === "failed" ? outcome.step : null,
      message: outcome.status === "failed" ? outcome.message : lines.join("\n"),
      source,
    });
    const end = editor?.head ?? 0;
    return {
      runId: log.length,
      action: a.name,
      draftId,
      outcome,
      openDraft: null,
      newDraft: outcome.status === "ok" && a.afterSuccess === "new",
      unknownTags: [],
      log: lines,
      selection: { anchor: end, head: end },
      changed,
    };
  }
  return {
    listActions: async () => actions.filter((a) => a.uuid).map((a) => ({ ...a, group: a.group || "Actions" })),
    saveAction: async (a: Action) => {
      const saved = { ...a, uuid: a.uuid || crypto.randomUUID(), group: a.group.trim() || "Actions", trusted: true };
      const i = actions.findIndex((x) => x.uuid === saved.uuid);
      if (actions.some((x) => x.uuid !== saved.uuid && x.name.toLowerCase() === saved.name.toLowerCase()))
        throw new Error(`an action named ${saved.name} exists`);
      if (i >= 0) actions[i] = saved;
      else actions.push(saved);
      return saved;
    },
    deleteAction: async (uuid: string) => {
      const i = actions.findIndex((x) => x.uuid === uuid);
      if (i >= 0) actions.splice(i, 1);
      return i >= 0;
    },
    actionLog: async (limit: number) => log.slice(0, limit),
    runAction: run,
    cancelRun: async () => {
      if (!cancel) return false;
      cancel();
      return true;
    },
    hostReply: async (id: number, value: unknown) => {
      const resolve = waiting.get(id);
      waiting.delete(id);
      resolve?.(value);
      return !!resolve;
    },
    listenHost: async (e: HostEvents) => {
      events = e;
    },
    listenApp: async () => {},
    openCapture: async () => {
      window.open("?capture", "_blank");
    },
    pickFolder: async () => "/home/you/Notes",
  };
}

export const api: Promise<Api> = inTauri ? tauriApi() : Promise.resolve(fakeApi());
