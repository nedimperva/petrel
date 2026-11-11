// Tasks in the editor: `- [ ]` and `- [x]` are drawn as a checkbox you can click, and a done task is quiet and
// struck through. On the line being edited the Markdown shows as typed, so it is easy to change. `[] ` at the start
// of a line becomes `- [ ] `; Ctrl Shift X turns a line into a task or ticks it (commands.ts). The file stays plain
// Markdown, so any other app sees the same checklist.

import { type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

/** `- [ ] `, `* [x] `, `+ [X] `, indented or not: the marker, and whether it is done. */
export const TASK_LINE = /^(\s*)([-*+]) \[( |x|X)\](?= |$)/;

class Box extends WidgetType {
  constructor(
    readonly done: boolean,
    readonly at: number,
  ) {
    super();
  }
  eq(o: Box) {
    return o.done === this.done && o.at === this.at;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-box";
    box.checked = this.done;
    box.setAttribute("aria-label", this.done ? "Done, click to open again" : "To do, click when done");
    // Keep the cursor where it is: the click only ticks the box.
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.at, to: this.at + 1, insert: this.done ? " " : "x" }, userEvent: "input" });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

const doneLine = Decoration.line({ class: "cm-task-done" });

const draw = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      const head = view.hasFocus ? view.state.doc.lineAt(view.state.selection.main.head).number : -1;
      let fence = false;
      for (const r of view.visibleRanges) {
        for (let pos = r.from; pos <= r.to; ) {
          const line = view.state.doc.lineAt(pos);
          pos = line.to + 1;
          if (/^\s*(```|~~~)/.test(line.text)) fence = !fence;
          const m = fence ? null : TASK_LINE.exec(line.text);
          if (!m) continue;
          const done = m[3] !== " ";
          if (done) b.add(line.from, line.from, doneLine);
          if (line.number === head) continue;
          // `- [ ]` (the marker and the brackets) becomes the box; the indent stays.
          const from = line.from + m[1].length;
          const to = line.from + m[0].length;
          b.add(from, to, Decoration.replace({ widget: new Box(done, to - 2) }));
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

/** `[] ` (or `- [] `) at the start of a line becomes an open task. */
const typeTask = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== " " || from !== to) return false;
  const line = view.state.doc.lineAt(from);
  const m = /^(\s*)(?:[-*+] )?\[\]$/.exec(line.text.slice(0, from - line.from));
  if (!m) return false;
  const start = line.from + m[1].length;
  view.dispatch({ changes: { from: start, to, insert: "- [ ] " }, selection: { anchor: start + 6 }, userEvent: "input" });
  return true;
});

export const taskExtensions: Extension = [draw, typeTask];
