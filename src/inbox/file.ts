// Filing a capture: into a note (added to its end, the capture goes to the trash), onto today's page under the
// time, or into a folder as a note of its own, titled from its first line. Each is one undo. Where it went is
// counted, so the review and the capture window offer the usual places first.

import { api, type Note, type NoteChange } from "../api";
import { dayTitle, today } from "../journal/days";
import { folderName } from "../ui";
import type { Target } from "./Destination";
import { bump, parseCounts, type Counts } from "./learn";
import { titleFrom } from "../copy";
import { titleLine } from "./quote";

export async function fileCapture(n: Note, t: Target): Promise<{ change: NoteChange; text: string }> {
  const s = await api();
  void remember(t);
  if (t.kind === "note") {
    const change = await s.mergeNote(n.id, t.id);
    return { change, text: `Added to ${t.title}` };
  }
  if (t.kind === "day") {
    const date = t.date ?? today();
    const change = await s.fileIntoDay(n.id, date);
    return { change, text: date === today() ? "Added to today's page" : `Added to ${dayTitle(date)}` };
  }
  // A capture is named by its first line when it is filed; a note that already has a home keeps its name.
  const capture = n.folder === "inbox";
  const change = await s.moveNote(n.id, t.folder, capture ? titleFrom(titleLine(n.body)) : n.title);
  return { change, text: capture ? `Filed in ${folderName(t.folder)} as “${change.note.title}”` : `Moved to ${folderName(t.folder)}` };
}

export async function filedCounts(): Promise<Counts> {
  const s = await api();
  return parseCounts((await s.uiSettings().catch(() => ({}) as Record<string, string>))["ui.filed"]);
}

async function remember(t: Target) {
  const s = await api();
  const next = bump(await filedCounts(), t);
  await s.setUiSetting("ui.filed", JSON.stringify(next)).catch(() => {});
}
