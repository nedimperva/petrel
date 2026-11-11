// The store without the engine, for `npm run dev` in a browser: an in-memory folder with a few notes, captures
// and collections, and an AI that answers from a script. The real rules (files, conflicts, front matter, links)
// are in crates/petrel-core/src/notes.rs and its tests; this is enough to work on the screens.

import type { AiSuggestion, Api, Note, NoteSummary, NoteVersion, TopicFace, UndoToken } from "./api";
import { parseLinks } from "./notes/parse";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function fakeApi(): Api {
  const notes = new Map<number, Note>();
  const versions = new Map<number, { v: NoteVersion; text: string; note: number }>();
  const undos = new Map<string, () => void>();
  const copies: Record<string, number> = {};
  let nextId = 1;
  let nextVersion = 1;
  let aiKey: string | null = "fake";
  const desktop = {
    hotkey: "Ctrl+Alt+Space" as string | null,
    hotkeyDefault: "Ctrl+Alt+Space",
    hotkeyActive: true,
    hotkeyPaused: false,
    hotkeyError: null,
    pickerHotkey: "Ctrl+Alt+V" as string | null,
    pickerHotkeyDefault: "Ctrl+Alt+V",
    pickerHotkeyActive: true,
    pickerHotkeyError: null,
    hotkeySupported: true,
    autostart: false,
    autostartError: null,
  };
  const lower = (s: string) => s.trim().toLowerCase();
  const pathOf = (folder: string, title: string) => (folder ? `${folder}/${title}.md` : `${title}.md`);
  const wait = <T>(v: T, ms = 0) => new Promise<T>((r) => setTimeout(() => r(v), ms));

  const add = (folder: string, title: string, body: string, tags: string[] = [], age = 0, pinned = false): Note => {
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

  function dayOf(age: number) {
    const d = new Date(Date.now() - age);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  const stamp = (age: number) => {
    const d = new Date(Date.now() - age);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  add("inbox", stamp(12 * MIN), "Ask Amra if the Tern release can move to the 20th, the AUR package still needs the new icon.", [], 12 * MIN);
  add("inbox", stamp(2 * HOUR), "Book idea: a field guide to seabirds of the Adriatic, one bird per page, drawn in ink.", [], 2 * HOUR);
  add("inbox", stamp(DAY), "Call the bank about the card before Friday", [], DAY);

  add("", "Tern release", "The Linux beta is out. Next is the Windows build.\n\n## Open questions\n\n- Do we ship the AUR package the same day?\n- [[Petrel ideas]] has the icon notes.\n", ["tern"], 3 * HOUR, true);
  add("", "Petrel ideas", "Petrel should feel like paper: one folder of Markdown, synced by Drive.\n\nCapture first, file later. AI only when I ask.\n\nSee [[Tern release]] for the shared release checklist.\n", ["petrel"], 5 * HOUR);
  add("", "Reading list", "- *The Peregrine*, J. A. Baker\n- *H is for Hawk*\n- *The Seabird's Cry*, Adam Nicolson\n", ["books"], 2 * DAY);
  add("", "Garden", "Tomatoes need full sun and deep water twice a week. Basil next to them keeps the pests away.\n\nPlant garlic in October.\n", [], 6 * DAY);
  add("", "Week plan", "## Monday\n\n- [x] Tern changelog\n- [ ] Petrel inbox screen\n\n## Tuesday\n\n- [ ] Dentist 14:00\n", [], 30 * MIN);

  add("Prompts", "Code review", "Review this {{language}} code for bugs, unclear names and missing tests. Be direct and list the worst problem first.\n\n{{code}}\n", ["ai"], 4 * DAY);
  add("Prompts", "Explain like a colleague", "Explain {{topic}} to me as a senior colleague would over coffee: the idea first, then one example, then the trap people fall into.\n", ["ai"], 9 * DAY);
  add("Prompts", "Release notes", "Write release notes for {{product}} {{version}} from these commits. Group them as New, Fixed and Changed. Plain words, no marketing.\n\n{{commits}}\n", ["ai"], 12 * DAY);
  add("Prompts", "Translate to Bosnian", "Translate this into natural Bosnian, keeping the tone:\n\n{{text}}\n", ["ai"], 20 * DAY);
  add("Snippets", "Email sign-off", "Thanks, and talk soon,\nNedim\n", [], 30 * DAY);
  add("Snippets", "Meeting link", "Here is the link for {{day}}: https://meet.example.com/{{room}}\n", [], 14 * DAY);
  add("Snippets", "git undo last commit", "git reset --soft HEAD~1\n", ["git"], 40 * DAY);
  add("Songs", "Kad ja pođoh", "Capo 2\n\nAm        Dm\nKad ja pođoh na Bembašu\nE7            Am\nna Bembašu na vodu\n", [], 60 * DAY);
  add("Songs", "Wish you were here", "Intro: Em G Em G Em A Em A G\n\nC         D/F#\nSo, so you think you can tell\n", [], 90 * DAY);
  add("journal", dayOf(DAY), "08:40 Slow start. First cold morning, coffee on the balcony.\n\n17:05\n- [x] Call the dentist\n- [ ] Send the Mostar dates to Lejla\n", [], DAY);
  add("journal", dayOf(0), "08:12 Want to finish the shelf plan this week.\n", [], 40 * MIN);
  const faces: Record<string, TopicFace> = { Prompts: { color: "plum", mark: "spark" }, Songs: { color: "rose", mark: "music" } };
  const pictures = new Map<string, Uint8Array>();
  copies["Prompts/Code review.md"] = 14;
  copies["Prompts/Release notes.md"] = 6;
  copies["Snippets/Email sign-off.md"] = 22;

  const summary = (n: Note): NoteSummary => ({
    id: n.id,
    path: n.path,
    folder: n.folder,
    title: n.title,
    // As the engine makes it (notes.rs body_preview): lines kept, list and heading marks made plain.
    preview: n.body
      .split("\n")
      .map((l) => l.trim().replace(/^#+\s*/, "").replace(/^[-*] \[ \] /, "☐ ").replace(/^[-*] \[[xX]\] /, "☑ ").replace(/^[-*] /, "• "))
      .filter(Boolean)
      .slice(0, 6)
      .join("\n")
      .slice(0, 280),
    tags: n.tags,
    pinned: n.pinned,
    modifiedAt: n.modifiedAt,
  });
  const newest = (a: Note, b: Note) => Number(b.pinned) - Number(a.pinned) || b.modifiedAt - a.modifiedAt;
  const get = (id: number) => {
    const n = notes.get(id);
    if (!n) throw new Error(`note ${id} is not in the notes folder`);
    return n;
  };
  const freeTitle = (folder: string, title: string, except?: number) => {
    let name = title;
    let i = 2;
    while ([...notes.values()].some((n) => n.id !== except && n.path === pathOf(folder, name))) name = `${title} ${i++}`;
    return name;
  };
  const snapshot = (n: Note, reason: string) => {
    if (!n.body) return;
    const v = { id: nextVersion++, reason, createdAt: Date.now(), length: n.body.length };
    versions.set(v.id, { v, text: n.body, note: n.id });
    n.versionCount++;
  };
  const token = (undo: () => void): UndoToken => {
    const t = `note-${crypto.randomUUID()}`;
    undos.set(t, undo);
    return { token: t, count: 1 };
  };
  const words = (s: string) => lower(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  const about = (q: string, limit: number) => {
    const ws = words(q);
    return [...notes.values()]
      .map((n) => ({ n, s: ws.filter((w) => lower(n.title + " " + n.body).includes(w)).length }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.n);
  };

  return {
    appInfo: () => wait({ version: "dev", dbPath: "(browser, nothing saved)", debug: true }),
    rescueText: () => wait("(nowhere)"),
    closeWindow: () => wait(undefined),
    showWindow: () => wait(undefined),
    closeCapture: () => wait(undefined).then(() => console.info("capture closed")),
    openCapture: () => wait(undefined).then(() => void window.open("/?capture", "_blank", "width=560,height=320")),
    openPicker: () => wait(undefined).then(() => void window.open("/?picker", "_blank", "width=620,height=440")),
    closePicker: () => wait(undefined).then(() => console.info("picker closed")),
    showNoteInMain: () => wait(undefined),
    copyText: async (text, html) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        console.info(`copied${html ? " (formatted)" : ""}:`, text);
      }
    },
    desktopSettings: () => wait({ ...desktop }),
    uiSettings: () => wait({}),
    setUiSetting: () => wait(undefined),
    setHotkey: async (which, hotkey) => {
      if (which === "capture") desktop.hotkey = hotkey;
      else desktop.pickerHotkey = hotkey;
      return { ...desktop };
    },
    setAutostart: async (on) => ({ ...Object.assign(desktop, { autostart: on }) }),
    pickFolder: () => wait("/home/nedim/Google Drive/Petrel"),
    listen: () => wait(undefined),

    notesInfo: () => wait({ root: "~/Google Drive/Petrel" }),
    setNotesRoot: (root) => wait({ added: 0, changed: 0, removed: 0, skipped: 0, root }),
    scanNotes: () => wait({ added: 0, changed: 0, removed: 0, skipped: 0, root: "~/Google Drive/Petrel" }),
    listNotes: async (q) =>
      [...notes.values()]
        .filter((n) => q.folder == null || n.folder === q.folder)
        .filter((n) => q.pinned == null || n.pinned === q.pinned)
        .sort(newest)
        .slice(0, q.limit ?? 500)
        .map(summary),
    findNotes: async (text, limit) =>
      [...notes.values()]
        .filter((n) => lower(n.title).includes(lower(text)))
        .sort(newest)
        .slice(0, limit)
        .map(summary),
    searchNotes: async (text, limit) => {
      const ws = words(text);
      return [...notes.values()]
        .filter((n) => ws.length > 0 && ws.every((w) => lower(n.title + " " + n.body).includes(w)))
        .sort(newest)
        .slice(0, limit)
        .map(summary);
    },
    noteFolders: async () => {
      const count = new Map<string, number>();
      for (const n of notes.values()) count.set(n.folder, (count.get(n.folder) ?? 0) + 1);
      return [...count.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, c]) => ({ path, name: path.split("/").pop() || "Notes", depth: path ? path.split("/").length : 0, count: c }));
    },
    openNote: async (id) => ({ ...get(id) }),
    peekNote: async (id) => ({ ...get(id) }),
    createNote: async (folder, title, body, tags) => ({ ...add(folder, freeTitle(folder, title), body, tags) }),
    captureNote: async (body) => ({ ...add("inbox", freeTitle("inbox", stamp(0)), body) }),
    saveNote: async (id, body) => {
      const n = get(id);
      if (Date.now() - n.modifiedAt > 5 * MIN) snapshot(n, "edit");
      n.body = body;
      n.modifiedAt = Date.now();
      n.hash = crypto.randomUUID();
      return { hash: n.hash, modifiedAt: n.modifiedAt, conflict: null };
    },
    renameNote: async (id, title) => {
      const n = get(id);
      const before = { title: n.title, path: n.path };
      n.title = freeTitle(n.folder, title, id);
      n.path = pathOf(n.folder, n.title);
      return { note: { ...n }, token: token(() => Object.assign(n, before)), relinked: 0 };
    },
    moveNote: async (id, folder, title) => {
      const n = get(id);
      const before = { title: n.title, path: n.path, folder: n.folder };
      n.folder = folder;
      n.title = freeTitle(folder, title || n.title, id);
      n.path = pathOf(folder, n.title);
      return { note: { ...n }, token: token(() => Object.assign(n, before)), relinked: 0 };
    },
    mergeNote: async (from, into) => {
      if (from === into) throw new Error("a note cannot be merged into itself");
      const a = get(from);
      const b = get(into);
      const before = b.body;
      snapshot(b, "merge");
      b.body = `${b.body.trimEnd()}\n\n_${new Date().toLocaleString()}_\n\n${a.body}`;
      b.modifiedAt = Date.now();
      notes.delete(from);
      return {
        note: { ...b },
        token: token(() => {
          b.body = before;
          notes.set(a.id, a);
        }),
        relinked: 0,
      };
    },
    pinNote: async (id, pinned) => ({ ...Object.assign(get(id), { pinned }) }),
    setNoteTags: async (id, tags) => ({ ...Object.assign(get(id), { tags }) }),
    trashNote: async (id) => {
      const n = get(id);
      notes.delete(id);
      return token(() => notes.set(n.id, n));
    },
    undo: async (t) => {
      const u = undos.get(t);
      if (!u) throw new Error("nothing to undo: that change is too old or was already undone");
      undos.delete(t);
      u();
      return 1;
    },
    noteVersions: async (id) =>
      [...versions.values()].filter((v) => v.note === id).map((v) => v.v).sort((a, b) => b.createdAt - a.createdAt),
    noteVersionText: async (vid) => versions.get(vid)?.text ?? "",
    restoreNoteVersion: async (id, vid) => {
      const n = get(id);
      snapshot(n, "restore");
      n.body = versions.get(vid)?.text ?? n.body;
      n.hash = crypto.randomUUID();
      return { ...n };
    },
    recordCopy: async (id) => {
      const p = get(id).path;
      copies[p] = (copies[p] ?? 0) + 1;
      return copies[p];
    },
    copyCounts: async () => ({ ...copies }),
    linkTargets: async (text, limit) =>
      [...notes.values()]
        .filter((n) => n.folder !== "inbox" && lower(n.title).includes(lower(text)))
        .slice(0, limit)
        .map((n) => ({ kind: "note" as const, id: n.id, title: n.title, folder: n.folder, uuid: null, modifiedAt: n.modifiedAt })),
    resolveLink: async (inner) => {
      const t = lower(inner.split("|")[0]);
      const n = [...notes.values()].find((x) => lower(x.title) === t);
      return n ? { kind: "note", id: n.id } : { kind: "missing", title: inner, folder: null, draft: false };
    },
    backlinks: async (id) => {
      const me = get(id);
      const linked = [...notes.values()]
        .filter((n) => n.id !== id && parseLinks(n.body).some((l) => lower(l.title ?? "") === lower(me.title)))
        .map((n) => ({
          kind: "note" as const,
          id: n.id,
          title: n.title,
          line: n.body.split("\n").find((l) => l.includes("[[")) ?? "",
        }));
      return { linked, mentioned: [] };
    },

    dayNote: async (date) => {
      const n = [...notes.values()].find((x) => x.folder === "journal" && x.title === date);
      return n ? { ...n } : null;
    },
    fileIntoDay: async (id, date) => {
      const a = get(id);
      let b = [...notes.values()].find((x) => x.folder === "journal" && x.title === date);
      const made = !b;
      b ??= add("journal", date, "");
      const day = b;
      const before = day.body;
      const t = new Date();
      const time = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
      const text = a.body.trim();
      const glue = day.body.trimEnd() ? `${day.body.trimEnd()}\n\n` : "";
      day.body = `${glue}${time}${/^[>\-*#!|`]/.test(text) ? "\n" : " "}${text}\n`;
      day.modifiedAt = Date.now();
      notes.delete(id);
      return {
        note: { ...day },
        token: token(() => {
          day.body = before;
          notes.set(a.id, a);
          if (made) notes.delete(day.id);
        }),
        relinked: 0,
      };
    },
    notesBetween: async (from, to) =>
      [...notes.values()].filter((n) => n.modifiedAt >= from && n.modifiedAt < to).sort((a, b) => b.modifiedAt - a.modifiedAt).map((n) => ({ ...n })),
    topicFaces: async () => ({ ...faces }),
    setTopicFace: async (top, face) => {
      faces[top] = { ...face };
      return { ...face };
    },
    saveAttachment: async (folder, name, bytes) => {
      let link = `attachments/${name.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
      for (let i = 2; pictures.has(`${folder}/${link}`); i++) link = link.replace(/(-\d+)?(\.\w+)$/, `-${i}$2`);
      pictures.set(`${folder}/${link}`, bytes);
      return link;
    },
    attachment: async (folder, link) => {
      const b = pictures.get(`${folder}/${link}`);
      if (!b) throw new Error(`no picture ${link}`);
      return b;
    },
    captureContext: async () =>
      location.search.includes("quote")
        ? { text: "A long, cold proof gives the bread a deeper, slightly sour taste.", app: "Firefox", title: "The Bread Book, chapter 3" }
        : { text: null, app: null, title: null },

    aiStatus: async () => ({ ready: aiKey !== null, model: "claude-opus-5-5", error: null }),
    setAiKey: async (key) => {
      aiKey = key;
      return { ready: key !== null, model: "claude-opus-5-5", error: null };
    },
    aiWrite: async ({ task, text }) => {
      const t = text.trim();
      const out: Record<string, string> = {
        tidy: t.replace(/\s+\n/g, "\n").replace(/^(\w)/, (c) => c.toUpperCase()),
        shorten: t.split(/(?<=[.!?])\s/)[0],
        list: t.split(/(?<=[.!?,])\s+/).map((s) => `- ${s.replace(/[.,]$/, "")}`).join("\n"),
        checklist: t.split(/(?<=[.!?,])\s+/).map((s) => `- [ ] ${s.replace(/[.,]$/, "")}`).join("\n"),
        custom: t.toUpperCase(),
        explain: "This is a quick note to yourself: it says what to do and why it matters now.",
        continue: "\n\nThe next step is to write it down properly, one short paragraph at a time.",
        summarize: "In short: the note lists what is left before the release and who to ask.",
        title: "Release checklist",
      };
      return wait(out[task] ?? t, 900);
    },
    aiAsk: async (q) => {
      const found = about(q, 3);
      return wait(
        {
          answer: found.length
            ? `From your notes: **${found[0].title}** is the closest. ${found[0].body.replace(/^#.*\n/, "").trim().split("\n")[0]}`
            : "Nothing in your notes seems to be about that.",
          sources: found.map((n) => ({ id: n.id, title: n.title, folder: n.folder, preview: n.body.slice(0, 160) })),
        },
        1200,
      );
    },
    aiSuggestHome: async (id) => {
      const me = get(id);
      const near = about(me.body, 6).filter((n) => n.id !== id && n.folder !== "inbox");
      const s: AiSuggestion[] = near.slice(0, 2).map((n) => ({ kind: "merge" as const, noteId: n.id, folder: n.folder, title: n.title, why: "same topic" }));
      s.push({ kind: "move", noteId: null, folder: "Ideas", title: me.body.split(/[.:\n]/)[0].slice(0, 40), why: "a new idea of its own" });
      return wait(s.slice(0, 3), 900);
    },
    aiWeek: async () =>
      wait(
        "Most of the week went to the trip: the flights are booked and [[Tern release]] moved on too. You came back to [[Garden]] twice, which says spring is on your mind.",
        1200,
      ),
    aiRelated: async (id) => {
      const me = get(id);
      return wait(
        about(me.title + " " + me.body, 6)
          .filter((n) => n.id !== id)
          .slice(0, 4)
          .map((n) => ({ id: n.id, title: n.title, folder: n.folder, why: "shares the topic" })),
        900,
      );
    },
  };
}
