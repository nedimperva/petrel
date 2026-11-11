// What was selected when the capture key was pressed, as the text the capture starts with: a Markdown quote, and
// under it the page or document it came from and (from a browser) a link to it. The app's name is only used when
// there is nothing better. Plain text, so it can be edited or deleted like any other. Also the capture's title:
// your own words first, then the page's title, so captures are easy to find by name.

import type { CaptureContext } from "../api";

export function quoteBlock(c: CaptureContext): string {
  const text = c.text?.trim();
  if (!text) return "";
  const lines = text.split(/\r?\n/).map((l) => (l.trim() ? `> ${l.trimEnd()}` : ">"));
  const link = c.link ? `[${hostOf(c.link)}](<${c.link}>)` : null;
  const from = (c.title || link ? [c.title, link] : [c.app]).filter(Boolean).join(" · ");
  return `${lines.join("\n")}${from ? `\n>\n> — ${from}` : ""}\n\n`;
}

/** The line a capture's title comes from (`titleFrom` in copy.ts makes it a title): its first line of your own
 * words; else the title of the page it quotes; else the quote. */
export function titleLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const words = (l: string) => /[\p{L}\p{N}]/u.test(l);
  const own = lines.find((l) => !l.startsWith(">") && l !== "_from capture_" && words(l));
  if (own) return own;
  const source = lines.find((l) => /^>\s*— /.test(l));
  const page = source?.replace(/^>\s*— /, "").split(" · ")[0].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  if (page && words(page)) return page;
  return lines.filter((l) => l.startsWith(">") && !/^>\s*— /.test(l)).map((l) => l.replace(/^>\s?/, "")).join("\n");
}

/** `https://www.breadbook.example/ch-3` → `breadbook.example`. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}
