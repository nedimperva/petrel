// The `[[link]]` parser for the UI, apart from the editor extension so the fake store can use it without pulling
// CodeMirror's autocomplete onto the launch path. It mirrors crates/petrel-core/src/links.rs, which has the tests
// that count.

export interface ParsedLink {
  /** Offsets of the whole `[[…]]`. */
  from: number;
  to: number;
  /** The text between the brackets. */
  inner: string;
  kind: "note" | "draft" | "uuid";
  title: string;
  folder: string | null;
}

export function parseInner(inner: string): Omit<ParsedLink, "from" | "to" | "inner"> | null {
  const target = inner.split("|")[0].split("#")[0].trim();
  if (target.startsWith("d:")) return target.slice(2).trim() ? { kind: "draft", title: target.slice(2).trim(), folder: null } : null;
  if (target.startsWith("u:")) return target.slice(2).trim() ? { kind: "uuid", title: target.slice(2).trim(), folder: null } : null;
  const slash = target.lastIndexOf("/");
  const title = target.slice(slash + 1).trim();
  if (!title) return null;
  return { kind: "note", title, folder: slash >= 0 ? target.slice(0, slash).replace(/^\/+|\/+$/g, "") || null : null };
}

/** Links in one line (or a whole text without fences), skipping code spans and `\[[`. */
export function parseLinks(text: string, base = 0): ParsedLink[] {
  const out: ParsedLink[] = [];
  let code = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "`") code = !code;
    else if (c === "\\") i++;
    else if (c === "\n") code = false;
    else if (!code && c === "[" && text[i + 1] === "[") {
      const close = text.indexOf("]]", i + 2);
      if (close < 0) break;
      const inner = text.slice(i + 2, close);
      const p = inner.length <= 300 && !inner.includes("[") && !inner.includes("\n") ? parseInner(inner) : null;
      if (p) {
        out.push({ from: base + i, to: base + close + 2, inner, ...p });
        i = close + 1;
      } else i++;
    }
  }
  return out;
}
