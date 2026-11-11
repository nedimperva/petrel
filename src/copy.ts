// The three copies in Ctrl K: Copy (plain text, Markdown marks taken out), Copy as Markdown (the file's text) and
// Copy formatted (rich text, made from the Markdown in Rust). Plain text is what a chat box or a form wants.

/** Markdown to plain text: marks out, words and line breaks kept. Not a parser: good enough for a paste. */
export function plainText(md: string): string {
  return md
    .replace(/^```[^\n]*\n?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/gm, "$1")
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/^>\s?/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])([*_])(?!\s)(.+?)(?<!\s)\1(?![\w*])/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A capture's or note's title from its text: the first line with words, without `#`, at most 60 characters. */
export function titleFrom(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => /[\p{L}\p{N}]/u.test(l)) ?? "";
  const t = plainText(line).replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length <= 60) return t || "Untitled";
  const cut = t.slice(0, 60);
  const sp = cut.lastIndexOf(" ");
  return (sp > 30 ? cut.slice(0, sp) : cut).replace(/[,.;:-]+$/, "");
}

export function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

/** A model's short Markdown answer as safe HTML: everything escaped first, then bold, italics, code, links to
 * notes and list bullets. Nothing else is let through. */
export function answerHtml(md: string): string {
  const esc = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return esc
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "<i>$1</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, l?: string) => `<span class="cm-wikilink">${l ?? t}</span>`)
    .replace(/^\s*[-*] /gm, "• ")
    .replace(/^#{1,6}\s+(.*)$/gm, "<b>$1</b>");
}
