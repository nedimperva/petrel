// One collection, picked in the sidebar: only its cards, big. Things to copy (Prompts, Snippets) show their text,
// blanks, uses and where they were used last; Enter copies (a sheet first when there are blanks or versions).
// Pages (Travel, Work) are paper cards with the date, a serif title, a few lines and their open tasks; Enter reads
// one (Reader.tsx), e writes in it. Arrows move across the grid, the chips sort, typing filters.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { NoteSummary } from "../api";
import { blanks } from "../blanks";
import { loadUsed, type Used } from "../collection/lastUsed";
import { ago, folderName, KeyHints, typing, undoLast } from "../ui";
import { kindOf } from "./Card";
import { toCopy } from "./faces";
import Mark, { faces, hueClass } from "./Mark";
import { loadTaskCounts, tasksOf } from "./taskCounts";

type Order = "use" | "new" | "az" | "tasks";

const openTasks = (n: NoteSummary) => tasksOf(n.id);
const words = (n: NoteSummary) => (n.preview.match(/[\p{L}\p{N}]+/gu) ?? []).length;

/** A preview without Markdown marks, for a card. */
export const plain = (s: string) =>
  s
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*[-*] \[[ xX]\]\s*/gm, "")
    .replace(/^\s*[-*>]\s+/gm, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, l?: string) => l ?? t)
    .replace(/[*_`]/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();

/** A card's date: the weekday this week, else "11 Nov". */
export function shortDay(ms: number): string {
  const d = new Date(ms);
  if (Date.now() - ms < 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export default function Collection(p: {
  top: string;
  notes: NoteSummary[];
  copies: Record<string, number>;
  versions: Record<number, number>;
  onCopy(n: NoteSummary): void;
  onRead(id: number): void;
  onEdit(id: number): void;
  onNew(folder: string): void;
  onMove(n: NoteSummary): void;
  onPin(n: NoteSummary): void;
  onDelete(n: NoteSummary): void;
  /** Something over this (a sheet, a list) has the keys. */
  busy?: boolean;
}) {
  let filterInput!: HTMLInputElement;
  let gridEl: HTMLDivElement | undefined;
  const copy = () => toCopy(p.top, faces());
  const code = () => kindOf(p.top) === "code";
  const [q, setQ] = createSignal("");
  const [order, setOrder] = createSignal<Order>(copy() ? "use" : "new");
  const [sel, setSel] = createSignal(0);
  const [used, setUsed] = createSignal<Used>({});
  onMount(() => void loadUsed().then(setUsed, () => {}));
  // Again whenever the notes change (a tick, a move, an edit elsewhere).
  createEffect(on(() => p.notes, () => void loadTaskCounts()));
  createEffect(on(() => p.top, () => (setQ(""), setSel(0), setOrder(copy() ? "use" : "new")), { defer: true }));

  const uses = (n: NoteSummary) => p.copies[n.path] ?? 0;
  const shown = createMemo(() => {
    const w = q().toLowerCase().split(/\s+/).filter(Boolean);
    let ns = p.notes.filter((n) => w.every((x) => `${n.title} ${n.preview} ${n.tags.join(" ")}`.toLowerCase().includes(x)));
    if (order() === "tasks") ns = ns.filter((n) => openTasks(n) > 0);
    const pin = (a: NoteSummary, b: NoteSummary) => Number(b.pinned) - Number(a.pinned);
    if (order() === "az") return [...ns].sort((a, b) => a.title.localeCompare(b.title));
    if (order() === "use") return [...ns].sort((a, b) => pin(a, b) || uses(b) - uses(a) || b.modifiedAt - a.modifiedAt);
    return [...ns].sort((a, b) => pin(a, b) || b.modifiedAt - a.modifiedAt);
  });
  const current = () => shown()[Math.min(sel(), shown().length - 1)];
  const monthUses = () => p.notes.reduce((k, n) => k + uses(n), 0);
  const lastWritten = () => Math.max(0, ...p.notes.map((n) => n.modifiedAt));

  /** How many cards fit across now: the cards on the first card's row. */
  const across = () => {
    const cards = gridEl ? [...gridEl.querySelectorAll<HTMLElement>(".ccard")] : [];
    if (!cards.length) return 1;
    const top = cards[0].offsetTop;
    return Math.max(1, cards.filter((c) => c.offsetTop === top).length);
  };
  const go = (i: number) => {
    const n = shown().length;
    if (!n) return;
    const k = Math.max(0, Math.min(n - 1, i));
    setSel(k);
    queueMicrotask(() => gridEl?.querySelector(`[data-i="${k}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  const open = (n: NoteSummary | undefined) => n && (copy() ? p.onCopy(n) : p.onRead(n.id));

  const key = (e: KeyboardEvent) => {
    if (p.busy || e.ctrlKey || e.metaKey || e.altKey || document.querySelector(".scrim")) return;
    if (typing(e)) {
      if (e.target === filterInput && (e.key === "ArrowDown" || e.key === "Enter")) {
        e.preventDefault();
        filterInput.blur();
        go(0);
      } else if (e.target === filterInput && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setQ("");
        filterInput.blur();
      }
      return;
    }
    const n = current();
    switch (e.key) {
      case "ArrowRight":
      case "l":
        go(sel() + 1);
        break;
      case "ArrowLeft":
      case "h":
        go(sel() - 1);
        break;
      case "ArrowDown":
      case "j":
        go(sel() + across());
        break;
      case "ArrowUp":
      case "k":
        go(sel() - across());
        break;
      case "Enter":
        open(n);
        break;
      case "e":
        if (n) p.onEdit(n.id);
        break;
      case "c":
        if (n && copy()) p.onCopy(n);
        else return;
        break;
      case "m":
        if (n) p.onMove(n);
        break;
      case "p":
        if (n) p.onPin(n);
        break;
      case "d":
      case "Delete":
        if (n) p.onDelete(n);
        break;
      case "n":
        p.onNew(p.top);
        break;
      case "z":
        if (!undoLast()) return;
        break;
      case "/":
        filterInput.focus();
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          filterInput.focus();
          return;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => document.addEventListener("keydown", key));
  onCleanup(() => document.removeEventListener("keydown", key));

  const orders = (): [Order, string][] => (copy() ? [["use", "Most used"], ["new", "Lately"], ["az", "A–Z"]] : [["new", "Newest"], ["az", "A–Z"], ["tasks", "Open tasks"]]);
  const lastUse = (n: NoteSummary) => {
    const u = used()[n.path];
    return u ? `${u[0]} · ${ago(u[1])}` : "";
  };

  return (
    <div class={`collection ${hueClass(p.top)}`}>
      <header class="coll-head">
        <Mark folder={p.top} class="tile big" />
        <span class="coll-name">
          <h1>{folderName(p.top)}</h1>
          <span class="muted small">
            {copy()
              ? `${p.notes.length} to copy${monthUses() ? ` · copied ${monthUses()} ${monthUses() === 1 ? "time" : "times"}` : ""}`
              : `${p.notes.length} ${p.notes.length === 1 ? "page" : "pages"}${lastWritten() ? ` · last written in ${ago(lastWritten())}` : ""}`}
          </span>
        </span>
        <span class="grow" />
        <span class="coll-chips" role="group" aria-label="Order">
          <For each={orders()}>
            {([id, label]) => (
              <button type="button" class="chip" classList={{ on: order() === id }} aria-pressed={order() === id} onClick={() => (setOrder(id), setSel(0))}>
                {label}
              </button>
            )}
          </For>
        </span>
        <label class="lib-filter coll-filter">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input ref={filterInput} placeholder={`Filter ${folderName(p.top)}`} aria-label={`Filter ${folderName(p.top)}`} value={q()} onInput={(e) => (setQ(e.currentTarget.value), setSel(0))} />
        </label>
        <button type="button" class="btn primary small" onClick={() => p.onNew(p.top)}>
          {copy() ? "New" : "New page"} <kbd>n</kbd>
        </button>
      </header>

      <div class="coll-grid" classList={{ pages: !copy(), code: copy() && code() }} ref={gridEl}>
        <For each={shown()}>
          {(n, i) => {
            const on = () => i() === Math.min(sel(), shown().length - 1);
            return (
              <button type="button" class="ccard" classList={{ on: on(), page: !copy(), code: copy() && code() }} data-i={i()} onMouseEnter={() => setSel(i())} onClick={() => open(n)} onDblClick={() => p.onEdit(n.id)}>
                <Show
                  when={copy()}
                  fallback={
                    <>
                      <span class="ccard-meta">
                        <span>{shortDay(n.modifiedAt)}</span>
                        <Show when={n.pinned}>
                          <span>· pinned</span>
                        </Show>
                        <span class="grow" />
                        <span>{words(n)} words</span>
                      </span>
                      <span class="ccard-title serif">{n.title}</span>
                      <span class="ccard-text serif">{plain(n.preview)}</span>
                      <span class="ccard-foot">
                        <Show when={openTasks(n)}>
                          {(k) => (
                            <span class="ccard-tasks">
                              {k()} open {k() === 1 ? "task" : "tasks"}
                            </span>
                          )}
                        </Show>
                        <span class="grow" />
                        <Show when={on()}>
                          <span class="ccard-go">
                            Read <kbd>Enter</kbd>
                          </span>
                        </Show>
                      </span>
                    </>
                  }
                >
                  <Show when={!code()}>
                    <span class="ccard-band" aria-hidden="true" />
                  </Show>
                  <span class="ccard-top">
                    <span class="ccard-title">{n.title}</span>
                    <Show when={n.pinned}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" role="img" aria-label="Pinned" class="ccard-pin">
                        <path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" />
                      </svg>
                    </Show>
                    <Show when={p.versions[n.id]}>{(v) => <span class="ccard-badge">{v()} versions</span>}</Show>
                  </span>
                  <Show when={code()} fallback={<span class="ccard-text serif">{plain(n.preview.replace(/\{\{([^}|]+)(\|[^}]*)?\}\}/g, "$1"))}</span>}>
                    <span class="ccard-code">{n.preview.replace(/\n+$/, "")}</span>
                  </Show>
                  <Show when={!code() && blanks(n.preview).length}>
                    <span class="ccard-blanks">
                      <For each={blanks(n.preview).slice(0, 4)}>{(b) => <span class="blank-chip">{b.name}</span>}</For>
                    </span>
                  </Show>
                  <span class="ccard-foot">
                    <Show when={uses(n)}>
                      <b>{uses(n)}×</b>
                    </Show>
                    <span class="ccard-used">{lastUse(n) || (uses(n) ? "" : "not used yet")}</span>
                    <span class="grow" />
                    <Show when={on()}>
                      <span class="ccard-go">
                        Copy <kbd>Enter</kbd>
                      </span>
                    </Show>
                  </span>
                </Show>
              </button>
            );
          }}
        </For>
        <Show when={!shown().length}>
          <p class="muted pad">{q() || order() === "tasks" ? "Nothing here with that." : `Nothing in ${folderName(p.top)} yet. n makes one.`}</p>
        </Show>
      </div>

      <footer class="lib-foot">
        <KeyHints
          hints={[
            ["← → ↑ ↓", copy() ? "cards" : "pages"],
            ["Enter", copy() ? "copy" : "read"],
            ["e", copy() ? "edit" : "write in it"],
            ["m", "move"],
            ["p", "pin"],
            ["d", "delete"],
            ["/", "filter"],
          ]}
        />
        <span class="grow" />
        <KeyHints hints={[["Esc", "back to writing"]]} />
      </footer>
    </div>
  );
}
