// Fill in the blanks, then copy (or run, for a prompt on a note): the text over the page, each blank typed into
// where it stands. The filling in itself is InlineFill, the same as the picker's and Ctrl C's.

import InlineFill from "./InlineFill";

export default function FillBlanks(p: {
  title: string;
  text: string;
  /** `{{selection}}`: what was selected in the app you were in. */
  selection?: string | null;
  onCopy(text: string): void;
  onClose(): void;
  /** The key hint's word: copy, or run for a prompt on a note. */
  action?: string;
}) {
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="ifill-dialog" role="dialog" aria-label={`Fill in ${p.title}`}>
        <InlineFill title={p.title} text={p.text} selection={p.selection} action={p.action?.toLowerCase()} onClose={p.onClose} onCopy={(t) => p.onCopy(t)} />
      </div>
    </div>
  );
}
