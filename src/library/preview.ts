// Pure preview helpers shared by library cards, collection lists, the reader and the quick picker.
// Kept free of runtime imports so `node --test` runs directly on this file.

export interface PreviewTask {
  done: boolean;
  text: string;
}

const IMAGE_RE = /!\[([^\]\n]*)\]\([^)\n]+\)/g;
const TRIGGER_RE = /^;([\p{L}\p{N}_-]{1,24})\s*$/u;
const BLANK_RE = /(\\)?\{\{\s*([^{}|]+?)\s*(?:\|[^{}]*)?\}\}/g;

/** A preview without Markdown marks, headings or raw image syntax, on one line. */
export function plain(s: string): string {
  return s
    .replace(/^#+\s+.*$/gm, "")
    .replace(IMAGE_RE, "")
    .replace(/^\s*[-*] \[[ xX]\]\s*/gm, "")
    .replace(/^\s*[-*>]\s+/gm, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, l?: string) => l ?? t)
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/|mailto:)[^)\n]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

/** Count Markdown image links in a note preview or body. */
export function photoCount(s: string): number {
  let n = 0;
  for (const _ of s.matchAll(IMAGE_RE)) n++;
  return n;
}

/** Checklist lines from a preview, for structured task-heavy page cards. */
export function previewTasks(s: string, limit = 3): PreviewTask[] {
  const out: PreviewTask[] = [];
  for (const raw of s.split("\n")) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s*(.+)$/.exec(raw);
    if (!m) continue;
    const text = m[2]
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_a, t: string, l?: string) => l ?? t)
      .replace(/[*_`]/g, "")
      .trim();
    if (text) out.push({ done: m[1] !== " ", text });
    if (out.length >= limit) break;
  }
  return out;
}

/** Code snippet preview: strips headings, `;trigger` lines and outer fences, and detects fenced language. */
export function codePreview(s: string): { lang: string; text: string } {
  const lines = s.replace(/\r\n?/g, "\n").split("\n");
  let lang = "";
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!out.length && !trimmed) continue;
    if (!out.length && TRIGGER_RE.test(trimmed)) continue;
    if (/^#+\s+/.test(trimmed)) continue;
    const fence = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(trimmed);
    if (fence) {
      if (!lang && fence[1]) lang = fence[1].toLowerCase();
      continue;
    }
    out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return { lang, text: out.join("\n") };
}

/** Unique blank names in order of first appearance, for compact blank-pill strips on cards. */
export function blankNames(s: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of s.matchAll(BLANK_RE)) {
    if (m[1]) continue;
    const inner = m[2].trim();
    const at = inner.indexOf(":");
    const name = at > 0 && inner.slice(at + 1).includes("/") ? inner.slice(0, at).trim() : inner;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Split plain text into matching and non-matching segments for safe `<mark>` rendering. */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (!words.length || !text) return [{ text, hit: false }];
  const re = new RegExp(`(${words.map(escapeRe).join("|")})`, "giu");
  return text
    .split(re)
    .filter(Boolean)
    .map((part) => ({ text: part, hit: words.some((w) => w.toLowerCase() === part.toLowerCase()) }));
}

/** The subfolder segment directly beneath a collection's top folder, or `""`. */
export function subOf(folder: string, top: string): string {
  if (!top || folder === top || !folder.startsWith(`${top}/`)) return "";
  return folder.slice(top.length + 1);
}
