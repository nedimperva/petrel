// What was selected when the capture key was pressed, as the text the capture starts with: a Markdown quote,
// and the app, window and (from a browser) a link to the page under it. Plain text, so it can be edited or deleted
// like any other.

import type { CaptureContext } from "../api";

export function quoteBlock(c: CaptureContext): string {
  const text = c.text?.trim();
  if (!text) return "";
  const lines = text.split(/\r?\n/).map((l) => (l.trim() ? `> ${l.trimEnd()}` : ">"));
  const link = c.link ? `[${hostOf(c.link)}](<${c.link}>)` : null;
  const from = [c.app, c.title, link].filter(Boolean).join(" · ");
  return `${lines.join("\n")}${from ? `\n>\n> — ${from}` : ""}\n\n`;
}

/** `https://www.breadbook.example/ch-3` → `breadbook.example`. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}
