// A collection's look and kind (`t` on a card in the library, or its mark on the shelf): one colour, one mark, and
// whether it holds things to copy (cards in the library and the picker) or pages. Saved at once to the folder's
// `.petrel` file, so the other computer gets it with the folder.

import { createSignal, For, onMount } from "solid-js";
import { errText } from "../api";
import { folderName, say } from "../ui";
import { COLORS, colorOf, MARKS, toCopy } from "./faces";
import { faces, saveFace } from "./Mark";

export default function FacePicker(p: { top: string; onClose(): void }) {
  let first!: HTMLButtonElement;
  onMount(() => first.focus());
  const current = () => faces()[p.top] ?? { color: "", mark: "" };
  const [color, setColor] = createSignal(current().color || colorOf(p.top, faces()));
  const [mark, setMark] = createSignal(current().mark || "dot");
  const [copy, setCopy] = createSignal(current().copy ?? "");

  async function save(c: string, m: string, k = copy()) {
    setColor(c);
    setMark(m);
    setCopy(k);
    try {
      await saveFace(p.top, { color: c, mark: m === "dot" ? "" : m, copy: k });
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  return (
    <div
      class="scrim"
      onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          p.onClose();
        }
      }}
    >
      <div class={`dialog face-picker hue-${color()}`} role="dialog" aria-label={`How ${folderName(p.top)} looks`}>
        <header class="dialog-head">
          <h2>{folderName(p.top)}</h2>
          <span class="grow" />
          <button class="btn" onClick={p.onClose}>
            Done <kbd>Esc</kbd>
          </button>
        </header>
        <h3 class="face-label">Holds</h3>
        <div class="seg" role="radiogroup" aria-label="What it holds">
          <button role="radio" aria-checked={toCopy(p.top, { [p.top]: { color: "", mark: "", copy: copy() } })} classList={{ on: toCopy(p.top, { [p.top]: { color: "", mark: "", copy: copy() } }) }} onClick={() => void save(color(), mark(), "yes")}>
            Things to copy
          </button>
          <button role="radio" aria-checked={!toCopy(p.top, { [p.top]: { color: "", mark: "", copy: copy() } })} classList={{ on: !toCopy(p.top, { [p.top]: { color: "", mark: "", copy: copy() } }) }} onClick={() => void save(color(), mark(), "no")}>
            Pages
          </button>
        </div>
        <p class="muted small">Things to copy are cards in the library and the quick picker. Pages are found with Ctrl K.</p>
        <h3 class="face-label">Colour</h3>
        <div class="face-colors" role="radiogroup" aria-label="Colour">
          <For each={COLORS}>
            {(c, i) => (
              <button
                ref={(el) => i() === 0 && (first = el)}
                class={`swatch hue-${c.id}`}
                classList={{ on: color() === c.id }}
                role="radio"
                aria-checked={color() === c.id}
                aria-label={c.label}
                title={c.label}
                onClick={() => void save(c.id, mark())}
              />
            )}
          </For>
        </div>
        <h3 class="face-label">Mark</h3>
        <div class="face-marks" role="radiogroup" aria-label="Mark">
          <For each={MARKS}>
            {(m) => (
              <button
                class="face-mark"
                classList={{ on: mark() === m.id }}
                role="radio"
                aria-checked={mark() === m.id}
                aria-label={m.label}
                title={m.label}
                onClick={() => void save(color(), m.id)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill={m.id === "dot" ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d={m.d} />
                </svg>
              </button>
            )}
          </For>
        </div>
        <p class="muted small">Kept in {p.top}/.petrel, so it moves and syncs with the folder.</p>
      </div>
    </div>
  );
}
