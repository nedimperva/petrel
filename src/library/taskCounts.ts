// How many open tasks each note has, from the engine (which reads every note whole), not from the short preview
// a card has: a task further down a page counts too. Shared by the shelves, a collection's cards and the reader.

import { createSignal } from "solid-js";
import { api } from "../api";

const [counts, setCounts] = createSignal<Record<number, number>>({});

/** Open tasks of a note; 0 until loaded. */
export const tasksOf = (id: number) => counts()[id] ?? 0;

/** Reads them again: when the library opens, and after anything changes. */
export async function loadTaskCounts() {
  try {
    const out: Record<number, number> = {};
    for (const t of await (await api()).openTasks()) out[t.noteId] = (out[t.noteId] ?? 0) + 1;
    setCounts(out);
  } catch {
    // No folder yet, or the engine is busy: no counts rather than an error.
  }
}
