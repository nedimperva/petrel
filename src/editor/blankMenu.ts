// Typing `{{` in a prompt or snippet lists the kinds of blank, so nobody needs to know the syntax: a blank to
// type, one with a default, a choice, the clipboard, the selection, today's date. Picking one writes it and
// selects the part to rename. Only in collections of things to copy; elsewhere `{{` is just text.

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

interface Kind {
  label: string;
  detail: string;
  /** What goes after `{{`, and the part of it selected afterwards to rename. */
  text: string;
  select?: [number, number];
}

const KINDS: Kind[] = [
  { label: "A blank to type", detail: "{{name}}", text: "name}}", select: [0, 4] },
  { label: "With a default", detail: "{{name|default}}", text: "name|default}}", select: [0, 4] },
  { label: "A choice", detail: "{{tone: formal / casual}}", text: "tone: formal / casual}}", select: [0, 4] },
  { label: "The selection", detail: "what you had selected", text: "selection}}" },
  { label: "The clipboard", detail: "what you copied", text: "clipboard}}" },
  { label: "Today's date", detail: "{{today}}", text: "today}}" },
];

export function blankCompletion(on: () => boolean): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    if (!on()) return null;
    const m = ctx.matchBefore(/(?<!\\)\{\{[^{}\n]{0,20}$/);
    if (!m) return null;
    const from = m.from + 2;
    // `}}` already after the caret (typed or closed for you): write only the inside.
    const close = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === "}}";
    const options: Completion[] = KINDS.map((k, i) => ({
      label: k.label,
      detail: k.detail,
      boost: -i,
      apply: (view: EditorView, _c: Completion, f: number, to: number) => {
        const text = close ? k.text.slice(0, -2) : k.text;
        const end = close ? to + 2 : to;
        const sel = k.select ? { anchor: f + k.select[0], head: f + k.select[1] } : { anchor: f + text.length + (close ? 2 : 0) };
        view.dispatch({ changes: { from: f, to: end, insert: close ? `${text}}}` : text }, selection: sel });
      },
    }));
    return { from, options, filter: m.text.length > 2 };
  };
}
