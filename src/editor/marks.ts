// How Markdown looks while you write it. The file stays plain Markdown; only the drawing changes.
//
// - Quiet marks (Settings › Writing): on every line but the ones the cursor or selection is on, `#`, `**`, `_`,
//   `~~`, inline backticks, a link's `[ ](address)`, a picture's `![ ](address)`, `<` `>` around an address, a note
//   link's `[[ ]]`, a quote's `>` (drawn as a bar instead), a code fence's backticks and the `\` before an escaped
//   character are hidden; a list's `-` is a bullet and `---` a rule. Bold reads as bold and a link as its words.
//   Move onto the line and the marks are back to edit. Tasks are drawn by tasks.ts.
// - Code blocks sit on a soft panel with a Copy button on their first line (useful in Snippets).
// - Table columns line up: each cell is padded to its column's width, in a fixed-width font.
//
// All three look only at the visible lines, so a long note costs nothing.

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

const hide = Decoration.replace({});

class Bullet extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = "•";
    return s;
  }
}

class Rule extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-rule";
    return s;
  }
}

const bullet = Decoration.replace({ widget: new Bullet() });
const rule = Decoration.replace({ widget: new Rule() });
const quoteLine = Decoration.line({ class: "cm-quote-line" });
/** A list item that is a task: tasks.ts draws its box, so its `-` is left alone. */
const TASK = /^\s*[-*+] \[( |x|X)\]/;

/** Line numbers the selection touches: their marks stay. */
function activeLines(state: EditorState): Set<number> {
  const out = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return out;
}

