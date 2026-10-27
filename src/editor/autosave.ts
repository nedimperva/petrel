// The save controller for an editor bound to one draft at a time. The main window and the capture window share
// it, so "the row is created on the first keystroke", one save at a time, and "nothing leaves the editor until it
// is saved" live in one place. It imports only types, so `npm test` runs it under Node with a fake store.

import type { Api, Draft } from "../api";
import type { EditorHandle } from "./editor";

export type SaveState = "saved" | "dirty" | "saving" | "error";

/** A keystroke is in the database at most this long after it is typed, typing or not (plus the write itself). */
export const AUTOSAVE_MS = 300;

/** A failed save is tried again after this long, quietly: the strip says "not saved". */
export const RETRY_MS = 2000;

export type SaveStore = Pick<Api, "newDraft" | "saveDraft" | "saveCursor">;

export interface Autosave {
  /** Call on every document change. */
  changed(): void;
  /** Saves everything typed so far, after any save already running. False when it could not: the text stays in
   * the editor and saving keeps retrying, so the caller must not replace it or close the window. */
  flush(): Promise<boolean>;
  /** Shows `d` (or an empty new draft) without saving the text it replaces. After `flush`, or after an action
   * committed its own result: writing the text the run started from would overwrite that result. */
  load(d: Draft | null): void;
  /** Edits since the last save (or `load`). */
  dirty(): boolean;
  /** Why the last save failed, until one succeeds. */
  error(): string | null;
}

export function createAutosave(o: {
  store: () => Promise<SaveStore>;
  editor: () => EditorHandle | undefined;
  draft: () => Draft | null;
  setDraft(d: Draft | null): void;
  setSave(s: SaveState): void;
}): Autosave {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every edit; `saved` is the revision the database has. */
  let rev = 0;
  let saved = 0;
  /** Bumped by `load`: a save that started for the previous draft must not touch the new one. */
  let session = 0;
  let lastCursor = -1;
  let failure: string | null = null;
  let loading = false;
  /** Saves run one after another, never two at once (two first saves would make two rows). */
  let queue: Promise<unknown> = Promise.resolve();

  function arm(ms: number) {
    timer ??= setTimeout(() => {
      timer = undefined;
      void enqueue();
    }, ms);
  }

  function disarm() {
    clearTimeout(timer);
    timer = undefined;
  }

  function enqueue(): Promise<boolean> {
    const run = queue.then(save);
    queue = run;
    return run;
  }

  async function save(): Promise<boolean> {
    const editor = o.editor();
    if (!editor) return true;
    const mine = session;
    const at = rev;
    const text = editor.text();
    const cursor = editor.cursor();
    const current = o.draft();
    if (at === saved) {
      // Nothing typed: only the cursor, which is not an edit and not worth an error.
      if (current && cursor !== lastCursor) {
        try {
          await (await o.store()).saveCursor(current.id, cursor);
          if (mine === session) lastCursor = cursor;
        } catch (e) {
          console.warn(e);
        }
      }
      return true;
    }
    if (!current && text === "") {
      saved = at;
      o.setSave("saved");
      return true;
    }
    o.setSave("saving");
    try {
      const store = await o.store();
      // A draft that is gone (its Trash emptied in another window) gets a new row: the text is never dropped.
      const ok = current ? await store.saveDraft(current.id, text, cursor) : false;
      if (!ok) {
        const d = await store.newDraft(text);
        if (mine === session) o.setDraft(d);
      }
      if (mine !== session) return true;
      saved = Math.max(saved, at);
      lastCursor = cursor;
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
      // Armed at the first unsaved edit and not pushed back by later ones, so steady typing still saves.
      arm(AUTOSAVE_MS);
    },
    async flush() {
      // Keys typed while a save runs make the text dirty again; a few rounds catch up with any typist.
      for (let round = 0; round < 3; round++) {
        disarm();
        if (!(await enqueue())) return false;
        if (rev === saved) return true;
      }
      return rev === saved;
    },
    load(d) {
      disarm();
      session++;
      rev = saved = 0;
      failure = null;
      lastCursor = d?.cursor ?? -1;
      o.setDraft(d);
      loading = true;
      try {
        o.editor()?.load(d?.content ?? "", d?.cursor ?? 0);
      } finally {
        loading = false;
      }
      o.setSave("saved");
    },
    dirty: () => rev !== saved,
    error: () => failure,
  };
}

/** Words as a person counts them: runs of letters or digits, apostrophes inside a word included. */
export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/** A second close this soon after a failed save writes the text to a file and closes. */
export const CLOSE_AGAIN_MS = 10_000;

/**
 * A window's close (its close button, `Esc` in capture): save, then close. If the save fails the window stays
 * open and says so; closing again soon after writes the text to a file first, so a broken database neither
 * traps the person nor loses the text.
 */
export function createCloser(o: {
  autosave: Autosave;
  text(): string;
  rescue(text: string): Promise<string>;
  close(): Promise<void>;
  say(text: string): void;
}): () => Promise<void> {
  let failedAt = -Infinity;
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try {
      if (await o.autosave.flush()) return await o.close();
      if (Date.now() - failedAt < CLOSE_AGAIN_MS) {
        try {
          await o.rescue(o.text());
        } catch (e) {
          o.say(`Not saved, and no copy could be written either (${e}). The text is still here.`);
          return;
        }
        return await o.close();
      }
      failedAt = Date.now();
      o.say(`Not saved: ${o.autosave.error() ?? "unknown error"}. Close again to keep a copy in a file and close.`);
    } finally {
      busy = false;
    }
  };
}
