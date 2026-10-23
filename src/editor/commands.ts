// Markdown editing commands bound in editor.ts. Each works on every selected line or range and is one undo step.

import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";

/** The lines touched by the selection, each once. */
function selectedLines(view: EditorView) {
  const seen = new Set<number>();
  const lines = [];
  for (const r of view.state.selection.ranges) {
    for (let pos = r.from; pos <= r.to; ) {
      const line = view.state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        lines.push(line);
      }
      pos = line.to + 1;
    }
  }
  return lines;
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+/;
const TASK = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s+/;

/** `- [ ]` ↔ `- [x]`; a plain list item or line becomes an open task. */
export const toggleTask: Command = (view) => {
  const changes: ChangeSpec[] = [];
  for (const line of selectedLines(view)) {
    const task = TASK.exec(line.text);
    if (task) {
      const at = line.from + task[0].indexOf("[") + 1;
      changes.push({ from: at, to: at + 1, insert: task[3] === " " ? "x" : " " });
      continue;
    }
    const list = LIST.exec(line.text);
    if (list) {
      changes.push({ from: line.from + list[0].length, insert: "[ ] " });
    } else {
      const indent = /^\s*/.exec(line.text)![0].length;
      changes.push({ from: line.from + indent, insert: "- [ ] " });
    }
  }
  view.dispatch({ changes, userEvent: "input" });
  return true;
};

/** Adds `- ` to lines that are not list items, or removes the marker when every line is one. */
export const toggleList: Command = (view) => {
  const lines = selectedLines(view).filter((l) => l.text.trim() !== "");
  if (!lines.length) return false;
  const all = lines.every((l) => LIST.test(l.text));
  const changes: ChangeSpec[] = lines.map((line) => {
    const m = LIST.exec(line.text);
    if (all && m) return { from: line.from + m[1].length, to: line.from + m[0].length };
    const indent = /^\s*/.exec(line.text)![0].length;
    return { from: line.from + indent, insert: "- " };
  });
  view.dispatch({ changes, userEvent: "input" });
  return true;
};

/** Wraps each selection in `mark`, or unwraps it when it is already wrapped. An empty selection gets a pair
 *  with the cursor between. */
function wrap(mark: string): Command {
  return (view) => {
    const { state } = view;
    view.dispatch(
      state.changeByRange((r) => {
        const before = state.sliceDoc(r.from - mark.length, r.from);
        const after = state.sliceDoc(r.to, r.to + mark.length);
        if (before === mark && after === mark) {
          return {
            changes: [
              { from: r.from - mark.length, to: r.from },
              { from: r.to, to: r.to + mark.length },
            ],
            range: EditorSelection.range(r.from - mark.length, r.to - mark.length),
          };
        }
        return {
          changes: [
            { from: r.from, insert: mark },
            { from: r.to, insert: mark },
          ],
          range: EditorSelection.range(r.from + mark.length, r.to + mark.length),
        };
      }),
      { userEvent: "input" },
    );
    return true;
  };
}

export const toggleBold = wrap("**");
export const toggleItalic = wrap("_");

/** `[selection](|)`, or `[|](url)` when the selection is a URL. */
export const insertLink: Command = (view) => {
  const { state } = view;
  view.dispatch(
    state.changeByRange((r) => {
      const text = state.sliceDoc(r.from, r.to);
      if (/^https?:\/\/\S+$/.test(text)) {
        return { changes: { from: r.from, to: r.to, insert: `[](${text})` }, range: EditorSelection.cursor(r.from + 1) };
      }
      const insert = `[${text}]()`;
      return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length - 1) };
    }),
    { userEvent: "input" },
  );
  return true;
};
