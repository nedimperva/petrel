// Filling in the blanks inside the text itself: the prompt is shown as it will be pasted, and each `{{blank}}` is
// a place in it you type into. Tab goes to the next blank, a default is there already and selected (typing
// replaces it), a choice shows its options in place (1–4 or ← → pick), the clipboard and the selection fill
// themselves. Up and Down bring back earlier answers. Enter copies; Ctrl Enter pastes too; Esc goes back. Used by
// the picker and by Ctrl C on a card in the library, so a prompt fills in the same way everywhere.

import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { parts, type Blank } from "../blanks";
import type { Version } from "./versions";
import { createBlanks } from "./BlankFields";
import { KeyHints } from "../ui";

export type PasteMode = "" | "plain" | "shift";

const LONG_NAME = /^(code|text|diff|commits|body|notes|clipboard|selection)$/i;

export default function InlineFill(p: {
  title: string;
  /** Where it lives, said quietly before the title. */
  where?: string;
  text: string;
  /** `{{selection}}`: what was selected in the app you were in. */
  selection?: string | null;
  versions?: Version[];
  version?: number;
  onVersion?(i: number): void;
  onCopy(text: string, paste: PasteMode): void;
  onClose(): void;
  /** Whether Ctrl Enter (paste into the app in front) is offered. */
  canPaste?: boolean;
  /** What Enter does, in a word: copy, or run for a prompt on a note. */
  action?: string;
}) {
  const state = createBlanks(
    () => p.text,
    () => p.selection,
  );
  let root!: HTMLFormElement;
  const [here, setHere] = createSignal<string | null>(null);
  const byName = createMemo(() => new Map(state.list().map((b) => [b.name, b] as const)));
  // Each blank is typed in where it first appears; later uses of the same name show what was typed there.
  const pieces = createMemo(() => {
    const seen = new Set<string>();
    return parts(p.text).map((x) => {
      if (!x.blank) return { kind: "text" as const, text: x.text };
      const first = !seen.has(x.text);
      seen.add(x.text);
      return { kind: first ? ("blank" as const) : ("echo" as const), name: x.text };
    });
  });

  const stops = () => [...root.querySelectorAll<HTMLElement>("[data-stop]")];
  const go = (by: number) => {
    const all = stops();
    if (!all.length) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + by + all.length) % all.length].focus();
  };

  const done = (paste: PasteMode) => {
    void state.keep();
    p.onCopy(state.out(), paste);
  };

  // Up and Down: the last answers for this name, as on the old fields.
  const [back, setBack] = createSignal<Record<string, number>>({});
  const step = (b: Blank, by: number) => {
    const past = state.memory()[b.name] ?? [];
    if (!past.length) return false;
    const i = Math.min(past.length - 1, Math.max(-1, (back()[b.name] ?? (past[0] === state.value(b) ? 0 : -1)) + by));
    setBack({ ...back(), [b.name]: i });
    state.set(b.name, i < 0 ? "" : past[i]);
    return true;
  };

  const key = (e: KeyboardEvent) => {
    const name = (e.target as HTMLElement).closest<HTMLElement>("[data-stop]")?.dataset.stop;
    const b = name ? byName().get(name) : undefined;
    if (e.key === "Escape") p.onClose();
    else if (e.key === "Tab") go(e.shiftKey ? -1 : 1);
    else if (e.key === "Enter" && !(e.shiftKey && !e.ctrlKey)) done(e.ctrlKey && p.canPaste ? (e.shiftKey ? "shift" : "plain") : "");
    else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && (p.versions?.length ?? 0) > 1) {
      const n = p.versions!.length;
      p.onVersion?.(((p.version ?? 0) + (e.key === "ArrowLeft" ? n - 1 : 1)) % n);
      setTimeout(() => stops()[0]?.focus());
    } else if (b?.choices && !e.ctrlKey && !e.altKey) {
      const at = b.choices.indexOf(state.value(b));
      const n = Number(e.key);
      if (n >= 1 && n <= b.choices.length) state.set(b.name, b.choices[n - 1]);
      else if (e.key === "ArrowRight" || e.key === " ") state.set(b.name, b.choices[(at + 1) % b.choices.length]);
      else if (e.key === "ArrowLeft") state.set(b.name, b.choices[(at - 1 + b.choices.length) % b.choices.length]);
      else return;
    } else if (b && !b.choices && !state.value(b).includes("\n") && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (!step(b, e.key === "ArrowUp" ? 1 : -1)) return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  onMount(() => setTimeout(() => stops()[0]?.focus()));

  const hint = () => {
    const b = here() ? byName().get(here()!) : undefined;
    if (!b) return "";
    if (b.choices) return `${b.name} · ${b.choices.map((c, i) => `${i + 1} ${c}`).join(" · ")}`;
    if (b.auto) return `${b.name} · ${b.auto === "today" ? "today's date" : b.auto === "clipboard" ? "from the clipboard" : "what you had selected"}`;
    const past = (state.memory()[b.name] ?? []).filter((m) => m !== state.value(b));
    return past.length ? `${b.name} · earlier: ${past.slice(0, 3).map((m) => (m.length > 24 ? `${m.slice(0, 24)}…` : m)).join(", ")}` : b.name;
  };
  const count = () => {
    const names = state.list().map((b) => b.name);
    const i = here() ? names.indexOf(here()!) : -1;
    return names.length > 1 && i >= 0 ? `${i + 1} of ${names.length}` : "";
  };

  return (
    <form
      class="ifill"
      ref={root}
      onSubmit={(e) => {
        e.preventDefault();
        done("");
      }}
      on:keydown={key}
    >
      <div class="ifill-head">
        <Show when={p.where}>
          <button type="button" class="ifill-back" onClick={() => p.onClose()} title="Back (Esc)">
            ‹ {p.where}
          </button>
        </Show>
        <span class="ifill-title">{p.title}</span>
        <span class="grow" />
        <Show when={(p.versions?.length ?? 0) > 1}>
          <span class="ifill-versions" title="Alt ← → other versions">
            <For each={p.versions}>
              {(v, i) => (
                <button type="button" classList={{ on: i() === (p.version ?? 0) }} onClick={() => p.onVersion?.(i())}>
                  {v.name}
                </button>
              )}
            </For>
          </span>
        </Show>
      </div>
      <div class="ifill-text">
        <For each={pieces()}>
          {(x) =>
            x.kind === "text" ? (
              x.text
            ) : x.kind === "echo" ? (
              <span class="ib echo">{state.value(byName().get(x.name)!) || x.name}</span>
            ) : (
              <Field name={x.name} />
            )
          }
        </For>
      </div>
      <div class="ifill-hint">
        <span>{hint()}</span>
        <span class="ifill-count">{count()}</span>
      </div>
      <footer class="ifill-foot">
        <KeyHints
          hints={[
            ["Enter", p.action ?? "copy"],
            p.canPaste && ["Ctrl Enter", "paste it"],
            state.list().length > 1 && ["Tab", "next blank"],
            state.list().some((b) => b.choices) && ["1–4", "pick"],
            (p.versions?.length ?? 0) > 1 && ["Alt ← →", "version"],
          ]}
        />
        <span class="grow" />
        <KeyHints hints={[["Esc", "back"]]} />
      </footer>
    </form>
  );

  function Field(f: { name: string }) {
    const b = () => byName().get(f.name);
    const value = () => (b() ? state.value(b()!) : "");
    return (
      <Show
        when={!b()?.choices}
        fallback={
          <span
            class="ib choice"
            data-stop={f.name}
            tabIndex={0}
            role="radiogroup"
            aria-label={f.name}
            onFocus={() => setHere(f.name)}
          >
            <For each={b()!.choices}>
              {(c, i) => (
                <span
                  class="ib-opt"
                  role="radio"
                  aria-checked={value() === c}
                  classList={{ on: value() === c }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => state.set(f.name, c)}
                >
                  <sup>{i() + 1}</sup>
                  {c}
                </span>
              )}
            </For>
          </span>
        }
      >
        <TextField name={f.name} value={value()} long={LONG_NAME.test(f.name) || value().includes("\n")} />
      </Show>
    );
  }

  function TextField(f: { name: string; value: string; long: boolean }) {
    let el!: HTMLSpanElement;
    // The span is typed into directly; what Up, Down or another version puts there is written back only when it
    // differs, so the caret stays where it is while typing.
    createEffect(() => {
      if (el.textContent !== f.value) el.textContent = f.value;
    });
    const selectAll = () => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    };
    return (
      <span
        ref={el}
        class="ib typed"
        classList={{ long: f.long, unfilled: !f.value }}
        data-stop={f.name}
        data-name={f.name}
        contentEditable="plaintext-only"
        role="textbox"
        aria-label={f.name}
        spellcheck={false}
        tabIndex={0}
        onFocus={() => {
          setHere(f.name);
          setTimeout(selectAll);
        }}
        onInput={() => state.set(f.name, (el.textContent ?? "").replace(/\n$/, ""))}
        onPaste={(e) => {
          // Plain text only, whatever the source had.
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData?.getData("text/plain") ?? "");
        }}
      />
    );
  }
}
