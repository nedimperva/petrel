// A card's text, the same on the shelf and in a collection: Markdown marks and version headings (`## Short`) left
// out, blanks as chips in their place in the text. Code keeps its lines.
import { For } from "solid-js";
import { parts } from "../blanks";

/** A preview without Markdown marks or headings, on one line. */
export const plain = (s: string) =>
  s
    .replace(/^#+\s+.*$/gm, "")
    .replace(/^\s*[-*] \[[ xX]\]\s*/gm, "")
    .replace(/^\s*[-*>]\s+/gm, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, l?: string) => l ?? t)
    .replace(/[*_`]/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();

export default function CardText(p: { text: string; code?: boolean; class: string }) {
  const text = () => (p.code ? p.text.replace(/^#+\s+.*\n?/gm, "").replace(/^\n+|\n+$/g, "") : plain(p.text));
  return (
    <span class={p.class}>
      <For each={parts(text())}>{(x) => (x.blank ? <span class="blank-chip">{x.text}</span> : x.text)}</For>
    </span>
  );
}
