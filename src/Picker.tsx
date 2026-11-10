// The quick picker (`petrel --picker`, Ctrl Alt V): find a prompt, snippet or any note, fill its blanks, and Enter
// copies it and closes, so the paste goes where you were. Ctrl O opens it in Petrel instead.

import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { api, type NoteSummary } from "./api";
import { parts } from "./blanks";
import FillBlanks from "./collection/FillBlanks";
import { copyFilled, itemText } from "./collection/copyItem";
import { applyPrefs, parsePrefs } from "./settings/prefs";
import { folderName } from "./ui";

export default function Picker() {
  let input!: HTMLInputElement;
  const [q, setQ] = createSignal("");
  const [i, setI] = createSignal(0);
  const [filling, setFilling] = createSignal<{ item: NoteSummary; text: string } | null>(null);
  const [data] = createResource(async () => {
    const s = await api();
    const [all, counts] = await Promise.all([s.listNotes({ limit: 2000 }), s.copyCounts()]);
    return { all: all.filter((n) => n.folder !== "inbox"), counts };
  });

  const rows = () => {
    const d = data();
    if (!d) return [];
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    const score = (n: NoteSummary) => {
      const t = n.title.toLowerCase();
      let s = d.counts[n.path] ?? 0;
      // Collections (folders) before loose notes: the picker is mostly for prompts and snippets.
      if (n.folder) s += 2;
      for (const w of words) s += t.startsWith(w) ? 30 : t.includes(w) ? 15 : 0;
      return s;
    };
    return d.all
      .filter((n) => words.every((w) => (n.title + " " + n.folder + " " + n.preview).toLowerCase().includes(w)))
      .sort((a, b) => score(b) - score(a) || b.modifiedAt - a.modifiedAt)
      .slice(0, 40);
  };

  const close = async () => (await api()).closePicker();

  async function pick(n: NoteSummary | undefined) {
    if (!n) return;
    const it = await itemText(n.id);
    if (it.hasBlanks) return setFilling({ item: n, text: it.text });
    if (await copyFilled(n, it.text)) await close();
  }

  const key = async (e: KeyboardEvent) => {
    const n = rows().length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setI((i() + 1) % Math.max(1, n));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setI((i() + n - 1) % Math.max(1, n));
    else if (e.key === "Enter") void pick(rows()[i()]);
    else if (e.ctrlKey && e.key.toLowerCase() === "o") {
      const r = rows()[i()];
      if (r) await (await api()).showNoteInMain(r.id);
      await close();
    } else if (e.key === "Escape") void close();
    else return;
    e.preventDefault();
  };

  onMount(async () => {
    input?.focus();
    const s = await api();
    s.uiSettings().then((m) => applyPrefs(parsePrefs(m)), () => {});
    await s.showWindow();
    // Losing focus means the person went back to what they were doing: get out of the way.
    window.addEventListener("blur", () => !filling() && setTimeout(() => !document.hasFocus() && void close(), 150));
  });

  const sel = () => rows()[i()];

  return (
    <div class="picker">
      <Show
        when={!filling()}
        fallback={
          <FillBlanks
            inline
            title={filling()!.item.title}
            text={filling()!.text}
            onClose={() => setFilling(null)}
            onCopy={async (text) => {
              if (await copyFilled(filling()!.item, text)) await close();
            }}
          />
        }
      >
        <div class="palette-field">
          <span class="spark">⌕</span>
          <input
            class="palette-input"
            ref={input}
            placeholder="Find a prompt, snippet or note to copy…"
            value={q()}
            onInput={(e) => (setQ(e.currentTarget.value), setI(0))}
            onKeyDown={key}
          />
        </div>
        <div class="picker-body">
          <div class="palette-list">
            <For each={rows()}>
              {(n, k) => (
                <button class="palette-row" classList={{ on: k() === i() }} onMouseMove={() => setI(k())} onClick={() => pick(n)}>
                  <span class="row-label">{n.folder === "inbox" ? n.preview.split("\n")[0] : n.title}</span>
                  <span class="row-sub">{folderName(n.folder)}</span>
                </button>
              )}
            </For>
            <Show when={data() && !rows().length}>
              <p class="muted pad">Nothing matches.</p>
            </Show>
          </div>
          <Show when={sel()}>
            {(n) => (
              <div class="picker-peek">
                <p class="card-text">
                  <For each={parts(n().preview)}>{(x) => (x.blank ? <span class="chip blank">{x.text}</span> : x.text)}</For>
                </p>
              </div>
            )}
          </Show>
        </div>
        <footer class="picker-foot">
          <span>
            <kbd>Enter</kbd> copy and close
          </span>
          <span>
            <kbd>Tab</kbd> next blank
          </span>
          <span>
            <kbd>Ctrl O</kbd> open in Petrel
          </span>
          <span class="grow" />
          <span>
            <kbd>Esc</kbd>
          </span>
        </footer>
      </Show>
    </div>
  );
}
