// Markdown marks taken out of a passage for a preview, the way the page shows them off the line you are on:
// `[[Title|words]]` is its words, `**bold**` is bold's words, a task is a box. Text only; nothing becomes HTML.

export function plainLine(line: string): string {
  return line
    .replace(/^\s*>\s?/, "")
    .replace(/^(\s*)[-*+] \[[xX]\]\s+/, "$1☑ ")
    .replace(/^(\s*)[-*+] \[ \]\s+/, "$1☐ ")
    .replace(/^(\s*)[-*+]\s+/, "$1• ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, (_, t: string) => t.split("/").pop() ?? t)
    .replace(/\[([^\]]+)\]\(<?[^)>]*>?\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, "$1$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/, "");
}

/** A paragraph of several lines, each made plain. */
export function plainText(text: string): string {
  return text.split("\n").map(plainLine).join("\n");
}
