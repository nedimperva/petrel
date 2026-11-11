// CodeMirror 6 setup for the draft editor. One function makes a view; the caller owns it. Everything that is
// a product decision (what keys do, what Markdown looks like) lives here, not in App.tsx.

import { EditorState, Compartment, type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder,
  drawSelection,
  highlightActiveLine,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { insertLink, toggleBold, toggleItalic, toggleList, toggleTask } from "./commands";
import { taskExtensions } from "./tasks";

export interface EditorHandle {
  view: EditorView;
  /** Replaces the whole text without adding to history; used when switching drafts. */
  load(text: string, cursor: number): void;
  text(): string;
  cursor(): number;
  /** The main selection, in UTF-16 offsets. */
  selection(): { anchor: number; head: number };
  select(anchor: number, head: number): void;
  /** While an action that may change the text runs, typing would be lost when its result loads. */
  setReadOnly(on: boolean): void;
  /** Adds text at the end (or start) as an edit: undoable, and saved like typing. */
  insert(text: string, atStart: boolean): void;
  /** Focus mode: everything but the paragraph being written is dimmed. */
  setFocusMode(on: boolean): void;
  /** Typewriter scrolling: the line being typed stays in the middle of the window. */
  setTypewriter(on: boolean): void;
  /** Extensions loaded after the editor is up (links), so they cost nothing on the way to the first keystroke. */
  setExtra(ext: Extension): void;
  destroy(): void;
}

const dim = Decoration.line({ class: "cm-dim" });

/** The lines of the paragraph around `pos`: up and down to the nearest blank line. */
export function paragraphAt(state: EditorState, pos: number): { from: number; to: number } {
  const doc = state.doc;
  const here = doc.lineAt(pos);
  if (!here.text.trim()) return { from: here.number, to: here.number };
  let from = here.number;
  let to = here.number;
  while (from > 1 && doc.line(from - 1).text.trim()) from--;
  while (to < doc.lines && doc.line(to + 1).text.trim()) to++;
  return { from, to };
}

/** Dims the visible lines outside the cursor's paragraph. Only visible lines, so a long draft costs nothing. */
const focusDim = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      const { from, to } = paragraphAt(view.state, view.state.selection.main.head);
      for (const r of view.visibleRanges) {
        for (let pos = r.from; pos <= r.to; ) {
          const line = view.state.doc.lineAt(pos);
          if (line.number < from || line.number > to) b.add(line.from, line.from, dim);
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

/** After each edit or move, scroll so the cursor's line sits mid-window. Next frame: not inside an update. */
const typewriterScroll = EditorView.updateListener.of((u) => {
  if (!u.docChanged && !u.selectionSet) return;
  const view = u.view;
  requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
  });
});

// Headings are heavier, not bigger: the first line is the title whether or not it starts with '#'.
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "650", color: "var(--ink)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--faint)" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--accent)" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
  { tag: tags.quote, color: "var(--ink-2)" },
  { tag: tags.processingInstruction, color: "var(--faint)" },
  { tag: tags.meta, color: "var(--faint)" },
  { tag: tags.contentSeparator, color: "var(--faint)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-size, 14px)", color: "var(--ink)", backgroundColor: "transparent" },
  ".cm-scroller": {
    fontFamily: "var(--editor-font, var(--font-ui))",
    lineHeight: "var(--editor-leading, 1.55)",
    padding: "var(--editor-top, var(--s-5)) 0 var(--s-6)",
  },
  ".cm-content": {
    maxWidth: "var(--editor-max)",
    margin: "0 auto",
    padding: "0 var(--s-5)",
    caretColor: "var(--accent)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-line": { padding: "0" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent-soft)" },
  ".cm-placeholder": { color: "var(--faint)", fontStyle: "normal" },
  ".cm-panels": { backgroundColor: "var(--sunk)", color: "var(--ink-2)", borderColor: "var(--line)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-searchMatch": { backgroundColor: "var(--mark)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)" },
  ".cm-textfield, .cm-button": { font: "inherit", fontSize: "12px" },
  ".cm-dim": { opacity: "0.35", transition: "opacity var(--d-base) var(--ease)" },
});

