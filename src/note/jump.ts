// Where to put the cursor when a note opens from a search: at the first place the searched words are, not where
// it was last left. Set just before the note is opened; the page takes it once.

let pending: { id: number; words: string[] } | null = null;

export function jumpTo(id: number, words: string[]) {
  pending = words.length ? { id, words } : null;
}

/** The offset of the first searched word in `text`, if the note just opened was asked for that way. */
export function takeJump(id: number, text: string): number | null {
  const p = pending;
  pending = null;
  if (!p || p.id !== id) return null;
  const lower = text.toLowerCase();
  const at = p.words.map((w) => lower.indexOf(w.toLowerCase())).filter((i) => i >= 0);
  return at.length ? Math.min(...at) : null;
}
