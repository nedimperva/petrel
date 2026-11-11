// Fill in the blanks, then copy: one field per `{{name}}`, Tab to the next, Enter copies. The finished text is
// shown as it will be pasted. The fields are BlankFields: some fill themselves, the last answers come back.

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
  if (p.inline) return form;
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="dialog">{form}</div>
    </div>
  );
}
