// How the reading view reads a note: a song (chords in brackets, `[Am]`) keeps its lines and puts each chord over
// the syllable it stands before; anything else is read as Markdown by ReadNote. Pure, for `npm test`.

const CHORD = /\[([A-H](?:#|b)?(?:m|maj|min|dim|aug|sus|add)?\d{0,2}(?:\/[A-H](?:#|b)?)?)\]/g;

/** A note with at least two chords in brackets is read as a song. */
export function isSong(body: string, folder = ""): boolean {
  const n = (body.match(CHORD) ?? []).length;
  return n >= 2 || (/(^|\/)songs?$/i.test(folder) && n >= 1);
}

export type SongLine =
  | { kind: "blank" }
  | { kind: "label"; text: string }
  | { kind: "line"; parts: { chord: string; text: string }[] };

/** A song's lines: `## Chorus` (or `Chorus:`) is a label, a blank line ends a verse, and each line is cut where
 * a chord starts. */
export function songLines(body: string): SongLine[] {
  const out: SongLine[] = [];
  for (const raw of body.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (out.length && out[out.length - 1].kind !== "blank") out.push({ kind: "blank" });
      continue;
    }
    const label = /^#{1,6}\s+(.*)$/.exec(line) ?? /^\s*\[?((?:verse|chorus|bridge|intro|outro|refren|strofa)[^\]:]*)\]?:?\s*$/i.exec(line);
    if (label && !CHORD.test(line)) {
      CHORD.lastIndex = 0;
      out.push({ kind: "label", text: label[1].trim() });
      continue;
    }
    CHORD.lastIndex = 0;
    const parts: { chord: string; text: string }[] = [];
    let at = 0;
    let chord = "";
    for (const m of line.matchAll(CHORD)) {
      const text = line.slice(at, m.index);
      if (text || chord) parts.push({ chord, text });
      chord = m[1];
      at = m.index! + m[0].length;
    }
    parts.push({ chord, text: line.slice(at) });
    out.push({ kind: "line", parts: parts.filter((p, i) => p.chord || p.text || i === 0) });
  }
  while (out.length && out[out.length - 1].kind === "blank") out.pop();
  return out;
}
