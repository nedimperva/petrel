// Notes without the engine, for `npm run dev` in a browser: an in-memory folder with a few notes. The real rules
// (files, conflicts, front matter, link rewriting) are in crates/petrel-core/src/notes.rs and its tests; this is
// enough to work on the screens.

import type { BackRef, Draft, Folder, LinkTarget, Note, NoteSummary, NotesApi, UndoToken } from "../api";
import { parseLinks } from "./parse";

interface Env {
  drafts: Map<number, Draft>;
  make(content: string): Draft;
  move(ids: number[], folder: Folder): UndoToken;
  undos: Map<string, () => number>;
}

export function fakeNotes(env: Env): NotesApi {
  const notes = new Map<number, Note>();
  let nextId = 1;
  const hour = 3_600_000;
  const lower = (s: string) => s.trim().toLowerCase();
  const pathOf = (folder: string, title: string) => (folder ? `${folder}/${title}.md` : `${title}.md`);
  const add = (folder: string, title: string, body: string, tags: string[] = [], pinned = false, age = 0): Note => {
    const t = Date.now() - age;
    const n: Note = {
      id: nextId++,
      path: pathOf(folder, title),
      folder,
      title,
      body,
      tags,
      pinned,
      hash: crypto.randomUUID(),
      createdAt: t,
      modifiedAt: t,
      versionCount: 0,
    };
    notes.set(n.id, n);
    return n;
  };
  add("Projects/Petrel", "Petrel roadmap", "M1 closes after the two-week trial.\n\nM2: scripting, workspaces, [[Notes storage]], links between drafts and notes.\n", ["petrel"], true, 2 * hour);
  add("Projects/Petrel", "Notes storage", "Each note is a Markdown file in the folder I pick. Sub-folders are the tree.\n\n## Saving\n\nWrites go to a temp file, then a rename. See [[Petrel roadmap]].\n\n## Edits from outside\n\nIf the file changes on disk while I am typing, Petrel keeps both.\n", ["petrel", "design"], false, 60_000);
  add("Home", "Omarchy setup", "Capture is `bind = SUPER, N, exec, petrel --capture`.\n\n## Keybinds\n\nThe float rule is in [[Hyprland float rule]].\n", [], true, 26 * hour);
  add("Reading", "Reading list", "Books and long reads to get to. One line each.\n", [], true, 7 * 24 * hour);
  add("Journal", "2026-11-06", "Tried the history panel on Windows. Restore works.\n", [], false, hour);

  const summary = (n: Note): NoteSummary => ({
    id: n.id,
    path: n.path,
    folder: n.folder,
    title: n.title,
    preview: n.body.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 160),
    tags: n.tags,
    pinned: n.pinned,
    modifiedAt: n.modifiedAt,
  });
  const get = (id: number) => {
    const n = notes.get(id);
    if (!n) throw new Error(`note ${id} is not in the notes folder`);
    return n;
  };
  const titled = (title: string) =>
    [...notes.values()].filter((n) => lower(n.title) === lower(title)).sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
  const draftTitled = (title: string) =>
    [...env.drafts.values()].find((d) => d.folder !== "trash" && lower(d.title) === lower(title));
  const token = (undo: () => number): UndoToken => {
    const t = `note-${crypto.randomUUID()}`;
    env.undos.set(t, undo);
    return { token: t, count: 1 };
  };
  const unique = (folder: string, title: string) => {
    const base = title.replace(/[/\\:*?"<>|]/g, "-").trim() || "Untitled";
    let name = base;
    for (let i = 2; [...notes.values()].some((n) => n.path === pathOf(folder, name)); i++) name = `${base} ${i}`;
    return name;
  };
  const texts = () => [
    ...[...notes.values()].map((n) => ({ kind: "note" as const, id: n.id, title: n.title, text: n.body })),
    ...[...env.drafts.values()]
      .filter((d) => d.folder !== "trash")
      .map((d) => ({ kind: "draft" as const, id: d.id, title: d.title, text: d.content })),
  ];

  return {
    notesInfo: async () => ({ root: "(memory)" }),
    setNotesRoot: async (root) => ({ added: 0, changed: 0, removed: 0, skipped: 0, root }),
    scanNotes: async () => ({ added: 0, changed: 0, removed: 0, skipped: 0, root: "(memory)" }),
    listNotes: async (q) =>
      [...notes.values()]
        .filter((n) => (q.folder == null || n.folder === q.folder) && (q.pinned == null || n.pinned === q.pinned))
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
        .slice(0, q.limit ?? 100)
        .map(summary),
    findNotes: async (text, limit) =>
      [...notes.values()]
        .filter((n) => !text.trim() || lower(n.path).includes(lower(text)))
        .sort((a, b) => Number(lower(b.title).startsWith(lower(text))) - Number(lower(a.title).startsWith(lower(text))) || b.modifiedAt - a.modifiedAt)
        .slice(0, limit)
        .map(summary),
    searchNotes: async (text, limit) => {
      const words = lower(text).split(/\s+/).filter(Boolean);
      return [...notes.values()]
        .filter((n) => words.length && words.every((w) => lower(n.title + " " + n.body).includes(w)))
        .slice(0, limit)
        .map(summary);
    },
    noteFolders: async () => {
      const all = new Map<string, number>();
      for (const n of notes.values()) {
        if (!n.folder) continue;
        const parts = n.folder.split("/");
        for (let i = 1; i < parts.length; i++) if (!all.has(parts.slice(0, i).join("/"))) all.set(parts.slice(0, i).join("/"), 0);
        all.set(n.folder, (all.get(n.folder) ?? 0) + 1);
      }
      return [...all]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, count]) => ({ path, count, name: path.split("/").at(-1)!, depth: path.split("/").length - 1 }));
    },
    openNote: async (id) => ({ ...get(id) }),
    peekNote: async (id) => ({ ...get(id) }),
    createNote: async (folder, title, body, tags) => ({ ...add(folder, unique(folder, title), body, tags) }),
    saveNote: async (id, body) => {
      const n = get(id);
      Object.assign(n, { body, modifiedAt: Date.now(), hash: crypto.randomUUID() });
      return { hash: n.hash, modifiedAt: n.modifiedAt, conflict: null };
    },
    renameNote: async (id, title) => {
      const n = get(id);
      const old = n.title;
      const name = title.trim();
      if (!name) throw new Error("a note needs a title");
      if (lower(name) !== lower(old) && titled(name)?.folder === n.folder) throw new Error(`there is already a note called “${name}” in that folder`);
      const before = texts().map((t) => ({ ...t }));
      let relinked = 0;
      const swap = (text: string) =>
        text.replace(/\[\[([^\]|#]+)([^\]]*)\]\]/g, (all, target: string, rest: string) => {
          const t = target.split("/").at(-1)!;
          return lower(t) === lower(old) ? `[[${target.slice(0, target.length - t.length)}${name}${rest}]]` : all;
        });
      for (const t of before) {
        const after = swap(t.text);
        if (after === t.text) continue;
        relinked++;
        if (t.kind === "note") get(t.id).body = after;
        else Object.assign(env.drafts.get(t.id)!, { content: after });
      }
      Object.assign(n, { title: name, path: pathOf(n.folder, name) });
      const tok = token(() => {
        Object.assign(n, { title: old, path: pathOf(n.folder, old) });
        for (const t of before) {
          if (t.kind === "note") notes.get(t.id) && (notes.get(t.id)!.body = t.text);
          else if (env.drafts.get(t.id)) env.drafts.get(t.id)!.content = t.text;
        }
        return 1;
      });
      return { note: { ...n }, token: tok, relinked };
    },
    pinNote: async (id, pinned) => ({ ...Object.assign(get(id), { pinned }) }),
    setNoteTags: async (id, tags) => ({ ...Object.assign(get(id), { tags }) }),
    trashNote: async (id) => {
      const n = get(id);
      notes.delete(id);
      return token(() => (notes.set(n.id, n), 1));
    },
    promoteDraft: async (draftId, folder, title, keepTags) => {
      const d = env.drafts.get(draftId);
      if (!d) throw new Error(`draft ${draftId} does not exist`);
      const wanted = title.trim() || d.title || "Untitled";
      const lines = d.content.split("\n");
      const first = lines.findIndex((l) => l.trim());
      const body =
        first >= 0 && lower(lines[first].replace(/^#+\s*/, "")) === lower(wanted)
          ? lines.slice(first + 1).join("\n").replace(/^\n+/, "")
          : d.content;
      const n = add(folder, unique(folder, wanted), body, keepTags ? d.tags : []);
      const moved = env.move([d.id], "archive");
      d.promoted = { notePath: n.path, noteTitle: n.title, noteId: n.id, kind: "promote", at: Date.now() };
      const tok = token(() => {
        notes.delete(n.id);
        d.promoted = null;
        env.undos.get(moved.token)?.();
        return 1;
      });
      return { note: { ...n }, token: tok, relinked: 0 };
    },
    appendToNote: async (draftId, noteId, keepTags) => {
      const d = env.drafts.get(draftId);
      if (!d) throw new Error(`draft ${draftId} does not exist`);
      const n = get(noteId);
      const before = { body: n.body, tags: n.tags };
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const body = n.body.trimEnd();
      n.body = `${body ? `${body}\n\n---\n\n` : ""}_${stamp}_\n\n${d.content.trimEnd()}\n`;
      if (keepTags) n.tags = [...new Set([...n.tags, ...d.tags])];
      n.modifiedAt = Date.now();
      const moved = env.move([d.id], "archive");
      d.promoted = { notePath: n.path, noteTitle: n.title, noteId: n.id, kind: "append", at: Date.now() };
      const tok = token(() => {
        Object.assign(n, before);
        d.promoted = null;
        env.undos.get(moved.token)?.();
        return 1;
      });
      return { note: { ...n }, token: tok, relinked: 0 };
    },
    linkTargets: async (text, limit) => {
      const q = lower(text);
      const ns: LinkTarget[] = [...notes.values()]
        .filter((n) => !q || lower(n.title).includes(q))
        .sort((a, b) => Number(lower(b.title).startsWith(q)) - Number(lower(a.title).startsWith(q)) || b.modifiedAt - a.modifiedAt)
        .slice(0, limit)
        .map((n) => ({ kind: "note", id: n.id, title: n.title, folder: n.folder, uuid: null, modifiedAt: n.modifiedAt }));
      const ds: LinkTarget[] = [...env.drafts.values()]
        .filter((d) => d.folder !== "trash" && d.title && (!q || lower(d.title).split(/\s+/).some((w) => w.startsWith(q.split(/\s+/)[0]))))
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
        .slice(0, limit)
        .map((d) => ({ kind: "draft", id: d.id, title: d.title, folder: d.folder, uuid: d.uuid, modifiedAt: d.modifiedAt }));
      return [...ns, ...ds];
    },
    resolveLink: async (inner) => {
      const raw = inner.split("|")[0].split("#")[0].trim();
      if (raw.startsWith("d:") || raw.startsWith("u:")) {
        const v = raw.slice(2).trim();
        const d = raw.startsWith("u:") ? [...env.drafts.values()].find((x) => x.uuid === v) : draftTitled(v);
        return d ? { kind: "draft", id: d.id } : { kind: "missing", title: v, folder: null, draft: true };
      }
      const title = raw.split("/").at(-1)!.trim();
      const folder = raw.includes("/") ? raw.slice(0, raw.lastIndexOf("/")) : null;
      const n = titled(title);
      if (n) return { kind: "note", id: n.id };
      const d = folder === null ? draftTitled(title) : undefined;
      return d ? { kind: "draft", id: d.id } : { kind: "missing", title, folder, draft: false };
    },
    backlinks: async (id) => {
      const n = get(id);
      const linked: BackRef[] = [];
      const mentioned: BackRef[] = [];
      for (const t of texts()) {
        if (t.kind === "note" && t.id === id) continue;
        const links = parseLinks(t.text);
        const hit = links.find((l) => l.kind === "note" && lower(l.title) === lower(n.title));
        const lineAt = (at: number) => t.text.slice(t.text.lastIndexOf("\n", at - 1) + 1).split("\n")[0].trim();
        if (hit) linked.push({ kind: t.kind, id: t.id, title: t.title, line: lineAt(hit.from) });
        else {
          const at = lower(t.text).indexOf(lower(n.title));
          if (at >= 0) mentioned.push({ kind: t.kind, id: t.id, title: t.title, line: lineAt(at) });
        }
      }
      return { linked, mentioned };
    },
    linkMention: async (noteId, kind, id) => {
      const title = get(noteId).title;
      const re = new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const edit = (text: string) => text.replace(re, (m) => (m === title ? `[[${title}]]` : `[[${title}|${m}]]`));
      if (kind === "note") {
        const n = get(id);
        const before = n.body;
        n.body = edit(n.body);
        return token(() => ((n.body = before), 1));
      }
      const d = env.drafts.get(id)!;
      const before = d.content;
      d.content = edit(d.content);
      return token(() => ((d.content = before), 1));
    },
  };
}
