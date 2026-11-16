// The trash, opened (Ctrl K › Trash): what is in `.trash/`, newest first, with a look at the highlighted one.
// Enter puts it back where it was and opens it. "Empty" deletes only what went more than thirty days ago, and asks
// once more first: it is the one place Petrel deletes a note for good.

import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { api, errText, type TrashItem } from "../api";
import { ago, folderName, KeyHints, say } from "../ui";

const OLD_DAYS = 30;

export default function Trash(p: { onClose(): void; onOpen(id: number): void; onChanged(): void }) {
  let input!: HTMLInputElement;
  const [items, setItems] = createSignal<TrashItem[] | null>(null);
  const [q, setQ] = createSignal("");
  const [i, setI] = createSignal(0);
  const [sure, setSure] = createSignal(false);

  const load = async () => {
    try {
      setItems(await (await api()).trashItems());
    } catch (e) {
      setItems([]);
      say(errText(e), { error: true });
    }
  };
  onMount(() => {
    input.focus();
    void load();
  });

  const shown = createMemo(() => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    return (items() ?? []).filter((t) => words.every((w) => `${t.title} ${t.from}`.toLowerCase().includes(w)));
  });
  const sel = () => shown()[i()];
  const old = () => (items() ?? []).filter((t) => t.at < Date.now() - OLD_DAYS * 864e5).length;
  const [peek] = createResource(
    () => sel()?.name,
    async (name) => (await api()).trashPeek(name).catch(() => ""),
  );
  const where = (t: TrashItem) => {
    const dir = t.from.includes("/") ? t.from.slice(0, t.from.lastIndexOf("/")) : "";
    return t.folder ? "a collection" : dir ? folderName(dir) : "Notes";
  };

  async function putBack(t: TrashItem | undefined) {
    if (!t) return;
    try {
      const id = await (await api()).trashRestore(t.name);
      p.onChanged();
      say(t.folder ? `Put back ${t.title}` : `Put back “${t.title}”`);
      if (id !== null) (p.onClose(), p.onOpen(id));
      else void load();
    } catch (e) {
      say(errText(e), { error: true });
      void load();
    }
  }

  async function empty() {
    if (!sure()) return setSure(true);
    setSure(false);
    try {
      const n = await (await api()).trashEmpty(OLD_DAYS);
      say(n === 1 ? "Deleted one thing for good" : `Deleted ${n} things for good`);
      setI(0);
      void load();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  const key = (e: KeyboardEvent) => {
    const n = shown().length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setI((i() + 1) % Math.max(1, n));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setI((i() + n - 1) % Math.max(1, n));
    else if (e.key === "Enter") void putBack(sel());
    else if (e.key === "Escape") sure() ? setSure(false) : p.onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class="scrim top" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="palette trash" classList={{ previewing: !!sel() }} role="dialog" aria-label="Trash">
        <div class="palette-field">
          <span class="spark">⌫</span>
          <input class="palette-input" ref={input} placeholder="The trash. Type to narrow…" value={q()} onInput={(e) => (setQ(e.currentTarget.value), setI(0))} onKeyDown={key} />
          <span class="muted small nowrap">{items() ? `${shown().length} in the trash` : ""}</span>
        </div>
        <div class="palette-body">
          <div class="palette-list">
            <For each={shown()}>
              {(t, k) => (
                <button class="palette-row" classList={{ on: k() === i() }} onMouseMove={() => setI(k())} onClick={() => void putBack(t)}>
                  <span class="row-icon">{t.folder ? "▤" : "¶"}</span>
                  <span class="row-two">
                    <span class="row-label">{t.title}</span>
                    <span class="row-used">
                      from {where(t)} · {ago(t.at)}
                    </span>
                  </span>
                </button>
              )}
            </For>
            <Show when={items() && !shown().length}>
              <p class="muted pad">{q() ? "Nothing in the trash has those words." : "The trash is empty."}</p>
            </Show>
          </div>
          <Show when={sel()}>
            {(t) => (
              <article class="palette-peek" aria-label={`Preview of ${t().title}`}>
                <p class="peek-meta">
                  {t().from} · trashed {ago(t().at)}
                </p>
                <h2 class="peek-title">{t().title}</h2>
                <For each={(peek() ?? "").split(/\n{2,}/).slice(0, 30)}>{(para) => <p class="peek-text">{para}</p>}</For>
              </article>
            )}
          </Show>
        </div>
        <footer class="picker-foot">
          <KeyHints hints={[["↑ ↓", "move"], ["Enter", "put back and open"]]} />
          <span class="grow" />
          <Show when={old()}>
            <button class="btn small" classList={{ danger: sure() }} onClick={() => void empty()}>
              {sure() ? `Delete ${old()} for good? Click again` : `Empty ${old()} older than ${OLD_DAYS} days`}
            </button>
          </Show>
          <KeyHints hints={[["Esc", "back"]]} />
        </footer>
      </div>
    </div>
  );
}
