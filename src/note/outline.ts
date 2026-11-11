// The headings of a note, for the margin beside the text on a wide window. Pure, for `npm test`.

export interface Heading {
  level: number;
  text: string;
  /** Where the heading line starts in the text. */
  from: number;
}

/** `#` to `######` headings, outside code fences. */
export function outline(text: string): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  let at = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) {
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, ""), from: at });
    }
    at += line.length + 1;
  }
  return out;
}

/** The heading the position is under: the last one at or before it, or -1 before the first. */
export function currentHeading(hs: Heading[], pos: number): number {
  let i = -1;
  for (let k = 0; k < hs.length && hs[k].from <= pos; k++) i = k;
  return i;
}