function quietRanges(view: EditorView): Range<Decoration>[] {
  const { state } = view;
  const keep = activeLines(state);
  const out: Range<Decoration>[] = [];
  const onKept = (pos: number) => keep.has(state.doc.lineAt(pos).number);
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(n) {
        // A quote's bar is drawn on all its lines, the one being edited too, so the text does not jump.
        if (n.name === "Blockquote") {
          const a = state.doc.lineAt(n.from).number;
          const b = state.doc.lineAt(n.to).number;
          for (let l = a; l <= b; l++) out.push(quoteLine.range(state.doc.line(l).from));
        }
        if (onKept(n.from)) return;
        switch (n.name) {
          case "QuoteMark": {
            const after = state.doc.sliceString(n.to, n.to + 1) === " " ? n.to + 1 : n.to;
            out.push(hide.range(n.from, after));
            return;
          }
          case "ListMark": {
            const line = state.doc.lineAt(n.from);
            if (n.node.parent?.parent?.name !== "BulletList" || TASK.test(line.text)) return;
            out.push(bullet.range(n.from, n.to));
            return;
          }
          case "HorizontalRule":
            out.push(rule.range(n.from, n.to));
            return false;
          case "Escape":
            out.push(hide.range(n.from, n.from + 1));
            return;
          case "CodeMark":
            // A code fence's backticks; the panel shows it is code. The language name after them stays.
            if (n.node.parent?.name === "FencedCode") out.push(hide.range(n.from, n.to));
            return;
          case "Autolink": {
            const marks = n.node.getChildren("LinkMark");
            if (marks.length === 2) out.push(hide.range(marks[0].from, marks[0].to), hide.range(marks[1].from, marks[1].to));
            return false;
          }
          case "Image": {
            // `![words](address)`: only the words show.
            const marks = n.node.getChildren("LinkMark");
            if (!n.node.getChild("URL") || marks.length < 3) return false;
            out.push(hide.range(n.from, marks[0].to), hide.range(marks[1].from, n.to));
            return false;
          }
          case "HeaderMark": {
            // `## ` goes with its space; the closing `#`s of a heading too.
            const after = state.doc.sliceString(n.to, n.to + 1) === " " ? n.to + 1 : n.to;
            if (after > n.from) out.push(hide.range(n.from, after));
            return;
          }
          case "EmphasisMark":
          case "StrikethroughMark":
            out.push(hide.range(n.from, n.to));
            return;
          case "InlineCode": {
            const text = state.doc.sliceString(n.from, n.to);
            const ticks = /^`+/.exec(text)?.[0].length ?? 0;
            if (ticks && text.length > ticks * 2) {
              out.push(hide.range(n.from, n.from + ticks), hide.range(n.to - ticks, n.to));
            }
            return false;
          }
          case "Link": {
            // `[words](address)`: only the words show. A `[[note link]]` is handled below.
            const node = n.node;
            const url = node.getChild("URL");
            const marks = node.getChildren("LinkMark");
            if (!url || marks.length < 3 || state.doc.sliceString(n.from, n.from + 2) === "[[") return;
            out.push(hide.range(marks[0].from, marks[0].to), hide.range(marks[1].from, n.to));
            return false;
          }
        }
      },
    });
    // Note links: `[[Title]]` shows as Title, `[[Title|words]]` as words.
    const text = state.doc.sliceString(from, to);
    for (const m of text.matchAll(/\[\[([^\]\n|]+)(\|[^\]\n]+)?\]\]/g)) {
      const at = from + m.index!;
      if (onKept(at)) continue;
      const end = at + m[0].length;
      out.push(hide.range(at, at + 2 + (m[2] ? m[1].length + 1 : 0)), hide.range(end - 2, end));
    }
  }
  return out;
}

class CopyCode extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(o: CopyCode) {
    return o.code === this.code;
  }
  toDOM() {
    const b = document.createElement("button");
    b.className = "cm-code-copy";
    b.textContent = "Copy";
    b.title = "Copy the code";
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      void navigator.clipboard.writeText(this.code).then(
        () => ((b.textContent = "Copied"), setTimeout(() => (b.textContent = "Copy"), 1200)),
        () => (b.textContent = "Cannot copy"),
      );
    };
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

class Pad extends WidgetType {
  constructor(readonly n: number) {
    super();
  }
  eq(o: Pad) {
    return o.n === this.n;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-table-pad";
    s.textContent = " ".repeat(this.n);
    return s;
  }
}

const codeLine = Decoration.line({ class: "cm-codeblock" });
const codeFirst = Decoration.line({ class: "cm-codeblock cm-codeblock-first" });
const codeLast = Decoration.line({ class: "cm-codeblock cm-codeblock-last" });
const tableLine = Decoration.line({ class: "cm-table" });

function blockRanges(view: EditorView): Range<Decoration>[] {
  const { state } = view;
  const out: Range<Decoration>[] = [];
  const seen = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(n) {
        if (seen.has(n.from)) return false;
        if (n.name === "FencedCode") {
          seen.add(n.from);
          const first = state.doc.lineAt(n.from);
          const last = state.doc.lineAt(n.to);
          const body = n.node.getChild("CodeText");
          const code = body ? state.doc.sliceString(body.from, body.to) : "";
          for (let l = first.number; l <= last.number; l++) {
            const line = state.doc.line(l);
            out.push((l === first.number ? codeFirst : l === last.number ? codeLast : codeLine).range(line.from));
          }
          if (code.trim()) out.push(Decoration.widget({ widget: new CopyCode(code), side: 1 }).range(first.to));
          return false;
        }
        if (n.name === "Table") {
          seen.add(n.from);
          tableRanges(state, n.from, n.to, out);
          return false;
        }
      },
    });
  }
  return out;
}

/** Pads each cell of a table to its column's width; the rows are drawn in a fixed-width font. */
function tableRanges(state: EditorState, from: number, to: number, out: Range<Decoration>[]) {
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  const rows: { line: number; cells: { end: number; width: number }[] }[] = [];
  for (let l = first; l <= last; l++) {
    const line = state.doc.line(l);
    out.push(tableLine.range(line.from));
    const cells: { end: number; width: number }[] = [];
    // A cell ends at the `|` after it; a `\|` inside a cell is text.
    let start = line.text.startsWith("|") ? 1 : 0;
    for (let i = start; i <= line.text.length; i++) {
      if (i === line.text.length || (line.text[i] === "|" && line.text[i - 1] !== "\\")) {
        if (i === line.text.length && i === start) break;
        const cell = line.text.slice(start, i);
        const trimmed = cell.replace(/\s+$/, "");
        cells.push({ end: line.from + start + trimmed.length, width: [...trimmed].length });
        start = i + 1;
      }
    }
    rows.push({ line: l, cells });
  }
  const widths: number[] = [];
  for (const r of rows) r.cells.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.width)));
  for (const r of rows) {
    r.cells.forEach((c, i) => {
      const n = widths[i] - c.width;
      if (n > 0) out.push(Decoration.widget({ widget: new Pad(n), side: 1 }).range(c.end));
    });
  }
}

function plugin(build: (view: EditorView) => Range<Decoration>[], onSelection: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = Decoration.set(build(view), true);
      }
      update(u: ViewUpdate) {
        const tree = syntaxTree(u.startState) !== syntaxTree(u.state);
        if (u.docChanged || u.viewportChanged || tree || (onSelection && u.selectionSet)) {
          this.decorations = Decoration.set(build(u.view), true);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Markdown's marks hidden off the lines being edited. */
export const quietMarks = plugin(quietRanges, true);
/** Code blocks on a panel with Copy, and tables that line up. */
export const blocks = plugin(blockRanges, false);
