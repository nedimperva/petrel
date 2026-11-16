// Find and replace in a note (Ctrl F), drawn as a quiet bar in Petrel's look instead of the editor library's
// stock panel: what to find, what to put instead, how many there are. Enter finds the next, Shift Enter the one
// before, Ctrl Enter (in the second field) replaces them all, Esc closes it.

import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, SearchQuery, setSearchQuery } from "@codemirror/search";
import type { EditorView, Panel } from "@codemirror/view";

/** How many matches the query has, and which one the selection is on (1-based, 0 when none). */
function count(view: EditorView): { at: number; of: number } {
  const q = getSearchQuery(view.state);
  if (!q.valid || !q.search) return { at: 0, of: 0 };
  const cur = q.getCursor(view.state);
  const sel = view.state.selection.main;
  let of = 0;
  let at = 0;
  for (let r = cur.next(); !r.done && of < 9999; r = cur.next()) {
    of++;
    if (r.value.from === sel.from && r.value.to === sel.to) at = of;
  }
  return { at, of };
}

export function findBar(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "find-bar";
  const field = (placeholder: string, label: string) => {
    const i = document.createElement("input");
    i.className = "find-field";
    i.placeholder = placeholder;
    i.setAttribute("aria-label", label);
    i.spellcheck = false;
    return i;
  };
  const find = field("Find in this note", "Find");
  find.setAttribute("main-field", "true");
  const put = field("Replace with", "Replace with");
  const info = document.createElement("span");
  info.className = "find-count";
  const caseBox = document.createElement("button");
  caseBox.className = "find-toggle";
  caseBox.textContent = "Aa";
  caseBox.title = "Match case";
  const hint = document.createElement("span");
  hint.className = "find-hint";
  hint.innerHTML = "<kbd>Enter</kbd> next · <kbd>Ctrl Enter</kbd> replace all · <kbd>Esc</kbd>";
  dom.append(find, info, put, caseBox, hint);

  let caseSensitive = false;
  const show = () => {
    const c = count(view);
    info.textContent = !find.value ? "" : c.of === 0 ? "none" : c.at ? `${c.at} of ${c.of}` : `${c.of}`;
    info.classList.toggle("none", !!find.value && c.of === 0);
  };
  const commit = () => {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: find.value, replace: put.value, caseSensitive })) });
    show();
  };
  find.addEventListener("input", () => {
    commit();
    // As you type, the first match from the cursor is shown (findNext would select the field's text too).
    const q = getSearchQuery(view.state);
    if (find.value && q.valid) {
      const from = view.state.selection.main.from;
      let m = q.getCursor(view.state, from).next();
      if (m.done) m = q.getCursor(view.state, 0).next();
      if (!m.done) view.dispatch({ selection: { anchor: m.value.from, head: m.value.to }, scrollIntoView: true });
    }
    show();
  });
  put.addEventListener("input", commit);
  caseBox.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    caseBox.classList.toggle("on", caseSensitive);
    commit();
  });
  const keys = (e: KeyboardEvent, inPut: boolean) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (inPut && (e.ctrlKey || e.metaKey)) replaceAll(view);
      else if (inPut) replaceNext(view);
      else if (e.shiftKey) findPrevious(view);
      else findNext(view);
      show();
    }
  };
  find.addEventListener("keydown", (e) => keys(e, false));
  put.addEventListener("keydown", (e) => keys(e, true));

  return {
    dom,
    top: true,
    mount() {
      const q = getSearchQuery(view.state);
      const sel = view.state.selection.main;
      // The selected word, if any, is what to find.
      const picked = sel.empty ? "" : view.state.sliceDoc(sel.from, sel.to);
      find.value = picked && !picked.includes("\n") ? picked : q.search;
      put.value = q.replace;
      caseSensitive = q.caseSensitive;
      caseBox.classList.toggle("on", caseSensitive);
      // The panel mounts inside an update; the query goes in just after it.
      setTimeout(commit);
      find.focus();
      find.select();
    },
    update() {
      show();
    },
  };
}
