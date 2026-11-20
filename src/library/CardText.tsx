// A card's text, the same on the shelf and in a collection: Markdown marks and version headings (`## Short`) left
// out, blanks as chips in their place in the text. Code and songs keep their lines.
import { For } from "solid-js";
import { parts } from "../blanks";
import { codePreview, plain } from "./preview";

export { plain };

export default function CardText(p: { text: string; code?: boolean; preserveLines?: boolean; class: string }) {
  const text = () => {
    if (p.code) return codePreview(p.text).text;
    if (p.preserveLines) {
      return p.text
        .replace(/^#+\s+.*$/gm, "")
        .replace(/!\[[^\]\n]*\]\([^)\n]+\)/g, "")
        .replace(/[*_`]/g, "")
        .replace(/^\n+|\n+$/g, "");
    }
    return plain(p.text);
  };
  return (
    <span class={p.class}>
      <For each={parts(text())}>{(x) => (x.blank ? <span class="blank-chip">{x.text}</span> : x.text)}</For>
    </span>
  );
}
