// One card in the library. It looks like what it holds: a prompt shows its blanks as chips, a snippet is code,
// a song is lyrics, anything else is the first lines of the text. Copy, Edit and (in the inbox) Move show on
// hover and on the selected card.

import { For, Show } from "solid-js";
import type { NoteSummary } from "../api";
import { parts } from "../blanks";
import { ago, folderName } from "../ui";
import { topOf } from "./faces";
import Mark, { hueClass } from "./Mark";

export { topOf };

export type CardKind = "code" | "song" | "text";

export function kindOf(folder: string): CardKind {
  const top = topOf(folder).toLowerCase();
  if (/snippet|code|command|shell/.test(top)) return "code";
  if (/song|lyric|poem/.test(top)) return "song";
  return "text";
}

export const isPrompt = (n: NoteSummary) => /\{\{[^}]+\}\}/.test(n.preview);

export default function Card(p: {
  n: NoteSummary;
  copies: number;
  /** `## versions` in a prompt or snippet. */
  versions?: number;
  on: boolean;
  /** Just copied. */
  flash?: boolean;
  /** On the shelf every card says which collection it is from. */
  showWhere?: boolean;
  onSelect(): void;
  onOpen(): void;
  onCopy(): void;
  onEdit(): void;
  onMove?: () => void;
}) {
  const kind = () => kindOf(p.n.folder);
  const inbox = () => p.n.folder === "inbox";
  const title = () => (inbox() ? "" : p.n.title);
  // The same blank used twice is asked once, so it counts once.
  const blanks = () => new Set(parts(p.n.preview).filter((x) => x.blank).map((x) => x.text)).size;
  const meta = () => {
    const out: string[] = [];
    if (p.copies) out.push(`Copied ${p.copies} ${p.copies === 1 ? "time" : "times"}`);
    if (p.versions) out.push(`${p.versions} versions`);
    if (blanks()) out.push(`${blanks()} ${blanks() === 1 ? "blank" : "blanks"}`);
    if (!out.length || inbox()) out.push(ago(p.n.modifiedAt));
    return out.join(" · ");
  };
  const stop = (f: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    f();
  };

  return (
    <article
      class={`lcard ${hueClass(p.n.folder)} kind-${kind()}`}
      classList={{ on: p.on, inbox: inbox(), flash: !!p.flash }}
      tabIndex={-1}
      data-card={p.n.id}
      onMouseDown={() => p.onSelect()}
      onClick={() => p.onOpen()}
    >
      <div class="lcard-top">
        <span class="lcard-where">
          <Mark folder={p.n.folder} size={12} />
          {p.showWhere || inbox() ? folderName(topOf(p.n.folder)) : p.n.pinned ? "Pinned" : folderName(p.n.folder)}
        </span>
        <span class="lcard-acts">
          <Show when={p.onMove}>
            <button type="button" class="lcard-act" title="Move to a note or collection (m)" aria-label="Move" onClick={stop(() => p.onMove!())}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </Show>
          <button type="button" class="lcard-act" title="Copy (c)" aria-label="Copy" onClick={stop(p.onCopy)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          </button>
          <button type="button" class="lcard-act" title="Edit (e)" aria-label="Edit" onClick={stop(p.onEdit)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 20h4L19 9l-4-4L4 16z" />
            </svg>
          </button>
        </span>
      </div>
      <Show when={title()}>
        <h3 class="lcard-title">{title()}</h3>
      </Show>
      <div class="lcard-body">
        <For each={parts(p.n.preview)}>{(x) => (x.blank ? <span class="blank-chip">{x.text}</span> : x.text)}</For>
      </div>
      <footer class="lcard-meta">{meta()}</footer>
    </article>
  );
}
