// Ctrl L's first screen: every collection at once. The inbox is a strip on top; each collection is a shelf of
// its first five: the most used for things to copy, the newest for pages. ↑ ↓ move between shelves, ← → along
// one, Enter copies a card (its sheet, if it has blanks) or opens a page, "All n" opens the collection. Typing
// filters every shelf at once.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { NoteSummary } from "../api";
import { blanks } from "../blanks";
import { loadUsed, type Used } from "../collection/lastUsed";
import { ago, folderName, KeyHints, typing } from "../ui";
import { kindOf } from "./Card";
import { toCopy, topOf } from "./faces";
import Mark, { faces, hueClass } from "./Mark";
import type { LibraryData } from "./Library";
import { loadTaskCounts, tasksOf } from "./taskCounts";

const PER_SHELF = 5;

interface Shelf {
  top: string;
  copy: boolean;
  total: number;
  items: NoteSummary[];
}

/** A short date for a page card: "11 Nov", or the weekday this week. */
function shortDay(ms: number): string {
  const d = new Date(ms);
  if (Date.now() - ms < 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The open tasks a preview shows, as a hint of what is still to do in a page. */
const openTasks = (n: NoteSummary) => tasksOf(n.id);

/** A preview without Markdown marks, for a card. */
const plain = (s: string) =>
  s
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*[-*] \[[ xX]\]\s*/gm, "")
    .replace(/^\s*[-*>]\s+/gm, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, l?: string) => l ?? t)
    .replace(/[*_`]/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();

export default function Shelves(p: {
  data: LibraryData | undefined;
  /** Opens a collection's own view, or the inbox. */
  onTab(id: string): void;
  onEdit(id: number): void;
  /** A card to copy: its sheet (blanks, versions) or a plain copy. */
  onCopy(n: NoteSummary): void;
  onReview(): void;
  /** Something else (a sheet, a list) has the keys. */
  busy?: boolean;
}) {
  let filterInput!: HTMLInputElement;
  let shelvesEl: HTMLDivElement | undefined;
  const [q, setQ] = createSignal("");
  const [at, setAt] = createSignal({ row: 0, col: 0 });
  const [used, setUsed] = createSignal<Used>({});
  onMount(() => void loadUsed().then(setUsed, () => {}));
  createEffect(on(() => p.data, () => void loadTaskCounts()));

  const copies = (n: NoteSummary) => p.data?.copies[n.path] ?? 0;
  const words = () => q().toLowerCase().split(/\s+/).filter(Boolean);
  const match = (n: NoteSummary) => {
    const w = words();
    const hay = `${n.title} ${n.preview} ${n.tags.join(" ")}`.toLowerCase();
    return w.every((x) => hay.includes(x));
  };

  const inbox = createMemo(() => (p.data?.notes ?? []).filter((n) => n.folder === "inbox").sort((a, b) => b.modifiedAt - a.modifiedAt));

  const shelves = createMemo((): Shelf[] => {
    const by = new Map<string, NoteSummary[]>();
    for (const n of p.data?.notes ?? []) {
      const top = topOf(n.folder);
      if (!n.folder || top === "inbox") continue;
      if (!by.has(top)) by.set(top, []);
      by.get(top)!.push(n);
    }
    const out: Shelf[] = [];
    for (const [top, ns] of by) {
      const copy = toCopy(top, faces());
      const hits = ns.filter(match);
      if (!hits.length) continue;
      const sorted = copy
        ? [...hits].sort((a, b) => Number(b.pinned) - Number(a.pinned) || copies(b) - copies(a) || b.modifiedAt - a.modifiedAt)
        : [...hits].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.modifiedAt - a.modifiedAt);
      out.push({ top, copy, total: ns.length, items: sorted.slice(0, words().length ? 10 : PER_SHELF) });
    }
    // Things to copy first, the most used shelf first; then pages, the one written in last first.
    const use = (s: Shelf) => s.items.reduce((k, n) => k + copies(n), 0);
    const last = (s: Shelf) => Math.max(...s.items.map((n) => n.modifiedAt));
    return out.sort((a, b) => Number(b.copy) - Number(a.copy) || (a.copy ? use(b) - use(a) : last(b) - last(a)));
  });

  const current = () => shelves()[at().row]?.items[at().col];
  const go = (row: number, col: number) => {
    const s = shelves();
    if (!s.length) return;
    const r = Math.max(0, Math.min(s.length - 1, row));
    const c = Math.max(0, Math.min(s[r].items.length - 1, col));
    setAt({ row: r, col: c });
    queueMicrotask(() => shelvesEl?.querySelector(`[data-at="${r}:${c}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  };
  const open = (n: NoteSummary | undefined) => {
    if (!n) return;
    if (toCopy(n.folder, faces())) p.onCopy(n);
    else p.onEdit(n.id);
  };

  const key = (e: KeyboardEvent) => {
    if (p.busy || e.ctrlKey || e.metaKey || e.altKey || document.querySelector(".scrim")) return;
    if (typing(e)) {
      if (e.target === filterInput && (e.key === "ArrowDown" || e.key === "Enter")) {
        e.preventDefault();
        filterInput.blur();
        go(0, 0);
      } else if (e.target === filterInput && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setQ("");
        filterInput.blur();
      }
      return;
    }
    const { row, col } = at();
    switch (e.key) {
      case "ArrowDown":
      case "j":
        go(row + 1, col);
        break;
      case "ArrowUp":
      case "k":
        go(row - 1, col);
        break;
      case "ArrowRight":
      case "l":
        go(row, col + 1);
        break;
      case "ArrowLeft":
      case "h":
        go(row, col - 1);
        break;
      case "Enter":
        open(current());
        break;
      case "e":
        if (current()) p.onEdit(current()!.id);
        break;
      case "r":
        if (inbox().length) p.onReview();
        else return;
        break;
      case "/":
        filterInput.focus();
        break;
      default:
        // Typing a letter starts the filter.
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

  const lastUse = (n: NoteSummary) => {
    const u = used()[n.path];
    return u ? `${u[0]} · ${ago(u[1])}` : "";
  };
  const total = () => (p.data?.notes ?? []).filter((n) => n.folder && n.folder !== "inbox").length;

  return (
    <div class="shelves-view">
      <header class="shelves-head">
        <h1>Library</h1>
        <span class="muted small">
          {shelves().length} {shelves().length === 1 ? "collection" : "collections"} · {total()} notes
        </span>
        <span class="grow" />
        <label class="lib-filter shelves-filter">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input ref={filterInput} placeholder="Filter everything" aria-label="Filter everything" value={q()} onInput={(e) => (setQ(e.currentTarget.value), setAt({ row: 0, col: 0 }))} />
          <kbd>/</kbd>
        </label>
      </header>

      <div class="shelves" ref={shelvesEl}>
        <Show when={inbox().length && !q()}>
          <section class="inbox-strip" aria-label="Inbox">
            <button type="button" class="inbox-strip-name" onClick={() => p.onTab("inbox")}>
              <span class="inbox-strip-icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z" />
                </svg>
              </span>
              <span class="inbox-strip-text">
                <b>Inbox</b>
                <span class="muted small">{inbox().length} to file</span>
              </span>
            </button>
            <span class="inbox-strip-items">
              <For each={inbox().slice(0, 4)}>
                {(n) => (
                  <button type="button" class="inbox-chip" onClick={() => p.onTab("inbox")}>
                    {plain(n.preview).slice(0, 60) || n.title}
                  </button>
                )}
              </For>
            </span>
            <button type="button" class="btn primary small" onClick={p.onReview}>
              Review <kbd>r</kbd>
            </button>
          </section>
        </Show>

        <For each={shelves()}>
          {(s, row) => (
            <section class={`shelf ${hueClass(s.top)}`} aria-label={folderName(s.top)}>
              <div class="shelf-head">
                <Mark folder={s.top} class="tile" />
                <h2>{folderName(s.top)}</h2>
                <span class="muted small">
                  {s.copy ? "to copy" : "pages"} · {s.total}
                </span>
                <span class="grow" />
                <button type="button" class="shelf-all" onClick={() => p.onTab(`c:${s.top}`)}>
                  All {s.total} →
                </button>
              </div>
              <div class="shelf-row">
                <For each={s.items}>
                  {(n, col) => {
                    const on = () => at().row === row() && at().col === col();
                    const code = kindOf(n.folder) === "code";
                    return (
                      <button
                        type="button"
                        class="scard"
                        classList={{ on: on(), copy: s.copy && !code, code: s.copy && code, page: !s.copy }}
                        data-at={`${row()}:${col()}`}
                        onMouseEnter={() => setAt({ row: row(), col: col() })}
                        onClick={() => open(n)}
                      >
                        <Show
                          when={s.copy}
                          fallback={
                            <>
                              <span class="scard-date">{shortDay(n.modifiedAt)}</span>
                              <span class="scard-title serif">{n.title}</span>
                              <span class="scard-text serif">{plain(n.preview)}</span>
                              <Show when={openTasks(n)}>
                                {(k) => (
                                  <span class="scard-tasks">
                                    {k()} open {k() === 1 ? "task" : "tasks"}
                                  </span>
                                )}
                              </Show>
                            </>
                          }
                        >
                          <Show when={!code}>
                            <span class="scard-band" aria-hidden="true" />
                          </Show>
                          <span class="scard-top">
                            <span class="scard-title">{n.title}</span>
                            <Show when={p.data?.versions[n.id]}>{(v) => <span class="scard-badge">{v()} versions</span>}</Show>
                            <Show when={code && copies(n)}>
                              <span class="scard-uses">{copies(n)}×</span>
                            </Show>
                          </span>
                          <Show when={code} fallback={<span class="scard-text">{plain(n.preview.replace(/\{\{([^}|]+)(\|[^}]*)?\}\}/g, "$1"))}</span>}>
                            <span class="scard-code">{n.preview.split("\n").find((l) => l.trim()) ?? ""}</span>
                          </Show>
                          <Show when={!code}>
                            <span class="scard-blanks">
                              <For each={blanks(n.preview).slice(0, 3)}>{(b) => <span class="blank-chip">{b.name}</span>}</For>
                            </span>
                            <span class="scard-foot">
                              <Show when={copies(n)}>
                                <b>{copies(n)}×</b>
                              </Show>
                              <span>{lastUse(n) || (copies(n) ? "" : "not used yet")}</span>
                            </span>
                          </Show>
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </div>
            </section>
          )}
        </For>

        <Show when={p.data && !shelves().length}>
          <p class="muted pad">{q() ? "Nothing matches." : "No collections yet. Make one in the sidebar: Prompts to copy, Travel for pages."}</p>
        </Show>
      </div>

      <footer class="lib-foot">
        <KeyHints hints={[["↑ ↓", "shelves"], ["← →", "along one"], ["Enter", "open or copy"], ["e", "edit"], inbox().length > 0 && ["r", "review the inbox"], ["/", "filter"]]} />
        <span class="grow" />
        <KeyHints hints={[["Esc", "back to writing"]]} />
      </footer>
    </div>
  );
}
