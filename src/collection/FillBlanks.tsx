// Fill in the blanks, then copy: one field per `{{name}}`, Tab to the next, Enter copies. The finished text is
// shown as it will be pasted. The fields are BlankFields: some fill themselves, the last answers come back. In the
// picker (`inline`) the text is on the left, its blanks filling in as you type, and the fields on the right.

import { For } from "solid-js";
import { parts } from "../blanks";
import BlankFields, { createBlanks } from "./BlankFields";

export default function FillBlanks(p: {
  title: string;
  text: string;
  /** `{{selection}}`: what was selected in the app you were in. */
  selection?: string | null;
  onCopy(text: string): void;
  onClose(): void;
  inline?: boolean;
  /** The button's word: Copy, or Run for a prompt on a note. */
  action?: string;
}) {
  const state = createBlanks(
    () => p.text,
    () => p.selection,
  );
  const done = () => {
    void state.keep();
    p.onCopy(state.out());
  };

  const value = (name: string) => {
    const b = state.list().find((x) => x.name === name);
    return b ? state.value(b) : "";
  };

  const split = (
    <form
      class="fill fill-split"
      onSubmit={(e) => {
        e.preventDefault();
        done();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          p.onClose();
        } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement && !e.ctrlKey)) {
          e.preventDefault();
          done();
        }
      }}
    >
      <div class="fill-main">
        <div class="fill-head">
          <span>{p.title}</span>
        </div>
        <div class="fill-text">
          <For each={parts(p.text)}>
            {(x) =>
              x.blank ? (
                <span class="blank-chip" classList={{ filled: !!value(x.text) }}>
                  {value(x.text) || x.text}
                </span>
              ) : (
                x.text
              )
            }
          </For>
        </div>
        <span class="muted small">Filled blanks are marked; the rest still say their name.</span>
      </div>
      <aside class="fill-side">
        <div class="side-head">Fill in</div>
        <BlankFields state={state} side />
        <span class="grow" />
        <button type="submit" class="btn primary wide big">
          {p.action ?? "Copy"} <kbd>Enter</kbd>
        </button>
        <span class="muted small center">
          <kbd>Tab</kbd> next · <kbd>↑</kbd> earlier · <kbd>Esc</kbd> back
        </span>
      </aside>
    </form>
  );

  const form = (
    <form
      class="fill"
      onSubmit={(e) => {
        e.preventDefault();
        done();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          p.onClose();
        } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement && !e.ctrlKey)) {
          e.preventDefault();
          done();
        }
      }}
    >
      <div class="fill-head">
        <span>{p.title}</span>
        <span class="muted">Fill in the blanks</span>
      </div>
      <BlankFields state={state} />
      <pre class="fill-preview">{state.out()}</pre>
      <div class="row end">
        <span class="muted small">
          <kbd>Tab</kbd> next blank · <kbd>↑</kbd> earlier answers
        </span>
        <span class="grow" />
        <button type="button" class="btn" onClick={p.onClose}>
          Cancel <kbd>Esc</kbd>
        </button>
        <button type="submit" class="btn primary">
          {p.action ?? "Copy"} <kbd>Enter</kbd>
        </button>
      </div>
    </form>
  );
  if (p.inline) return split;
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="dialog">{form}</div>
    </div>
  );
}
