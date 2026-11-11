// A day's page in the editor: the `21:14` at the start of an entry is drawn small and quiet, and on today's page
// Enter on an empty line under an entry starts the next one with the time. The file stays plain text.

import { Prec, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { clock } from "./days";

const STAMP = /^(\d{1,2}:\d{2})(?=\s|$)/;
const mark = Decoration.mark({ class: "cm-stamp" });

const draw = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      for (const r of view.visibleRanges) {
        for (let pos = r.from; pos <= r.to; ) {
          const line = view.state.doc.lineAt(pos);
          const m = STAMP.exec(line.text);
          if (m) b.add(line.from, line.from + m[1].length, mark);
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

/** `today()` says whether the page is today's: only then does Enter stamp the time. */
export function dayExtensions(today: () => boolean): Extension {
  const enter = Prec.high(
    keymap.of([
      {
        key: "Enter",
        run(view) {
          if (!today()) return false;
          const sel = view.state.selection.main;
          if (!sel.empty) return false;
          const line = view.state.doc.lineAt(sel.head);
          if (line.text.trim() || line.number === 1 || !view.state.doc.line(line.number - 1).text.trim()) return false;
          const insert = `\n${clock()} `;
          view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length }, scrollIntoView: true, userEvent: "input" });
          return true;
        },
      },
    ]),
  );
  return [draw, enter];
}