export function createEditor(
  parent: HTMLElement,
  onChange: () => void,
  o: { placeholder?: string } = {},
): EditorHandle {
  const wrap = new Compartment();
  const extra = new Compartment();
  let extraExt: Extension = [];
  const readOnly = new Compartment();
  const focus = new Compartment();
  const typewriter = new Compartment();
  const modes = { focus: false, typewriter: false };
  const state = EditorState.create({
    doc: "",
    extensions: [
      history(),
      drawSelection(),
      highlightActiveLine(),
      wrap.of(EditorView.lineWrapping),
      readOnly.of(EditorState.readOnly.of(false)),
      focus.of([]),
      typewriter.of([]),
      extra.of([]),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(markdownHighlight),
      taskExtensions,
      placeholder(o.placeholder ?? "Start writing. It saves as you type."),
      search({ top: true }),
      // Petrel's own keys first. Alt ↑/↓ (move line), Shift Alt ↓ (duplicate line) and Enter continuing lists
      // come with the defaults and the Markdown language.
      keymap.of([
        { key: "Mod-Shift-x", run: toggleTask },
        { key: "Mod-Shift-8", run: toggleList },
        { key: "Mod-b", run: toggleBold },
        { key: "Mod-i", run: toggleItalic },
        { key: "Mod-Shift-k", run: insertLink },
      ]),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      theme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange();
      }),
    ],
  });
  const view = new EditorView({ state, parent });
  return {
    view,
    load(text, cursor) {
      const pos = Math.min(Math.max(0, cursor), text.length);
      // A fresh state from the original (empty) one keeps the extensions and empties the undo history, so
      // undo can't walk back into the previous draft.
      view.setState(state.update({ changes: { from: 0, to: 0, insert: text }, selection: { anchor: pos } }).state);
      // The fresh state has the starting configuration; keep the modes the person turned on.
      view.dispatch({
        effects: [
          focus.reconfigure(modes.focus ? focusDim : []),
          typewriter.reconfigure(modes.typewriter ? typewriterScroll : []),
          extra.reconfigure(extraExt),
        ],
      });
      view.focus();
    },
    text: () => view.state.doc.toString(),
    cursor: () => view.state.selection.main.head,
    selection: () => ({ anchor: view.state.selection.main.anchor, head: view.state.selection.main.head }),
    select(anchor, head) {
      const len = view.state.doc.length;
      const clamp = (n: number) => Math.min(Math.max(0, n), len);
      view.dispatch({ selection: { anchor: clamp(anchor), head: clamp(head) }, scrollIntoView: true });
    },
    setReadOnly: (on) => view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(on)) }),
    insert(text, atStart) {
      const doc = view.state.doc;
      const at = atStart ? 0 : doc.length;
      // One newline between the old text and the new, unless there is one already.
      const glue = doc.length === 0 ? "" : atStart ? (text.endsWith("\n") ? "" : "\n") : doc.sliceString(at - 1, at) === "\n" ? "" : "\n";
      const insert = atStart ? text + glue : glue + text;
      view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + (atStart ? 0 : insert.length) }, scrollIntoView: true });
    },
    setFocusMode(on) {
      modes.focus = on;
      view.dispatch({ effects: focus.reconfigure(on ? focusDim : []) });
    },
    setTypewriter(on) {
      modes.typewriter = on;
      view.dispatch({ effects: typewriter.reconfigure(on ? typewriterScroll : []) });
    },
    setExtra(ext) {
      extraExt = ext;
      view.dispatch({ effects: extra.reconfigure(ext) });
    },
    destroy: () => view.destroy(),
  };
}
