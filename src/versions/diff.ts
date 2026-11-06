// A word-level diff for the history panel: what a version had that the current text doesn't, and the reverse.
// Common start and end are cut first, so the usual case (a few words changed in a long draft) compares only the
// middle. The middle is an LCS table, capped: past the cap the middle shows as one removal and one addition,
// which is still true, just coarse.

export type Part = { kind: "same" | "add" | "del"; text: string };

/** Words with the spaces after them, so joining the parts gives back the text exactly. */
export function tokens(s: string): string[] {
  return s.match(/\s+|[^\s]+\s*/g) ?? [];
}

/** Cells of the LCS table we are willing to fill (about 16 MB of Uint32). */
export const MAX_CELLS = 4_000_000;

/** Parts that turn `from` into `to`: `del` is only in `from`, `add` only in `to`. */
export function diff(from: string, to: string): Part[] {
  const a = tokens(from);
  const b = tokens(to);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const parts: Part[] = [];
  const push = (kind: Part["kind"], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  push("same", a.slice(0, start).join(""));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    push("del", midA.join(""));
    push("add", midB.join(""));
  } else {
    for (const p of lcs(midA, midB)) push(p.kind, p.text);
  }
  push("same", a.slice(endA).join(""));
  return parts;
}

function lcs(a: string[], b: string[]): Part[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  // t[i][j]: LCS length of a[i..] and b[j..].
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const out: Part[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** Words added and removed, for the row summary ("+3 −1"). */
export function counts(parts: Part[]): { add: number; del: number } {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  let add = 0;
  let del = 0;
  for (const p of parts) {
    if (p.kind === "add") add += words(p.text);
    else if (p.kind === "del") del += words(p.text);
  }
  return { add, del };
}
