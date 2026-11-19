// "New collection" in the sidebar: a name and the one choice that changes how it behaves, things to copy (prompts,
// snippets: in the picker, Ctrl C copies them) or pages (notes you read and write, found with Ctrl K). A colour if
// you like. Enter makes the folder, keeps the choice in its `.petrel`, opens it and starts the first note in it.
// The kind starts from the name ("Prompts" is to copy) until you choose.

import { createSignal, For } from "solid-js";
import { COLORS, toCopy } from "../library/faces";

export interface NewCollectionChoice {
  name: string;
  copy: boolean;
  color: string;
}

export default function NewCollection(p: { onMake(c: NewCollectionChoice): void; onCancel(): void }) {
  const [name, setName] = createSignal("");
  const [chosen, setChosen] = createSignal<boolean | null>(null);
  const [color, setColor] = createSignal("");
  // Until a kind is chosen, it follows the name, as a folder made outside Petrel would.
  const copy = () => chosen() ?? (name().trim() ? toCopy(name().trim()) : true);
  let box!: HTMLDivElement;

  const make = () => {
    const n = name().trim();
    if (!n) return p.onCancel();
    p.onMake({ name: n, copy: copy(), color: color() });
  };

  const key = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") make();
    else if (e.key === "Escape") p.onCancel();
    else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "1" || e.key === "2"))
      setChosen(e.key === "ArrowUp" || e.key === "1");
    else if (e.target instanceof HTMLInputElement) return;
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") setChosen(e.key === "ArrowUp");
    else return;
    e.preventDefault();
  };

  return (
    <div
      class="newcoll"
      ref={box}
      on:keydown={key}
      onFocusOut={(e) => {
        // Clicking away with nothing typed is a cancel; with a name, the panel waits for Enter.
        if (!box.contains(e.relatedTarget as Node) && !name().trim()) p.onCancel();
      }}
    >
      <input
        class="newcoll-name"
        aria-label="New collection's name"
        placeholder="Name"
        value={name()}
        ref={(el) => setTimeout(() => el.focus())}
        onInput={(e) => setName(e.currentTarget.value)}
      />
      <div class="newcoll-kinds" role="radiogroup" aria-label="Kind">
        <button type="button" role="radio" aria-checked={copy()} class="newcoll-kind" classList={{ on: copy() }} onClick={() => setChosen(true)}>
          <span class="newcoll-kind-name">Things to copy</span>
          <span class="newcoll-kind-what">Prompts, snippets, replies. In the picker; Ctrl C copies.</span>
        </button>
        <button type="button" role="radio" aria-checked={!copy()} class="newcoll-kind" classList={{ on: !copy() }} onClick={() => setChosen(false)}>
          <span class="newcoll-kind-name">Pages</span>
          <span class="newcoll-kind-what">Notes you read and write. Found with Ctrl K.</span>
        </button>
      </div>
      <div class="newcoll-colors" role="radiogroup" aria-label="Colour">
        <For each={COLORS}>
          {(c) => (
            <button
              type="button"
              role="radio"
              aria-checked={color() === c.id}
              aria-label={c.label}
              title={c.label}
              class={`newcoll-color hue-${c.id}`}
              classList={{ on: color() === c.id }}
              onClick={() => setColor(color() === c.id ? "" : c.id)}
            />
          )}
        </For>
      </div>
      <div class="newcoll-foot">
        <button type="button" class="newcoll-make" onClick={make}>
          Make it <kbd>Enter</kbd>
        </button>
        <span class="grow" />
        <span class="muted">
          <kbd>Alt ↑ ↓</kbd> kind
        </span>
      </div>
    </div>
  );
}
