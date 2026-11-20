// Fill in the blanks, then copy: one field per `{{name}}`, Tab to the next, Enter copies. The finished text is
// shown as it will be pasted. The fields are BlankFields: some fill themselves, the last answers come back. In the
// picker (`inline`) the text is on the left, its blanks filling in as you type and staying linked to the fields
// on the right.

import { createSignal, For, Show } from "solid-js";
import { parts } from "../blanks";
import { kindOf } from "../library/Card";
import Mark, { hueClass } from "../library/Mark";
import { folderName } from "../ui";
import BlankFields, { createBlanks, type BlankKind } from "./BlankFields";

export default function FillBlanks(p: {
  title: string;
  text: string;
  /** Collection folder, for mark, hue and code formatting. */
  folder?: string;
  /** Version label when filling one version of a multi-version card. */
  versionName?: string;
  /** `{{selection}}`: what was selected in the app you were in. */
  selection?: string | null;
  /** App in front when opened from the picker, for "Paste into …". */
  targetApp?: string | null;
  /** Focus this blank first (e.g. clicked directly in the picker preview). */
  initialBlank?: string | null;
  onCopy(text: string): void;
  onPaste?: (text: string, shift: boolean) => void;
  onClearSelection?: () => void;
  onClose(): void;
  inline?: boolean;
  /** The button's word: Copy, or Run for a prompt on a note. */
  action?: string;
}) {
  let sideEl: HTMLElement | undefined;
  const [activeBlank, setActiveBlank] = createSignal<string | null>(p.initialBlank ?? null);
  const state = createBlanks(
    () => p.text,
    () => p.selection,
  );
  const done = (paste = false, shift = false) => {
    void state.keep();
    if (paste && p.onPaste) p.onPaste(state.out(), shift);
    else p.onCopy(state.out());
  };

  const blankOf = (name: string) => state.list().find((x) => x.name === name);
  const value = (name: string) => {
    const b = blankOf(name);
    return b ? state.value(b) : "";
  };
  const kind = (name: string): BlankKind => {
    const b = blankOf(name);
    return b ? state.kind(b) : "unfilled";
  };
  const isCode = () => (p.folder ? kindOf(p.folder) === "code" : false);

  const focusBlank = (name: string) => {
    setActiveBlank(name);
    const el = sideEl?.querySelector<HTMLElement>(`[data-blank-input="${CSS.escape(name)}"]`);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };

  const split = (
    <form
      class={`fill fill-split ${p.folder ? hueClass(p.folder) : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        done(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          p.onClose();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          done(!!p.onPaste, e.shiftKey);
        } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          done(false);
        }
      }}
    >
      <div class="fill-main">
        <div class="fill-head">
          <button type="button" class="btn small fill-back" onClick={p.onClose}>
            ← Back <kbd>Esc</kbd>
          </button>
          <Show when={p.folder}>
            <span class="lcard-where">
              <Mark folder={p.folder!} size={12} />
              {folderName(p.folder!)}
            </span>
          </Show>
          <span class="fill-title">{p.title}</span>
          <Show when={p.versionName}>
            <span class="scard-badge">{p.versionName}</span>
          </Show>
        </div>
        <div class="fill-text" classList={{ code: isCode() }}>
          <For each={parts(p.text)}>
            {(x) => {
              if (!x.blank) return x.text;
              const k = () => kind(x.text);
              const v = () => value(x.text);
              const shown = () => {
                const t = v() || x.text;
                return t.length > 160 ? `${t.slice(0, 160)}…` : t;
              };
              return (
                <button
                  type="button"
                  class={`blank-chip state-${k()}`}
                  classList={{ filled: k() !== "unfilled", active: activeBlank() === x.text }}
                  title={`Jump to ${x.text}`}
                  onClick={() => focusBlank(x.text)}
                  onMouseEnter={() => setActiveBlank(x.text)}
                >
                  {shown()}
                </button>
              );
            }}
          </For>
        </div>
        <div class="fill-legend">
          <span>Click any chip to jump to its field.</span>
          <span class="blank-legend-dots">
            <span><i class="bdot empty" /> empty</span>
            <span><i class="bdot auto" /> auto / default</span>
            <span><i class="bdot typed" /> typed</span>
          </span>
        </div>
      </div>
      <aside class="fill-side" ref={sideEl}>
        <div class="side-head">Fill in ({state.list().length})</div>
        <BlankFields
          state={state}
          side
          initialBlank={p.initialBlank}
          activeBlank={activeBlank()}
          onActiveBlank={setActiveBlank}
          selectionApp={p.targetApp}
          onClearSelection={p.onClearSelection}
        />
        <span class="grow" />
        <Show when={p.targetApp && p.onPaste}>
          <button type="button" class="btn primary wide big" onClick={() => done(true, false)}>
            Paste into {p.targetApp} <kbd>Ctrl ↵</kbd>
          </button>
        </Show>
        <button type="submit" class={p.targetApp && p.onPaste ? "btn wide" : "btn primary wide big"}>
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
        done(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          p.onClose();
        } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement && !e.ctrlKey)) {
          e.preventDefault();
          done(false);
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
