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

export interface Api {
  appInfo(): Promise<AppInfo>;
  newDraft(content: string): Promise<Draft>;
  openDraft(id: number): Promise<Draft>;
  saveDraft(id: number, content: string, cursor: number): Promise<boolean>;
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
  /** Rejects when the token is unknown (too old, used, or from before a restart). */
  undo(token: string): Promise<number>;
  /** No undo. */
  emptyTrash(): Promise<number>;
  sweep(): Promise<SweepReport>;
  /** Shows the (initially hidden) window once the UI has rendered. No-op outside Tauri. */
  showWindow(): Promise<void>;
}

const inTauri = "__TAURI_INTERNALS__" in window;

async function tauriApi(): Promise<Api> {
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    appInfo: () => invoke("app_info"),
    newDraft: (content) => invoke("new_draft", { content }),
    openDraft: (id) => invoke("open_draft", { id }),
    saveDraft: (id, content, cursor) => invoke("save_draft", { id, content, cursor }),
    listDrafts: (query) => invoke("list_drafts", { query }),
    searchDrafts: (query, limit) => invoke("search_drafts", { query, limit }),
    setTags: (id, tags) => invoke("set_tags", { id, tags }),
    tagCounts: (folder) => invoke("tag_counts", { folder }),
    renameTag: (from, to) => invoke("rename_tag", { from, to }),
    mergeTags: (from, into) => invoke("merge_tags", { from, into }),
    moveDrafts: (ids, folder) => invoke("move_drafts", { ids, folder }),
    flagDrafts: (ids, flagged) => invoke("flag_drafts", { ids, flagged }),
    undo: (token) => invoke("undo", { token }),
    emptyTrash: () => invoke("empty_trash"),
    sweep: () => invoke("sweep"),
    showWindow: () => invoke("show_window"),
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
    saveDraft: async (id, content, cursor) => {
      const d = drafts.get(id);
      if (!d) return false;
      Object.assign(d, { content, cursor, title: title(content), modifiedAt: now() });
      return true;
    },
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
  };
}

export const api: Promise<Api> = inTauri ? tauriApi() : Promise.resolve(fakeApi());
