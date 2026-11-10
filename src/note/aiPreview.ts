// An AI rewrite shown in place: the old text struck through, the new text after it, and Keep / Drop / Try again.
// Nothing changes in the document until Keep, so autosave never writes a suggestion the person did not take.
// While a preview is up the editor is read-only: typing into text that is about to be replaced would be lost.

import { EditorState, StateEffect, StateField, type Extension, Prec } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";

export interface Preview {
  from: number;
  to: number;
  /** null while Claude is working. */
  text: string | null;
  error: string | null;
  label: string;
}

export const setPreview = StateEffect.define<Preview | null>();

export interface PreviewActions {
  keep(): void;
  drop(): void;
  retry(): void;
}

class Suggestion extends WidgetType {
  constructor(
    readonly p: Preview,
    readonly act: PreviewActions,
  ) {
    super();
  }
  eq(o: Suggestion) {
    return o.p.text === this.p.text && o.p.error === this.p.error && o.p.label === this.p.label;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "ai-suggest";
    const head = document.createElement("div");
    head.className = "ai-suggest-head";
    head.textContent = this.p.label;
    box.append(head);
    const body = document.createElement("div");
    body.className = "ai-suggest-text";
    if (this.p.error) {
      body.classList.add("ai-error");
      body.textContent = this.p.error;
    } else if (this.p.text === null) {
      body.classList.add("ai-thinking");
      body.textContent = "Claude is writing…";
    } else {
      body.textContent = this.p.text;
    }
    box.append(body);
    const bar = document.createElement("div");
    bar.className = "ai-suggest-bar";
    const button = (label: string, key: string, on: () => void, primary = false) => {
      const b = document.createElement("button");
      b.className = primary ? "btn primary small" : "btn small";
      b.innerHTML = `${label} <kbd>${key}</kbd>`;
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = on;
      bar.append(b);
    };
    if (this.p.text !== null && !this.p.error) button("Keep", "Enter", () => this.act.keep(), true);
    button("Drop", "Esc", () => this.act.drop());
    if (this.p.text !== null || this.p.error) button("Try again", "R", () => this.act.retry());
    const note = document.createElement("span");
    note.className = "ai-suggest-note";
    note.textContent = "Your text is kept in History first.";
    bar.append(note);
    box.append(bar);
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

const struck = Decoration.mark({ class: "ai-struck" });

export function previewOf(state: EditorState): Preview | null {
  return state.field(previewField, false)?.p ?? null;
}

let actions: PreviewActions = { keep() {}, drop() {}, retry() {} };

const previewField = StateField.define<{ p: Preview | null; deco: DecorationSet }>({
  create: () => ({ p: null, deco: Decoration.none }),
  update(v, tr) {
    let p = v.p;
    for (const e of tr.effects) if (e.is(setPreview)) p = e.value;
    if (p && tr.docChanged) p = { ...p, from: tr.changes.mapPos(p.from), to: tr.changes.mapPos(p.to) };
    if (p === v.p && !tr.docChanged) return v;
    if (!p) return { p, deco: Decoration.none };
    const ranges = [];
    if (p.to > p.from) ranges.push(struck.range(p.from, p.to));
    ranges.push(Decoration.widget({ widget: new Suggestion(p, actions), block: true, side: 1 }).range(p.to));
    return { p, deco: Decoration.set(ranges, true) };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    // Read-only while a preview is up (see the file comment); focus stays, so Enter and Esc still reach it.
    EditorState.readOnly.compute([f], (s) => !!s.field(f).p),
  ],
});

/** The editor side; `act` does the work (the note page owns the AI call). */
export function aiPreview(act: PreviewActions): Extension {
  actions = act;
  return [
    previewField,
    Prec.highest(
      keymap.of([
        { key: "Enter", run: (v) => (previewOf(v.state)?.text != null && !previewOf(v.state)?.error ? (act.keep(), true) : false) },
        { key: "Escape", run: (v) => (previewOf(v.state) ? (act.drop(), true) : false) },
        { key: "r", run: (v) => (previewOf(v.state) && (previewOf(v.state)?.text != null || previewOf(v.state)?.error) ? (act.retry(), true) : false) },
      ]),
    ),
  ];
}

/** Puts the kept suggestion into the document as one undoable edit. */
export function keepPreview(view: EditorView): boolean {
  const p = previewOf(view.state);
  if (!p || p.text === null) return false;
  const insert = p.text;
  view.dispatch({
    changes: { from: p.from, to: p.to, insert },
    selection: { anchor: p.from + insert.length },
    effects: setPreview.of(null),
    scrollIntoView: true,
  });
  view.focus();
  return true;
}
