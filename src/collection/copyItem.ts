// Copying a collection item: its text with the blanks filled, counted so the most used come first.

import { api, errText, type NoteSummary } from "../api";
import { blanks } from "../blanks";
import { say } from "../ui";

/** The item's text, and whether it has blanks to fill before copying. */
export async function itemText(id: number): Promise<{ text: string; title: string; hasBlanks: boolean }> {
  const n = await (await api()).peekNote(id);
  const text = n.body.replace(/\n+$/, "");
  return { text, title: n.title, hasBlanks: blanks(text).length > 0 };
}

export async function copyFilled(item: Pick<NoteSummary, "id" | "title">, text: string): Promise<boolean> {
  try {
    const s = await api();
    await s.copyText(text, false);
    await s.recordCopy(item.id).catch(() => 0);
    say(`Copied “${item.title}”`);
    return true;
  } catch (e) {
    say(errText(e), { error: true });
    return false;
  }
}
