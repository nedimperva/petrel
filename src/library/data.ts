// What the library shows, loaded apart from the library itself so the app can count it before Ctrl L is pressed
// without loading the library's screens.
import { api, type Conflict, type NoteSummary, type TopicFace } from "../api";
import { copyBody } from "../collection/snippetText";
import { hasVersions, versionsOf } from "../collection/versions";
import { blankNames } from "./preview";

export interface LibraryData {
  notes: NoteSummary[];
  copies: Record<string, number>;
  /** How many `## versions` a prompt or snippet has, by id, when it has two or more. */
  versions: Record<number, number>;
  /** The first version's text of such a card, which the card shows (the preview would start with its name). */
  firstVersion: Record<number, string>;
  /** Unique blank names found anywhere in a copyable card's text (even past the 200-char summary). */
  blanks: Record<number, string[]>;
  /** Notes with a conflict copy beside them; the copies are not cards of their own. */
  conflicts: Conflict[];
}

export async function loadLibrary(): Promise<LibraryData> {
  const s = await api();
  const [all, copies, conflicts, faces] = await Promise.all([
    s.listNotes({ limit: 5000 }),
    s.copyCounts(),
    s.conflicts().catch(() => [] as Conflict[]),
    s.topicFaces().catch(() => ({}) as Record<string, TopicFace>),
  ]);
  const copyIds = new Set(conflicts.map((c) => c.copy));
  const notes = all.filter((n) => !n.folder.startsWith(".") && !copyIds.has(n.id));
  // Copyable notes are peeked once to count versions and detect blanks past the short preview.
  const versions: Record<number, number> = {};
  const firstVersion: Record<number, string> = {};
  const blanks: Record<number, string[]> = {};
  const ids = notes.filter((n) => hasVersions(n.folder, faces)).slice(0, 400).map((n) => n.id);
  const whole = ids.length ? await s.peekNotes(ids).catch(() => []) : [];
  for (const n of whole) {
    const clean = copyBody(n);
    const vs = versionsOf(clean);
    const source = vs.length > 1 ? vs[0].text : clean;
    if (vs.length > 1) {
      versions[n.id] = vs.length;
      firstVersion[n.id] = vs[0].text.slice(0, 400);
    }
    const bs = blankNames(source);
    if (bs.length) blanks[n.id] = bs;
  }
  return { notes, copies, versions, firstVersion, blanks, conflicts };
}
