// Filing a capture: into a note (added to its end, the capture goes to the trash) or into a folder as a note of
// its own, titled from its first line. Both are one undo.

import { api, type Note, type NoteChange } from "../api";
import { titleFrom } from "../copy";
import { folderName } from "../ui";
import type { Target } from "./Destination";

export async function fileCapture(n: Note, t: Target): Promise<{ change: NoteChange; text: string }> {
  const s = await api();
  if (t.kind === "note") {
    const change = await s.mergeNote(n.id, t.id);
    return { change, text: `Added to ${t.title}` };
  }
  const change = await s.moveNote(n.id, t.folder, titleFrom(n.body));
  return { change, text: `Filed in ${folderName(t.folder)} as “${change.note.title}”` };
}
