// CodeMirror 6 setup for the draft editor. One function makes a view; the caller owns it. Everything that is
// a product decision (what keys do, what Markdown looks like) lives here, not in App.tsx.

import { EditorState, Compartment, RangeSetBuilder } from "@codemirror/state";
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
  /** Focus mode: everything but the paragraph being written is dimmed. */
  setFocusMode(on: boolean): void;
  /** Typewriter scrolling: the line being typed stays in the middle of the window. */
  setTypewriter(on: boolean): void;
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
  { tag: tags.heading, fontWeight: "600", color: "var(--fg-0)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--fg-2)" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--accent)" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
  { tag: tags.quote, color: "var(--fg-1)" },
  { tag: tags.processingInstruction, color: "var(--fg-2)" },
  { tag: tags.meta, color: "var(--fg-2)" },
  { tag: tags.contentSeparator, color: "var(--fg-2)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-size, 14px)", color: "var(--fg-0)", backgroundColor: "transparent" },
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
  ".cm-placeholder": { color: "var(--fg-2)", fontStyle: "normal" },
  ".cm-panels": { backgroundColor: "var(--bg-1)", color: "var(--fg-1)", borderColor: "var(--line)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-searchMatch": { backgroundColor: "var(--warn-soft)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)" },
  ".cm-textfield, .cm-button": { font: "inherit", fontSize: "12px" },
  ".cm-dim": { opacity: "0.35", transition: "opacity var(--d-base) var(--ease)" },
});

export function createEditor(parent: HTMLElement, onChange: () => void): EditorHandle {
  const wrap = new Compartment();
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
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(markdownHighlight),
      placeholder("Type. It's saved. Act on it later."),
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
        effects: [focus.reconfigure(modes.focus ? focusDim : []), typewriter.reconfigure(modes.typewriter ? typewriterScroll : [])],
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
    setFocusMode(on) {
      modes.focus = on;
      view.dispatch({ effects: focus.reconfigure(on ? focusDim : []) });
    },
    setTypewriter(on) {
      modes.typewriter = on;
      view.dispatch({ effects: typewriter.reconfigure(on ? typewriterScroll : []) });
    },
    destroy: () => view.destroy(),
  };
}
