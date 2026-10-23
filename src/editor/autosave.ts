// Autosave for an editor bound to one draft at a time. The main window and the capture window share it, so
// "the row is created on the first keystroke" and the retry-on-error rule live in one place.

import type { Accessor } from "solid-js";
import { api, type Draft } from "../api";
import type { EditorHandle } from "./editor";

export type SaveState = "saved" | "dirty" | "saving" | "error";

/** Autosave waits this long after the last keystroke. The kill test allows exactly this much loss. */
export const AUTOSAVE_MS = 300;

export interface Autosave {
  /** Call on every document change. */
  changed(): void;
  /** Saves now, after any save already running. */
  flushNow(): Promise<void>;
}

export function createAutosave(o: {
  editor: () => EditorHandle | undefined;
  draft: Accessor<Draft | null>;
  setDraft(d: Draft): void;
  setSave(s: SaveState): void;
}): Autosave {
  let timer: number | undefined;
  let saving: Promise<void> | null = null;

  // The row is created on the first keystroke, never for an untouched new draft.
  async function flush() {
    const a = await api;
    const editor = o.editor();
    if (!editor) return;
    const text = editor.text();
    const cursor = editor.cursor();
    const current = o.draft();
    if (!current && text === "") return;
    o.setSave("saving");
    try {
      if (!current) {
        const d = await a.newDraft(text);
        o.setDraft(d);
        // Text may have changed while the insert ran.
        if (editor.text() !== text) await a.saveDraft(d.id, editor.text(), editor.cursor());
      } else {
        const ok = await a.saveDraft(current.id, text, cursor);
        if (!ok) throw new Error("draft vanished");
      }
      o.setSave(editor.text() === text ? "saved" : "dirty");
    } catch (e) {
      console.error(e);
      o.setSave("error");
      schedule(2000); // not a dialog: retry quietly
    }
  }

  function schedule(ms = AUTOSAVE_MS) {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      saving = flush().finally(() => (saving = null));
    }, ms);
  }

  return {
    changed() {
      o.setSave("dirty");
      schedule();
    },
    async flushNow() {
      window.clearTimeout(timer);
      if (saving) await saving;
      await flush();
    },
  };
}

/** Words as a person counts them: runs of letters or digits, apostrophes inside a word included. */
export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}
