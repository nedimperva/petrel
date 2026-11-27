// Inline template renderer: shows a prompt or snippet with `{{blanks}}` editable RIGHT INSIDE the text.
// No popup Sheet modal, no full-screen FillBlanks swap: Tab jumps between blanks, ↑/↓ steps through remembered
// answers, choices (`{{tone: formal / casual}}`) cycle or pick inline, Enter submits (copy/paste).

import { createSignal, For, Show } from "solid-js";
import { parts, type Blank } from "../blanks";
import type { BlankState } from "./BlankFields";

export default function InlineTemplate(p: {
  text: string;
  state: BlankState;
  code?: boolean;
  /** Called on Enter (plain) or Ctrl+Enter (paste). */
  onSubmit(paste: boolean, shift: boolean): void;
  /** Optional Escape handler when focused inside an inline blank. */
  onEscape?(): void;
  /** Render plain non-blank text pieces (e.g. with search highlights). */
  renderText?: (text: string) => unknown;
}) {
  const [back, setBack] = createSignal<Record<string, number>>({});
  const [focused, setFocused] = createSignal<string | null>(null);

  const blankOf = (name: string): Blank | undefined => p.state.list().find((x) => x.name === name);

  const stepMemory = (b: Blank, by: number): boolean => {
    const past = p.state.memory()[b.name] ?? [];
    if (!past.length) return false;
    const i = Math.min(past.length - 1, Math.max(-1, (back()[b.name] ?? (past[0] === p.state.value(b) ? 0 : -1)) + by));
    setBack({ ...back(), [b.name]: i });
    p.state.set(b.name, i < 0 ? "" : past[i]);
    return true;
  };

  const activeBlankObj = () => {
    const name = focused();
    return name ? blankOf(name) : undefined;
  };

  const pastOf = (b: Blank) => (p.state.memory()[b.name] ?? []).filter((m) => m !== p.state.value(b));

  return (
    <div class="inline-tpl-wrap">
      <div class="inline-tpl" classList={{ code: !!p.code }}>
        <For each={parts(p.text)}>
          {(seg) => {
            if (!seg.blank) return (p.renderText ? p.renderText(seg.text) : seg.text) as never;
            const b = () => blankOf(seg.text);
            const val = () => (b() ? p.state.value(b()!) : "");
            const k = () => (b() ? p.state.kind(b()!) : "unfilled");
            return (
              <Show
                when={!b()?.choices}
                fallback={
                  <span class="inline-choice-group" role="radiogroup" aria-label={seg.text}>
                    <For each={b()!.choices}>
                      {(choice, idx) => (
                        <button
                          type="button"
                          role="radio"
                          data-inline-blank={seg.text}
                          aria-checked={val() === choice}
                          class="inline-choice"
                          classList={{ on: val() === choice }}
                          onFocus={() => setFocused(seg.text)}
                          onClick={() => p.state.set(seg.text, choice)}
                          onKeyDown={(e) => {
                            const n = Number(e.key);
                            if (n >= 1 && n <= b()!.choices!.length) {
                              e.preventDefault();
                              e.stopPropagation();
                              p.state.set(seg.text, b()!.choices![n - 1]);
                            } else if (e.key === "Enter") {
                              e.preventDefault();
                              e.stopPropagation();
                              p.onSubmit(e.ctrlKey || e.metaKey, e.shiftKey);
                            } else if (e.key === "Escape" && p.onEscape) {
                              e.preventDefault();
                              e.stopPropagation();
                              p.onEscape();
                            }
                          }}
                          title={`${seg.text}: ${choice} (${idx() + 1})`}
                        >
                          {choice}
                        </button>
                      )}
                    </For>
                  </span>
                }
              >
                <input
                  type="text"
                  data-inline-blank={seg.text}
                  class={`inline-blank state-${k()}`}
                  aria-label={seg.text}
                  placeholder={b()?.value || seg.text}
                  value={val()}
                  style={{ width: `${Math.max(seg.text.length + 2, Math.min(34, (val() || b()?.value || seg.text).length + 2))}ch` }}
                  onFocus={() => setFocused(seg.text)}
                  onBlur={() => setTimeout(() => focused() === seg.text && setFocused(null), 150)}
                  onInput={(e) => p.state.set(seg.text, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    const obj = b();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      p.onSubmit(e.ctrlKey || e.metaKey, e.shiftKey);
                    } else if (e.key === "Escape" && p.onEscape) {
                      e.preventDefault();
                      e.stopPropagation();
                      p.onEscape();
                    } else if (obj && e.key === "ArrowUp" && stepMemory(obj, 1)) {
                      e.preventDefault();
                      e.stopPropagation();
                    } else if (obj && e.key === "ArrowDown" && stepMemory(obj, -1)) {
                      e.preventDefault();
                      e.stopPropagation();
                    }
                  }}
                />
              </Show>
            );
          }}
        </For>
      </div>
      {/* Quiet contextual strip only when the focused blank has remembered answers */}
      <Show when={(() => {
        const b = activeBlankObj();
        if (!b || b.auto) return null;
        const list = pastOf(b);
        return list.length ? { name: b.name, list } : null;
      })()}>
        {(past) => (
          <div class="inline-past" aria-label="Earlier answers">
            <span class="muted small">{past().name}:</span>
            <For each={past().list.slice(0, 4)}>
              {(m) => (
                <button
                  type="button"
                  class="chip small"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    p.state.set(past().name, m);
                  }}
                >
                  {m.length > 36 ? `${m.slice(0, 36)}…` : m}
                </button>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}
