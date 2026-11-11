// A collection's look: one of a few quiet colours and a small mark, picked by the owner and kept in the folder's
// `.petrel` file (crates/petrel-core/src/notes.rs, `set_topic_face`). Without one, the colour comes from the
// folder's name so it stays the same, and the mark is a dot.

import type { TopicFace } from "../api";

export interface Color {
  id: string;
  label: string;
}

/** The order the picker shows them in. The CSS classes are `hue-<id>` (styles.css). */
export const COLORS: Color[] = [
  { id: "blue", label: "Blue" },
  { id: "teal", label: "Teal" },
  { id: "green", label: "Green" },
  { id: "ochre", label: "Ochre" },
  { id: "clay", label: "Clay" },
  { id: "rose", label: "Rose" },
  { id: "plum", label: "Plum" },
  { id: "slate", label: "Slate" },
];

/** Stroke icons on a 24 px grid, drawn at 14 px. */
export const MARKS: { id: string; label: string; d: string }[] = [
  { id: "dot", label: "Dot", d: "M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" },
  { id: "plane", label: "Travel", d: "M2 16l20-8-8 14-2-6z" },
  { id: "pot", label: "Cooking", d: "M4 11h16a8 8 0 0 1-16 0zM8 7c0-2 2-2 2-4M13 7c0-2 2-2 2-4" },
  { id: "spark", label: "Ideas", d: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" },
  { id: "code", label: "Code", d: "M5 7l5 5-5 5M12 17h7" },
  { id: "music", label: "Music", d: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0a3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0a3 3 0 0 1 6 0z" },
  { id: "home", label: "Home", d: "M4 11l8-7 8 7M6 9v11h12V9" },
  { id: "book", label: "Reading", d: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5" },
  { id: "work", label: "Work", d: "M4 8h16v11H4zM9 8V5h6v3" },
  { id: "heart", label: "People", d: "M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" },
  { id: "leaf", label: "Garden", d: "M5 19c0-9 6-14 15-14 0 9-5 15-14 15M5 19l7-7" },
  { id: "pen", label: "Writing", d: "M4 20h4L19 9l-4-4L4 16z" },
];

const DEFAULT_COLORS = ["blue", "green", "clay", "plum"];

/** The top folder of a path ("" is the top of the notes folder). */
export const topOf = (folder: string) => folder.split("/")[0];

/** Names that are things to copy unless the owner says otherwise. */
const COPY_NAMES = /prompt|snippet|template|repl|command|signature|boilerplate|copy/i;

/** Whether a collection holds things to copy (cards in the library and the picker) or pages (found with Ctrl K).
 * The inbox, the journal and the top of the folder are pages. */
export function toCopy(folder: string, faces?: Record<string, TopicFace>): boolean {
  const top = topOf(folder);
  if (!top || top === "inbox" || top === "journal") return false;
  const set = faces?.[top]?.copy;
  if (set === "yes") return true;
  if (set === "no") return false;
  return COPY_NAMES.test(top);
}

/** The colour id a collection draws with. */
export function colorOf(folder: string, faces?: Record<string, TopicFace>): string {
  const top = topOf(folder);
  if (top === "inbox") return "ochre";
  if (top === "journal") return "slate";
  if (!top) return "slate";
  const set = faces?.[top]?.color;
  if (set && COLORS.some((c) => c.id === set)) return set;
  let h = 0;
  for (const c of top) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return DEFAULT_COLORS[h % DEFAULT_COLORS.length];
}

/** The mark's path, or null for the plain dot. */
export function markOf(folder: string, faces?: Record<string, TopicFace>): string | null {
  const id = faces?.[topOf(folder)]?.mark;
  if (!id || id === "dot") return null;
  return MARKS.find((m) => m.id === id)?.d ?? null;
}
