// The save controller for the note page: the note-shaped twin of editor/autosave.ts. One save at a time; the
// file is created on the first keystroke or title (an empty new note is not a file); each save hands back the
// hash the next one starts from, so text changed in another app is kept as a conflict copy, never overwritten.

import type { Note, NotesApi } from "../api";
import type { SaveState } from "../editor/autosave";
import type { EditorHandle } from "../editor/editor";

export const NOTE_SAVE_MS = 300;
const RETRY_MS = 2000;

export interface NoteSaver {
  changed(): void;
  flush(): Promise<boolean>;
  load(n: Note | null): void;
  dirty(): boolean;
  error(): string | null;
}

export function createNoteSaver(o: {
  store: () => Promise<NotesApi>;
  editor: () => EditorHandle | undefined;
  note: () => Note | null;
  setNote(n: Note): void;
  setSave(s: SaveState): void;
  /** A new note's folder and title, read when its file is made. */
  fresh(): { folder: string; title: string };
  conflict(path: string): void;
}): NoteSaver {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rev = 0;
  let saved = 0;
  let session = 0;
  let failure: string | null = null;
  let loading = false;
  let queue: Promise<unknown> = Promise.resolve();

  const arm = (ms: number) => {
    timer ??= setTimeout(() => {
      timer = undefined;
      void enqueue();
    }, ms);
  };
  const disarm = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const enqueue = (): Promise<boolean> => {
    const run = queue.then(save);
    queue = run;
    return run;
  };

  async function save(): Promise<boolean> {
    const editor = o.editor();
    if (!editor || rev === saved) return true;
    const mine = session;
    const at = rev;
    const body = editor.text();
    const current = o.note();
    o.setSave("saving");
    try {
      const store = await o.store();
      if (!current) {
        const f = o.fresh();
        if (!body && !f.title.trim()) {
          saved = at;
          o.setSave("saved");
          return true;
        }
        const n = await store.createNote(f.folder, f.title.trim() || "Untitled", body, []);
        if (mine === session) o.setNote(n);
      } else {
        const r = await store.saveNote(current.id, body, current.hash);
        if (mine === session) o.setNote({ ...current, hash: r.hash, modifiedAt: r.modifiedAt, body });
        if (r.conflict) o.conflict(r.conflict);
      }
      if (mine !== session) return true;
      saved = Math.max(saved, at);
      failure = null;
      o.setSave(rev === saved ? "saved" : "dirty");
      return true;
    } catch (e) {
      console.error(e);
      if (mine !== session) return false;
      failure = String(e).replace(/^Error: /, "");
      o.setSave("error");
      disarm();
      arm(RETRY_MS);
      return false;
    }
  }

  return {
    changed() {
      if (loading) return;
      rev++;
      if (failure === null) o.setSave("dirty");
      arm(NOTE_SAVE_MS);
    },
    async flush() {
      for (let round = 0; round < 3; round++) {
        disarm();
        if (!(await enqueue())) return false;
        if (rev === saved) return true;
      }
      return rev === saved;
    },
    load(n) {
      disarm();
      session++;
      rev = saved = 0;
      failure = null;
      if (n) o.setNote(n);
      loading = true;
      try {
        o.editor()?.load(n?.body ?? "", 0);
      } finally {
        loading = false;
      }
      o.setSave("saved");
    },
    dirty: () => rev !== saved,
    error: () => failure,
  };
}
