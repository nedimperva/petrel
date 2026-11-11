// Versions on one card: in a Prompts or Snippets note, each `## heading` starts a version of the same thing
// (a short and a long prompt, the same command for two shells). The card says how many; Tab steps through them
// on the sheet and in the picker; the one copied last comes first. Pure, for `npm test`.

export interface Version {
  name: string;
  text: string;
}

/** Only collections of things to copy have versions; elsewhere `##` is just a heading. */
export const hasVersions = (folder: string) => /prompt|snippet/i.test(folder.split("/")[0]);

/** The versions in a text, or none when it has fewer than two `## ` headings. Text before the first heading is
 * a version of its own when it says anything. Headings inside code fences do not count. */
export function versionsOf(text: string): Version[] {
  const out: Version[] = [];
  let name: string | null = null;
  let buf: string[] = [];
  let fence = false;
  let heads = 0;
  const flush = () => {
    const t = buf.join("\n").replace(/^\n+|\s+$/g, "");
    if (name !== null || t.trim()) out.push({ name: name ?? "First", text: t });
  };
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      name = m[1];
      buf = [];
      heads++;
    } else buf.push(line);
  }
  flush();
  return heads >= 2 ? out : [];
}

/** The versions with the one copied last first; the rest keep their order. */
export function lastFirst(vs: Version[], last: string | undefined): Version[] {
  const i = vs.findIndex((v) => v.name === last);
  return i <= 0 ? vs : [vs[i], ...vs.slice(0, i), ...vs.slice(i + 1)];
}
