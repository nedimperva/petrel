// Copying a collection item: its text with the blanks filled, counted so the most used come first (and, from the
// picker, counted for the app that was in front).

import { api, errText, type NoteSummary } from "../api";
import { blanks } from "../blanks";
import { say } from "../ui";
import { noteUse } from "./lastUsed";
import { hasVersions, versionsOf } from "./versions";

/** The item's text, and whether it needs the sheet before copying: blanks to fill, or versions to choose. */
export async function itemText(id: number): Promise<{ text: string; title: string; hasBlanks: boolean }> {
  const n = await (await api()).peekNote(id);
  const text = n.body.replace(/\n+$/, "");
  const versions = hasVersions(n.folder) && versionsOf(text).length > 1;
  return { text, title: n.title, hasBlanks: versions || blanks(text).length > 0 };
}

export async function copyFilled(item: Pick<NoteSummary, "id" | "title"> & { path?: string }, text: string, app: string | null = null): Promise<boolean> {
  try {
    const s = await api();
    await s.copyText(text, false);
    await s.recordCopy(item.id, app).catch(() => 0);
    if (item.path) await noteUse(item.path, app);
    say(`Copied “${item.title}”`);
    return true;
  } catch (e) {
    say(errText(e), { error: true });
    return false;
  }
}
