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

export type PreviewLine = { kind: "heading" | "item" | "task" | "done" | "quote" | "text"; text: string; depth: number };

/** A passage as a preview shows it: each heading, list item and task its own line, as on the page, the marks taken
 * out; lines of one paragraph run together as one. Text only. */
export function previewLines(text: string): PreviewLine[] {
  const out: PreviewLine[] = [];
  let fence = false;
  let gap = true;
  for (const raw of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (!raw.trim()) {
      gap = true;
      continue;
    }
    const depth = Math.min(3, Math.floor((/^\s*/.exec(raw)![0].replace(/\t/g, "  ").length) / 2));
    const kind: PreviewLine["kind"] = fence
      ? "text"
      : /^#{1,6}\s/.test(raw)
        ? "heading"
        : /^\s*[-*+] \[[xX]\]\s/.test(raw)
          ? "done"
          : /^\s*[-*+] \[ \]\s/.test(raw)
            ? "task"
            : /^\s*([-*+]|\d+[.)])\s/.test(raw)
              ? "item"
              : /^\s*>/.test(raw)
                ? "quote"
                : "text";
    const words = (fence ? raw : plainLine(raw))
      .replace(/^\s*[☑☐•]\s?/, "")
      .replace(/^\s*\d+[.)]\s+/, "")
      .trim();
    if (!words) continue;
    const last = out[out.length - 1];
    // A paragraph's lines are one block, as Markdown reads them.
    if (kind === "text" && last?.kind === "text" && !fence && !gap) last.text += ` ${words}`;
    else out.push({ kind, text: words, depth: kind === "item" || kind === "task" || kind === "done" ? depth : 0 });
    gap = false;
  }
  return out;
}
