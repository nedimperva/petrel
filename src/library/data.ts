// What the library shows, loaded apart from the library itself so the app can count it before Ctrl L is pressed
// without loading the library's screens.
import { api, type Conflict, type NoteSummary } from "../api";
import { hasVersions, versionsOf } from "../collection/versions";

export interface LibraryData {
  notes: NoteSummary[];
  copies: Record<string, number>;
  /** How many `## versions` a prompt or snippet has, by id, when it has two or more. */
  versions: Record<number, number>;
  /** Notes with a conflict copy beside them; the copies are not cards of their own. */
  conflicts: Conflict[];
}

export async function loadLibrary(): Promise<LibraryData> {
  const s = await api();
  const [all, copies, conflicts] = await Promise.all([s.listNotes({ limit: 5000 }), s.copyCounts(), s.conflicts().catch(() => [] as Conflict[])]);
  const copyIds = new Set(conflicts.map((c) => c.copy));
  const notes = all.filter((n) => !n.folder.startsWith(".") && !copyIds.has(n.id));
  // The preview has no headings in it, so the few prompts and snippets are read whole to count their versions.
  const versions: Record<number, number> = {};
  await Promise.all(
    notes
      .filter((n) => hasVersions(n.folder))
      .slice(0, 400)
      .map(async (n) => {
        const k = versionsOf((await s.peekNote(n.id).catch(() => null))?.body ?? "").length;
        if (k > 1) versions[n.id] = k;
      }),
  );
  return { notes, copies, versions, conflicts };
}

