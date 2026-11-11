// What was selected when the capture key was pressed, as the text the capture starts with: a Markdown quote,
// and the app and window it came from under it. Plain text, so it can be edited or deleted like any other.

import type { CaptureContext } from "../api";

export function quoteBlock(c: CaptureContext): string {
  const text = c.text?.trim();
  if (!text) return "";
  const lines = text.split(/\r?\n/).map((l) => (l.trim() ? `> ${l.trimEnd()}` : ">"));
  const from = [c.app, c.title].filter(Boolean).join(" · ");
  return `${lines.join("\n")}${from ? `\n>\n> — ${from}` : ""}\n\n`;
}
