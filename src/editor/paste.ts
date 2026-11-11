// Paste that stays clean: HTML on the clipboard (a web page, a mail, a doc) comes in as Markdown. Headings, lists,
// links, bold, italic, code and quotes are kept; everything else is dropped to its words. The HTML is parsed into
// an inert document (DOMParser: no scripts run, nothing loads) and only text is ever inserted, never HTML. The plain
// text goes in first and the Markdown replaces it as a second undo step, so Ctrl Z gives the plain text back.

import { isolateHistory } from "@codemirror/commands";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** The little of a DOM node the converter reads, so `npm test` can feed it a tree without a browser. */
export interface HNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<HNode>;
  getAttribute?(name: string): string | null;
}

/** HTML worth converting: it has structure. A code editor's coloured spans are not, and paste as they are. */
export const MEANINGFUL = /<(h[1-6]|ul|ol|li|a\s|strong|b>|em>|i>|code|pre|blockquote)\b/i;

const DROP = new Set(["SCRIPT", "STYLE", "HEAD", "TEMPLATE", "NOSCRIPT", "IFRAME", "OBJECT", "SVG", "IMG", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "FIGURE", "FIGCAPTION", "TABLE", "TBODY", "THEAD", "DL", "DT", "DD"]);

interface Ctx {
  depth: number;
  pre: boolean;
}

function kids(n: HNode, c: Ctx): string {
  let out = "";
  for (let i = 0; i < n.childNodes.length; i++) out += walk(n.childNodes[i], c);
  return out;
}

/** `**x**` around the words, the spaces outside, so `a<b> b </b>c` stays `a **b** c`. */
function wrap(inner: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

function list(n: HNode, c: Ctx, ordered: boolean): string {
  const items: string[] = [];
  let k = 1;
  for (let i = 0; i < n.childNodes.length; i++) {
    const li = n.childNodes[i];
    if (li.nodeName !== "LI") continue;
    const marker = ordered ? `${k++}. ` : "- ";
    const inner = kids(li, { ...c, depth: c.depth + 1 })
      .trim()
      .replace(/\n{2,}/g, "\n");
    const pad = "  ".repeat(c.depth);
    const lines = inner.split("\n");
    // Nested lists already carry their own indent; other lines of the item line up under its text.
    const rest = lines.slice(1).map((l) => (/^\s*([-*]|\d+\.) /.test(l) ? l : `${pad}${" ".repeat(marker.length)}${l}`));
    items.push([`${pad}${marker}${lines[0]}`, ...rest].join("\n"));
  }
  return `\n\n${items.join("\n")}\n\n`;
}

function walk(n: HNode, c: Ctx): string {
  if (n.nodeType === 3) return c.pre ? (n.textContent ?? "") : (n.textContent ?? "").replace(/\s+/g, " ");
  if (n.nodeType !== 1) return "";
  const tag = n.nodeName.toUpperCase();
  if (DROP.has(tag)) return "";
  const h = /^H([1-6])$/.exec(tag);
  if (h) return `\n\n${"#".repeat(Number(h[1]))} ${kids(n, c).trim().replace(/\s+/g, " ")}\n\n`;
  switch (tag) {
    case "BR":
      return "\n";
    case "HR":
      return "\n\n---\n\n";
    case "STRONG":
    case "B":
      return wrap(kids(n, c), "**");
    case "EM":
    case "I":
      return wrap(kids(n, c), "_");
    case "CODE":
      return c.pre ? kids(n, c) : wrap(kids(n, c), "`");
    case "PRE":
      return `\n\n\`\`\`\n${kids(n, { ...c, pre: true }).replace(/\n+$/, "")}\n\`\`\`\n\n`;
    case "A": {
      const href = n.getAttribute?.("href") ?? "";
      const text = kids(n, c);
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
      return /^(https?:|mailto:)/i.test(href) && m[2] ? `${m[1]}[${m[2]}](${href})${m[3]}` : text;
    }
    case "UL":
      return list(n, c, false);
    case "OL":
      return list(n, c, true);
    case "BLOCKQUOTE": {
      const inner = kids(n, c).trim().replace(/\n{3,}/g, "\n\n");
      return `\n\n${inner
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n")}\n\n`;
    }
    case "TR":
      return `\n${kids(n, c).trim()}`;
    case "TD":
    case "TH":
      return ` ${kids(n, c).trim()} ·`;
    default:
      return BLOCK.has(tag) ? `\n\n${kids(n, c)}\n\n` : kids(n, c);
  }
}

/** Markdown for a parsed HTML body. */
export function htmlToMarkdown(body: HNode): string {
  let fence = false;
  return walk(body, { depth: 0, pre: false })
    .split("\n")
    .map((l) => {
      if (/^```/.test(l)) fence = !fence;
      // The space a line break in the HTML left at the start of a line; code keeps its indent.
      return fence ? l : l.replace(/ ·$/, "").replace(/^ (?=\S)/, "").replace(/[ \t]+$/, "");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Converts pasted HTML; `converted` is told, for the toast. Pictures are left to pictures.ts. */
export function cleanPaste(converted: () => void): Extension {
  return EditorView.domEventHandlers({
    paste(e, view) {
      const data = e.clipboardData;
      if (!data || data.files.length) return false;
      const html = data.getData("text/html");
      const plain = data.getData("text/plain");
      if (!html || !MEANINGFUL.test(html)) return false;
      // Inside a code block, the text as it is.
      const before = view.state.sliceDoc(0, view.state.selection.main.from);
      if ((before.match(/^\s*(```|~~~)/gm)?.length ?? 0) % 2 === 1) return false;
      const md = htmlToMarkdown(new DOMParser().parseFromString(html, "text/html").body as unknown as HNode);
      if (!md || md === plain.trim()) return false;
      e.preventDefault();
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: plain }, selection: { anchor: from + plain.length }, userEvent: "input.paste" });
      view.dispatch({
        changes: { from, to: from + plain.length, insert: md },
        selection: { anchor: from + md.length },
        annotations: isolateHistory.of("full"),
        userEvent: "input.paste",
        scrollIntoView: true,
      });
      converted();
      return true;
    },
  });
}
