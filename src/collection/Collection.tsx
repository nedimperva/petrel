// A collection: a folder of notes shown as cards. Prompts, snippets, songs and topics all work the same way: `c`
// or the Copy button copies (asking for the blanks first if it has any), Enter opens, the most copied come first.

import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { api, type NoteSummary } from "../api";
import { parts } from "../blanks";
import { ago, Empty, folderName, Kbd, typing } from "../ui";
import { copyFilled, itemText } from "./copyItem";
import FillBlanks from "./FillBlanks";

export default function Collection(p: { folder: string; onOpen(id: number): void; onNew(): void }) {
  const [rev, setRev] = createSignal(0);
  const [data] = createResource(
    () => [p.folder, rev()] as const,
    async ([folder]) => {
      const s = await api();
      const [items, counts] = await Promise.all([s.listNotes({ folder, limit: 1000 }), s.copyCounts()]);
      return { items, counts };
    },
  );
  const [q, setQ] = createSignal("");
  const [at, setAt] = createSignal(0);
  const [filling, setFilling] = createSignal<{ item: NoteSummary; text: string } | null>(null);
  let search!: HTMLInputElement;

  const items = createMemo(() => {
    const d = data();
    if (!d) return [];
    const text = q().trim().toLowerCase();
    return d.items
      .filter((n) => !text || (n.title + " " + n.preview + " " + n.tags.join(" ")).toLowerCase().includes(text))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (d.counts[b.path] ?? 0) - (d.counts[a.path] ?? 0) || b.modifiedAt - a.modifiedAt);
  });
  const copies = (n: NoteSummary) => data()?.counts[n.path] ?? 0;

  async function copy(n: NoteSummary) {
    const it = await itemText(n.id);
    if (it.hasBlanks) return setFilling({ item: n, text: it.text });
    if (await copyFilled(n, it.text)) setRev(rev() + 1);
  }

  const cols = () => Math.max(1, Math.floor((document.querySelector(".cards")?.clientWidth ?? 900) / 300));
  const key = (e: KeyboardEvent) => {
    if (filling() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing(e)) {
      if (e.target === search && (e.key === "ArrowDown" || e.key === "Enter")) {
        e.preventDefault();
        search.blur();
      } else if (e.target === search && e.key === "Escape") {
        setQ("");
        search.blur();
      }
      return;
    }
    const n = items().length;
    const cur = items()[at()];
    switch (e.key) {
      case "ArrowRight":
      case "l":
        setAt(Math.min(at() + 1, n - 1));
        break;
      case "ArrowLeft":
      case "h":
        setAt(Math.max(at() - 1, 0));
        break;
      case "ArrowDown":
      case "j":
        setAt(Math.min(at() + cols(), n - 1));
        break;
      case "ArrowUp":
      case "k":
        setAt(Math.max(at() - cols(), 0));
        break;
      case "c":
        if (cur) void copy(cur);
        break;
      case "Enter":
        if (cur) p.onOpen(cur.id);
        break;
      case "/":
        search.focus();
        break;
      case "n":
        p.onNew();
        break;
      default:
        return;
    }
    e.preventDefault();
    document.querySelector(".card.on")?.scrollIntoView({ block: "nearest" });
  };
  document.addEventListener("keydown", key);
  onCleanup(() => document.removeEventListener("keydown", key));

  return (
    <div class="collection">
      <div class="col-head">
        <div>
          <h1>{folderName(p.folder)}</h1>
          <p class="muted">
            {items().length} {items().length === 1 ? "item" : "items"} · most used first · <Kbd keys="C" /> copies, <Kbd keys="Enter" /> opens
          </p>
        </div>
        <span class="grow" />
        <input ref={search} class="search small" placeholder={`Filter ${folderName(p.folder)}…  /`} value={q()} onInput={(e) => (setQ(e.currentTarget.value), setAt(0))} />
        <button class="btn" onClick={p.onNew}>
          New <kbd>N</kbd>
        </button>
      </div>
      <Show when={items().length} fallback={<Empty title={q() ? "Nothing matches" : "Nothing here yet"}><p class="muted">Each item is a Markdown file in {folderName(p.folder)}. Write <code>{"{{name}}"}</code> where a blank should go.</p></Empty>}>
        <div class="cards">
          <For each={items()}>
            {(n, i) => (
              <article class="card item" classList={{ on: i() === at() }} onClick={() => setAt(i())} onDblClick={() => p.onOpen(n.id)}>
                <header>
                  <h3>{n.title}</h3>
                  <button class="btn small copy" onClick={(e) => (e.stopPropagation(), void copy(n))}>
                    Copy <kbd>C</kbd>
                  </button>
                </header>
                <p class="card-text">
                  <For each={parts(n.preview)}>{(x) => (x.blank ? <span class="chip blank">{x.text}</span> : x.text)}</For>
                </p>
                <footer>
                  <Show when={n.tags.length}>
                    <span class="tags">{n.tags.map((t) => `#${t}`).join(" ")}</span>
                  </Show>
                  <span class="grow" />
                  <span>{copies(n) ? `copied ${copies(n)}×` : ago(n.modifiedAt)}</span>
                </footer>
              </article>
            )}
          </For>
        </div>
      </Show>
      <Show when={filling()}>
        {(f) => (
          <FillBlanks
            title={f().item.title}
            text={f().text}
            onClose={() => setFilling(null)}
            onCopy={async (text) => {
              setFilling(null);
              if (await copyFilled(f().item, text)) setRev(rev() + 1);
            }}
          />
        )}
      </Show>
    </div>
  );
}
