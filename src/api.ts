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

export interface ListPage {
  rows: DraftSummary[];
  next: { key: number; id: number } | null;
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
  listDrafts(folder: Folder, cursor: ListPage["next"], limit: number): Promise<ListPage>;
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
    listDrafts: (folder, cursor, limit) => invoke("list_drafts", { folder, cursor, limit }),
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
    listDrafts: async (folder, _cursor, limit) => {
      const rows = [...drafts.values()]
        .filter((d) => d.folder === folder)
        .sort((a, b) => b.modifiedAt - a.modifiedAt || b.id - a.id)
        .slice(0, limit)
        .map((d) => ({
          id: d.id,
          uuid: d.uuid,
          title: d.title,
          preview: preview(d.content),
          folder: d.folder,
          flagged: d.flagged,
          modifiedAt: d.modifiedAt,
        }));
      return { rows, next: null };
    },
    showWindow: async () => {},
  };
}

export const api: Promise<Api> = inTauri ? tauriApi() : Promise.resolve(fakeApi());
