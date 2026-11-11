// The fields for a text's blanks, shared by the sheet, the fill-in dialog and the picker. A field starts with
// its default, or fills itself (`{{clipboard}}`, `{{today}}`, `{{selection}}`), or starts with the last answer
// given for that name; Up and Down step through the last five, which are also chips to click. A choice
// (`{{tone: formal / casual}}`) is a row of options picked with the number keys. Answers are kept in the
// database's UI settings (`ui.blanks`), never in the notes.

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { api } from "../api";
import { blanks, fill, rememberAnswers, startValue, todayText, type Auto, type Blank } from "../blanks";

const ANSWERS = "ui.blanks";
const VERSIONS = "ui.versions";

async function setting<T>(key: string, fallback: T): Promise<T> {
  try {
    const v = (await (await api()).uiSettings())[key];
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The version of each note copied last, by path. */
export const lastVersions = () => setting<Record<string, string>>(VERSIONS, {});

export async function keepVersion(path: string, name: string) {
  const all = await lastVersions();
  if (all[path] === name) return;
  all[path] = name;
  await (await api()).setUiSetting(VERSIONS, JSON.stringify(all)).catch(() => {});
}

export interface BlankState {
  list(): Blank[];
  value(b: Blank): string;
  set(name: string, v: string): void;
  /** The text with the blanks filled. */
  out(): string;
  memory(): Record<string, string[]>;
  /** After a copy: keeps the answers for next time. */
  keep(): Promise<void>;
}

/** Values for the blanks of `text`, which may change (another version): what was typed stays per name. */
export function createBlanks(text: () => string, selection?: () => string | null | undefined): BlankState {
  const [memory, setMemory] = createSignal<Record<string, string[]>>({});
  const [auto, setAuto] = createSignal<Partial<Record<Auto, string>>>({ today: todayText() });
  const [typed, setTyped] = createSignal<Record<string, string>>({});
  const list = createMemo(() => blanks(text()));
  void setting<Record<string, string[]>>(ANSWERS, {}).then(setMemory);
  let clipboard = false;
  createEffect(() => {
    // The clipboard is read only when a blank asks for it.
    if (!clipboard && list().some((b) => b.auto === "clipboard")) {
      clipboard = true;
      void api()
        .then((s) => s.readClipboard())
        .then((c) => setAuto((a) => ({ ...a, clipboard: c.replace(/\s+$/, "") })), () => {});
    }
    const sel = selection?.();
    if (sel) setAuto((a) => (a.selection === sel ? a : { ...a, selection: sel }));
  });
  const value = (b: Blank) => typed()[b.name] ?? startValue(b, memory()[b.name], auto());
  const values = () => Object.fromEntries(list().map((b) => [b.name, value(b)]));
  return {
    list,
    value,
    set: (name, v) => setTyped((t) => ({ ...t, [name]: v })),
    out: () => fill(text(), values()),
    memory,
    async keep() {
      const next = rememberAnswers(await setting<Record<string, string[]>>(ANSWERS, {}), list(), values());
      setMemory(next);
      await (await api()).setUiSetting(ANSWERS, JSON.stringify(next)).catch(() => {});
    },
  };
}

const LONG = /^(code|text|diff|commits|body|notes|clipboard|selection)$/i;

export default function BlankFields(p: { state: BlankState; side?: boolean; focusFirst?: boolean }) {
  // How far back Up has gone, per field.
  const [back, setBack] = createSignal<Record<string, number>>({});
  const step = (b: Blank, by: number) => {
    const past = p.state.memory()[b.name] ?? [];
    if (!past.length) return false;
    const i = Math.min(past.length - 1, Math.max(-1, (back()[b.name] ?? (past[0] === p.state.value(b) ? 0 : -1)) + by));
    setBack({ ...back(), [b.name]: i });
    p.state.set(b.name, i < 0 ? "" : past[i]);
    return true;
  };
  const focus = (i: number) => (el: HTMLElement) => i === 0 && p.focusFirst !== false && setTimeout(() => el.focus());

  return (
    <For each={p.state.list()}>
      {(b, i) => (
        <div class={p.side ? "side-field" : "fill-field"}>
          {p.side ? <span>{b.name}</span> : <span class="chip blank">{b.name}</span>}
          <div class="blank-control">
            <Show
              when={!b.choices}
              fallback={
                <div
                  class="choices"
                  tabIndex={0}
                  role="radiogroup"
                  aria-label={b.name}
                  ref={focus(i())}
                  onKeyDown={(e) => {
                    const n = Number(e.key);
                    if (n >= 1 && n <= b.choices!.length) {
                      e.preventDefault();
                      e.stopPropagation();
                      p.state.set(b.name, b.choices![n - 1]);
                    }
                  }}
                >
                  <For each={b.choices}>
                    {(c, k) => (
                      <button
                        type="button"
                        class="chip"
                        role="radio"
                        aria-checked={p.state.value(b) === c}
                        classList={{ on: p.state.value(b) === c }}
                        tabIndex={-1}
                        onClick={() => p.state.set(b.name, c)}
                      >
                        <kbd>{k() + 1}</kbd> {c}
                      </button>
                    )}
                  </For>
                </div>
              }
            >
              {LONG.test(b.name) ? (
                <textarea
                  rows={3}
                  value={p.state.value(b)}
                  ref={focus(i())}
                  onInput={(e) => p.state.set(b.name, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    // In a long field Up moves the caret; it steps back only from the very start.
                    if (e.key === "ArrowUp" && e.currentTarget.selectionStart === 0 && step(b, 1)) e.preventDefault();
                  }}
                />
              ) : (
                <input
                  value={p.state.value(b)}
                  ref={focus(i())}
                  onInput={(e) => p.state.set(b.name, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if ((e.key === "ArrowUp" && step(b, 1)) || (e.key === "ArrowDown" && step(b, -1))) e.preventDefault();
                  }}
                />
              )}
              <Show when={b.auto}>
                <span class="blank-hint">
                  {b.auto === "today" ? "today's date" : b.auto === "clipboard" ? "from the clipboard" : "what you had selected"}
                </span>
              </Show>
              <Show when={!b.auto && (p.state.memory()[b.name] ?? []).filter((m) => m !== p.state.value(b)).length}>
                <div class="blank-past" title="Earlier answers (↑ ↓)">
                  <For each={(p.state.memory()[b.name] ?? []).filter((m) => m !== p.state.value(b))}>
                    {(m) => (
                      <button type="button" class="chip small" tabIndex={-1} onClick={() => p.state.set(b.name, m)}>
                        {m.length > 40 ? `${m.slice(0, 40)}…` : m}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      )}
    </For>
  );
}
