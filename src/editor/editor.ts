// CodeMirror 6 setup for the draft editor. One function makes a view; the caller owns it. Everything that is
// a product decision (what keys do, what Markdown looks like) lives here, not in App.tsx.

import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder, drawSelection, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export interface EditorHandle {
  view: EditorView;
  /** Replaces the whole text without adding to history; used when switching drafts. */
  load(text: string, cursor: number): void;
  text(): string;
  cursor(): number;
  destroy(): void;
}

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
    lineHeight: "1.55",
    padding: "var(--s-5) 0",
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
});

export function createEditor(parent: HTMLElement, onChange: () => void): EditorHandle {
  const wrap = new Compartment();
  const state = EditorState.create({
    doc: "",
    extensions: [
      history(),
      drawSelection(),
      highlightActiveLine(),
      wrap.of(EditorView.lineWrapping),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(markdownHighlight),
      placeholder("Type. It's saved. Act on it later."),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
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
      view.focus();
    },
    text: () => view.state.doc.toString(),
    cursor: () => view.state.selection.main.head,
    destroy: () => view.destroy(),
  };
}
