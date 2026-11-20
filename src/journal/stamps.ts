// A day's page in the editor (Option B — Quiet Entry Header):
// Each `HH:MM` entry draws a calm micro-header (`09:14 ─────────`) above flush-left writing, keeping the file
// 100% plain Markdown on disk (`HH:MM text`, or standalone `HH:MM` above a task). The leading `HH:MM ` prefix is
// atomic so Home lands at column 0 and Backspace removes an empty bare stamp cleanly. When typing into a bare
// pending entry after time has passed, its timestamp updates live to the exact minute of writing.

import { Prec, RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { clock, stampMinutes } from "./days";

const INLINE_STAMP = /^(\d{1,2}:\d{2})([ \t]+)(.+)$/;
const BARE_STAMP = /^(\d{1,2}:\d{2})[ \t]*$/;
const FROM = "_from capture_";

class EntryHeadWidget extends WidgetType {
  constructor(
    readonly time: string,
    readonly live: boolean,
    readonly fromCapture: boolean,
    readonly first: boolean,
  ) {
    super();
  }
  eq(o: EntryHeadWidget) {
    return o.time === this.time && o.live === this.live && o.fromCapture === this.fromCapture && o.first === this.first;
  }
  toDOM() {
    const row = document.createElement("div");
    row.className = "cm-entry-head";
    if (this.live) row.classList.add("live");
    if (this.first) row.classList.add("first");

    if (this.live) {
      const dot = document.createElement("span");
      dot.className = "cm-entry-dot";
      dot.setAttribute("aria-hidden", "true");
      row.appendChild(dot);
    }

    const time = document.createElement("span");
    time.className = "cm-entry-time";
    time.textContent = this.time;
    row.appendChild(time);

    if (this.live) {
      const note = document.createElement("span");
      note.className = "cm-entry-live";
      note.textContent = "now";
      row.appendChild(note);
    } else if (this.fromCapture) {
      const tag = document.createElement("span");
      tag.className = "cm-entry-tag";
      tag.textContent = "from capture";
      row.appendChild(tag);
    }

    const rule = document.createElement("span");
    rule.className = "cm-entry-rule";
    rule.setAttribute("aria-hidden", "true");
    row.appendChild(rule);

    return row;
  }
  ignoreEvent() {
    return true;
  }
}

/** True if the entry starting at `startLine` contains `_from capture_` before the next timestamped entry. */
function entryHasCapture(state: EditorState, startLine: number): boolean {
  const max = Math.min(state.doc.lines, startLine + 24);
  for (let n = startLine + 1; n <= max; n++) {
    const t = state.doc.line(n).text.trim();
    if (t === FROM) return true;
    if (INLINE_STAMP.test(t) || BARE_STAMP.test(t)) return false;
  }
  return false;
}

const hiddenPrefix = Decoration.replace({});
const pendingLine = Decoration.line({ class: "cm-entry-pending" });
const fromLine = Decoration.line({ class: "cm-from-capture" });

function buildDecorations(state: EditorState, isToday: () => boolean): { decos: DecorationSet; atomic: DecorationSet } {
  const db = new RangeSetBuilder<Decoration>();
  const ab = new RangeSetBuilder<Decoration>();
  const total = state.doc.lines;
  const todayOn = isToday();
  const cursorLine = state.doc.lineAt(state.selection.main.head).number;
  let fence = false;

  for (let n = 1; n <= total; n++) {
    const line = state.doc.line(n);
    const trimmed = line.text.trim();
    if (/^\s*(```|~~~)/.test(line.text)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;

    if (trimmed === FROM) {
      // Quietly hide `_from capture_` unless the cursor is on it (its pill is shown in the entry header).
      if (n !== cursorLine) db.add(line.from, line.from, fromLine);
      continue;
    }

    const inline = INLINE_STAMP.exec(line.text);
    if (inline) {
      const prefixLen = inline[1].length + inline[2].length;
      const cap = entryHasCapture(state, n);
      db.add(line.from, line.from, Decoration.widget({ widget: new EntryHeadWidget(inline[1], false, cap, n === 1), block: true, side: -1 }));
      db.add(line.from, line.from + prefixLen, hiddenPrefix);
      ab.add(line.from, line.from + prefixLen, hiddenPrefix);
      continue;
    }

    const bare = BARE_STAMP.exec(line.text);
    if (bare) {
      const next = n < total ? state.doc.line(n + 1) : null;
      const nextHasContent = !!next && next.text.trim().length > 0 && !INLINE_STAMP.test(next.text) && !BARE_STAMP.test(next.text);
      if (nextHasContent) {
        // Standalone timestamp directly above content (e.g. `- [ ] Task`): draw the header in place.
        const cap = entryHasCapture(state, n);
        db.add(line.from, line.to, Decoration.replace({ widget: new EntryHeadWidget(bare[1], false, cap, n === 1) }));
        ab.add(line.from, line.to, hiddenPrefix);
      } else {
        // Pending empty entry slot at the end of Today's page: live header above + flush-left caret.
        db.add(line.from, line.from, Decoration.widget({ widget: new EntryHeadWidget(bare[1], todayOn, false, n === 1), block: true, side: -1 }));
        db.add(line.from, line.from, pendingLine);
        if (line.to > line.from) {
          db.add(line.from, line.to, hiddenPrefix);
          ab.add(line.from, line.to, hiddenPrefix);
        }
      }
    }
  }
  return { decos: db.finish(), atomic: ab.finish() };
}

/** Find the stamp minutes of the entry containing `lineNumber`, walking upward. */
function currentEntryMinutes(state: EditorState, lineNumber: number): number | null {
  for (let n = lineNumber; n >= 1; n--) {
    const t = state.doc.line(n).text;
    const m = INLINE_STAMP.exec(t) ?? BARE_STAMP.exec(t);
    if (m) return stampMinutes(m[1]);
  }
  return null;
}

/** Open or jump to a fresh live entry (`clock() `) at the end of the document. */
export function startFreshEntry(view: EditorView): void {
  const doc = view.state.doc.toString();
  const now = `${clock()} `;
  // If the doc already ends with a bare stamp, just refresh its clock and focus it.
  const tail = /(?:^|\n)(\d{1,2}:\d{2}[ \t]*)$/.exec(doc);
  if (tail) {
    const from = doc.length - tail[1].length;
    view.dispatch({
      changes: { from, to: doc.length, insert: now },
      selection: { anchor: from + now.length },
      scrollIntoView: true,
    });
    view.focus();
    return;
  }
  const trimmed = doc.replace(/\s+$/, "");
  const insert = `${trimmed ? "\n\n" : ""}${now}`;
  view.dispatch({
    changes: { from: trimmed.length, to: doc.length, insert },
    selection: { anchor: trimmed.length + insert.length },
    scrollIntoView: true,
  });
  view.focus();
}

/** Keep a trailing bare pending timestamp synced with the current clock (no-op if user already typed after it). */
export function refreshBareTail(view: EditorView): boolean {
  const total = view.state.doc.lines;
  if (!total) return false;
  const last = view.state.doc.line(total);
  const m = BARE_STAMP.exec(last.text);
  if (!m) return false;
  const now = clock();
  if (m[1] === now) return false;
  const want = `${now} `;
  const keepAtEnd = view.state.selection.main.head >= last.from;
  view.dispatch({
    changes: { from: last.from, to: last.to, insert: want },
    ...(keepAtEnd ? { selection: { anchor: last.from + want.length } } : {}),
  });
  return true;
}

/** `today()` says whether the page is today's: only then are fresh live entries stamped and refreshed. */
export function dayExtensions(today: () => boolean): Extension {
  const field = StateField.define<{ decos: DecorationSet; atomic: DecorationSet }>({
    create: (s) => buildDecorations(s, today),
    update(val, tr) {
      if (tr.docChanged || tr.selection) return buildDecorations(tr.state, today);
      return val;
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.decos),
      EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
    ],
  });

  // First keystroke into a bare pending stamp refreshes its time to `clock()` so it is never stale.
  const refreshOnType = EditorView.inputHandler.of((view, from, to, text) => {
    if (!today() || !text || from !== to) return false;
    const line = view.state.doc.lineAt(from);
    const m = BARE_STAMP.exec(line.text);
    if (!m) return false;
    const now = clock();
    if (m[1] === now && line.text.endsWith(" ")) return false;
    const insert = `${now} ${text}`;
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
      scrollIntoView: true,
      userEvent: "input.type",
    });
    return true;
  });

  const keys = Prec.high(
    keymap.of([
      {
        key: "Mod-Enter",
        run(view) {
          if (!today()) return false;
          startFreshEntry(view);
          return true;
        },
      },
      {
        key: "Backspace",
        run(view) {
          const sel = view.state.selection.main;
          if (!sel.empty) return false;
          const line = view.state.doc.lineAt(sel.head);
          // On a bare stamp line, Backspace removes the entire stamp cleanly instead of leaving `14:1`.
          if (BARE_STAMP.test(line.text)) {
            let from = line.from;
            if (line.number > 1) {
              from = view.state.doc.line(line.number - 1).to;
              if (line.number > 2 && !view.state.doc.line(line.number - 1).text.trim()) {
                from = view.state.doc.line(line.number - 2).to;
              }
            }
            view.dispatch({
              changes: { from, to: line.to, insert: "" },
              selection: { anchor: from },
              scrollIntoView: true,
              userEvent: "delete.backward",
            });
            return true;
          }
          // At the start of words right after an inline `HH:MM ` prefix, Backspace removes the timestamp cleanly.
          const inline = INLINE_STAMP.exec(line.text);
          if (inline) {
            const prefixEnd = line.from + inline[1].length + inline[2].length;
            if (sel.head === prefixEnd) {
              view.dispatch({
                changes: { from: line.from, to: prefixEnd, insert: "" },
                selection: { anchor: line.from },
                userEvent: "delete.backward",
              });
              return true;
            }
          }
          return false;
        },
      },
      {
        key: "Enter",
        run(view) {
          if (!today()) return false;
          const sel = view.state.selection.main;
          if (!sel.empty) return false;
          const line = view.state.doc.lineAt(sel.head);
          // Pressing Enter on an empty line under an entry starts a new timed entry ONLY if ≥ 5 min passed.
          if (line.text.trim() || line.number === 1 || !view.state.doc.line(line.number - 1).text.trim()) return false;
          const prevMins = currentEntryMinutes(view.state, line.number - 1);
          const now = new Date();
          const curMins = now.getHours() * 60 + now.getMinutes();
          const elapsed = prevMins === null ? 99 : curMins - prevMins;
          if (elapsed >= 0 && elapsed < 5) return false;
          const insert = `${clock(now)} `;
          view.dispatch({
            changes: { from: line.from, to: line.to, insert },
            selection: { anchor: line.from + insert.length },
            scrollIntoView: true,
            userEvent: "input",
          });
          return true;
        },
      },
    ]),
  );

  return [field, refreshOnType, keys];
}
