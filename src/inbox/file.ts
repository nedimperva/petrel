// Filing a capture: into a note (added to its end, the capture goes to the trash), onto today's page under the
// time, or into a folder as a note of its own, titled from its first line. Each is one undo. Where it went is
// counted, so the review and the capture window offer the usual places first.

import { api, type Note, type NoteChange } from "../api";
import { today } from "../journal/days";
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
    const change = await s.fileIntoDay(n.id, today());
    return { change, text: "Added to today's page" };
  }
  const change = await s.moveNote(n.id, t.folder, titleFrom(titleLine(n.body)));
  return { change, text: `Filed in ${folderName(t.folder)} as “${change.note.title}”` };
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
