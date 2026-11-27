// Ctrl L's first screen: every collection at once. The inbox is a strip on top; Ready to copy and Pages sit in two
// clear bands (or narrowed with the header filter). ↑ ↓ move between shelves, ← → along one, Enter copies a card
// (or opens its sheet if it has blanks) or reads a page, Space quick-peeks any card, e edits, t sets a shelf's
// look and kind, and / filters.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { NoteSummary } from "../api";
import { loadUsed, type Used } from "../collection/lastUsed";
import { ago, folderName, KeyHints, typing } from "../ui";
import { kindOf } from "./Card";
import CardText, { plain } from "./CardText";
import type { LibraryData } from "./data";
import { toCopy, topOf } from "./faces";
import Mark, { faces, hueClass } from "./Mark";
import { blankNames, codePreview, photoCount, previewTasks } from "./preview";
import { loadTaskCounts, tasksOf } from "./taskCounts";

const PER_SHELF = 5;

type ShelfFilter = "all" | "copy" | "pages";

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

const openTasks = (n: NoteSummary) => tasksOf(n.id);
const wordCount = (n: NoteSummary) => (n.preview.match(/[\p{L}\p{N}]+/gu) ?? []).length;

export default function Shelves(p: {
  data: LibraryData | undefined;
  /** Opens a collection's own view, or the inbox. */
  onTab(id: string): void;
  /** Opens a page in its collection's reader. */
  onRead(top: string, id: number): void;
  onEdit(id: number): void;
  /** A card to copy: its sheet (blanks, versions) or a plain copy. */
  onCopy(n: NoteSummary): void;
  /** Quick peek (Space or Peek button) without copying or leaving the shelves. */
  onPeek(n: NoteSummary): void;
  /** Open FacePicker for a collection. */
  onFace(top: string): void;
  onReview(): void;
  /** Card id that was just copied, for the brief hue border flash. */
  flashedId?: number | null;
  /** Something else (a sheet, a list) has the keys. */
  busy?: boolean;
}) {
  let filterInput!: HTMLInputElement;
  let shelvesEl: HTMLDivElement | undefined;
  const [q, setQ] = createSignal("");
  const [band, setBand] = createSignal<ShelfFilter>("all");
  // Null until the user navigates with keys, so card 0 does not shout on mount.
  const [at, setAt] = createSignal<{ row: number; col: number } | null>(null);
  const [used, setUsed] = createSignal<Used>({});
  onMount(() => void loadUsed().then(setUsed, () => {}));
  createEffect(on(() => p.data, () => void loadTaskCounts()));

  const copies = (n: NoteSummary) => p.data?.copies[n.path] ?? 0;
  const words = () => q().toLowerCase().split(/\s+/).filter(Boolean);
  const match = (n: NoteSummary) => {
    const w = words();
    if (!w.length) return true;
    const hay = `${n.title} ${n.folder} ${n.preview} ${n.tags.join(" ")}`.toLowerCase();
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
      if (band() === "copy" && !copy) continue;
      if (band() === "pages" && copy) continue;
      const hits = ns.filter(match);
      if (!hits.length) continue;
      const sorted = copy
        ? [...hits].sort((a, b) => Number(b.pinned) - Number(a.pinned) || copies(b) - copies(a) || b.modifiedAt - a.modifiedAt)
        : [...hits].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.modifiedAt - a.modifiedAt);
      out.push({ top, copy, total: ns.length, items: sorted.slice(0, words().length ? 10 : PER_SHELF) });
    }
    const use = (s: Shelf) => s.items.reduce((k, n) => k + copies(n), 0);
    const last = (s: Shelf) => Math.max(...s.items.map((n) => n.modifiedAt));
    return out.sort((a, b) => Number(b.copy) - Number(a.copy) || (a.copy ? use(b) - use(a) : last(b) - last(a)));
  });

  const copyShelves = createMemo(() => shelves().filter((s) => s.copy));
  const pageShelves = createMemo(() => shelves().filter((s) => !s.copy));

  const current = () => {
    const pos = at();
    if (!pos) return undefined;
    return shelves()[pos.row]?.items[pos.col];
  };
  const currentShelf = () => {
    const pos = at();
    return pos ? shelves()[pos.row] : undefined;
  };

  const go = (row: number, col: number) => {
    const s = shelves();
    if (!s.length) return;
    const r = Math.max(0, Math.min(s.length - 1, row));
    const c = Math.max(0, Math.min(s[r].items.length - 1, col));
    setAt({ row: r, col: c });
    queueMicrotask(() => shelvesEl?.querySelector(`[data-at="${r}:${c}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  };

  const open = (s: Shelf, n: NoteSummary | undefined) => {
    if (!n) return;
    if (s.copy) p.onCopy(n);
    else p.onRead(s.top, n.id);
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
    const pos = at();
    const cur = current();
    const sh = currentShelf();
    switch (e.key) {
      case "ArrowDown":
      case "j":
        if (!pos) go(0, 0);
        else go(pos.row + 1, pos.col);
        break;
      case "ArrowUp":
      case "k":
        if (!pos) go(0, 0);
        else go(pos.row - 1, pos.col);
        break;
      case "ArrowRight":
      case "l":
        if (!pos) go(0, 0);
        else go(pos.row, pos.col + 1);
        break;
      case "ArrowLeft":
      case "h":
        if (!pos) go(0, 0);
        else go(pos.row, pos.col - 1);
        break;
      case "Enter":
        if (sh && cur) open(sh, cur);
        else return;
        break;
      case " ":
        if (cur) p.onPeek(cur);
        else return;
        break;
      case "e":
        if (cur) p.onEdit(cur.id);
        else return;
        break;
      case "t":
        if (sh) p.onFace(sh.top);
        else return;
        break;
      case "r":
        if (inbox().length) p.onReview();
        else return;
        break;
      case "/":
        filterInput.focus();
        break;
      default:
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
  const blanksOf = (n: NoteSummary) => p.data?.blanks[n.id] ?? blankNames(p.data?.firstVersion[n.id] ?? n.preview);
  const total = () => (p.data?.notes ?? []).filter((n) => n.folder && n.folder !== "inbox").length;

  const renderShelf = (s: Shelf, rowIdx: () => number) => (
    <section class={`shelf ${hueClass(s.top)}`} aria-label={folderName(s.top)}>
      <div class="shelf-head">
        <button type="button" class="mark-btn" title="Colour and kind (t)" aria-label={`Look and kind for ${folderName(s.top)}`} onClick={() => p.onFace(s.top)}>
          <Mark folder={s.top} class="tile" />
        </button>
        <h2>{folderName(s.top)}</h2>
        <span class="muted small">{s.total}</span>
        <span class="grow" />
        <button type="button" class="shelf-all" onClick={() => p.onTab(`c:${s.top}`)}>
          All {s.total} →
        </button>
      </div>
      <div class="shelf-row">
        <For each={s.items}>
          {(n, col) => {
            const on = () => at()?.row === rowIdx() && at()?.col === col();
            const code = kindOf(n.folder) === "code";
            const song = kindOf(n.folder) === "song";
            const bs = () => (s.copy ? blanksOf(n) : []);
            const tasks = () => (!s.copy ? previewTasks(n.preview, 3) : []);
            const photos = () => (!s.copy ? photoCount(n.preview) : 0);
            const cp = () => (code ? codePreview(p.data?.firstVersion[n.id] ?? n.preview) : null);
            const flashed = () => p.flashedId === n.id;
            return (
              <article
                class="scard"
                classList={{ on: on(), copy: s.copy && !code, code: s.copy && code, page: !s.copy, flash: flashed() }}
                data-at={`${rowIdx()}:${col()}`}
                tabIndex={-1}
                onClick={() => open(s, n)}
              >
                <Show
                  when={s.copy}
                  fallback={
                    <>
                      <span class="scard-page-meta">
                        <span>{shortDay(n.modifiedAt)}</span>
                        <Show when={n.pinned}>
                          <span>· pinned</span>
                        </Show>
                        <span class="grow" />
                        <Show when={photos()}>
                          <span class="scard-photos" title={`${photos()} ${photos() === 1 ? "picture" : "pictures"}`}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                              <rect x="3" y="5" width="18" height="14" rx="2" />
                              <circle cx="8.5" cy="10" r="1.5" />
                              <path d="m21 15-5-5-8 8" />
                            </svg>
                            {photos()}
                          </span>
                        </Show>
                        <span>{wordCount(n)}w</span>
                      </span>
                      <span class="scard-title serif">{n.title}</span>
                      <Show
                        when={tasks().length}
                        fallback={<CardText class={song ? "scard-text serif lines" : "scard-text serif"} preserveLines={song} text={n.preview} />}
                      >
                        <span class="card-checklist">
                          <For each={tasks()}>
                            {(t) => (
                              <span class="card-check-item" classList={{ done: t.done }}>
                                <span class="card-check-box" aria-hidden="true">{t.done ? "☑" : "☐"}</span>
                                <span>{t.text}</span>
                              </span>
                            )}
                          </For>
                        </span>
                      </Show>
                      <span class="scard-foot page-foot">
                        <Show when={openTasks(n)}>
                          {(k) => (
                            <span class="scard-tasks">
                              {k()} open {k() === 1 ? "task" : "tasks"}
                            </span>
                          )}
                        </Show>
                        <span class="grow" />
                        <span class="card-hover-acts">
                          <button type="button" class="card-mini-btn" title="Quick peek (Space)" onClick={(e) => (e.stopPropagation(), p.onPeek(n))}>
                            Peek
                          </button>
                          <button type="button" class="card-mini-btn" title="Edit (e)" onClick={(e) => (e.stopPropagation(), p.onEdit(n.id))}>
                            Edit
                          </button>
                        </span>
                        <span class="scard-cta">Read</span>
                      </span>
                    </>
                  }
                >
                  <span class="scard-top">
                    <span class="scard-title">{n.title}</span>
                    <Show when={p.data?.versions[n.id]}>{(v) => <span class="scard-badge">{v()}v</span>}</Show>
                    <span class="card-hover-acts">
                      <button type="button" class="card-mini-btn" title="Quick peek (Space)" onClick={(e) => (e.stopPropagation(), p.onPeek(n))}>
                        Peek
                      </button>
                      <button type="button" class="card-mini-btn" title="Edit (e)" onClick={(e) => (e.stopPropagation(), p.onEdit(n.id))}>
                        Edit
                      </button>
                    </span>
                  </span>
                  <Show
                    when={code}
                    fallback={<CardText class="scard-text" text={p.data?.firstVersion[n.id] ?? n.preview} />}
                  >
                    <span class="scard-code-wrap">
                      <Show when={cp()?.lang}>
                        <span class="card-lang">{cp()!.lang}</span>
                      </Show>
                      <CardText class="scard-code" code text={p.data?.firstVersion[n.id] ?? n.preview} />
                    </span>
                  </Show>
                  <span class="scard-foot">
                    <Show when={copies(n)}>
                      <span class="uses">{copies(n)}×</span>
                    </Show>
                    <span class="scard-used">{lastUse(n)}</span>
                    <span class="grow" />
                    <span class="scard-cta" classList={{ ok: flashed() }}>
                      {flashed() ? "Copied ✓" : bs().length ? `Fill ${bs().length}` : "Copy"}
                    </span>
                  </span>
                </Show>
              </article>
            );
          }}
        </For>
      </div>
    </section>
  );

  return (
    <div class="shelves-view">
      <header class="shelves-head">
        <h1>Library</h1>
        <span class="muted small">
          {shelves().length} {shelves().length === 1 ? "collection" : "collections"} · {total()} notes
        </span>
        <div class="seg shelves-band-seg" role="group" aria-label="Show">
          <For each={[["all", "All"], ["copy", "Ready to copy"], ["pages", "Pages"]] as [ShelfFilter, string][]}>
            {([id, label]) => (
              <button type="button" classList={{ on: band() === id }} aria-pressed={band() === id} onClick={() => (setBand(id), setAt(null))}>
                {label}
              </button>
            )}
          </For>
        </div>
        <span class="grow" />
        <label class="lib-filter shelves-filter">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input ref={filterInput} placeholder="Filter everything" aria-label="Filter everything" value={q()} onInput={(e) => (setQ(e.currentTarget.value), setAt(null))} />
          <kbd>/</kbd>
        </label>
      </header>

      <div class="shelves" ref={shelvesEl}>
        <Show when={inbox().length && !q()}>
          {/* The captures waiting, as short lines you can read (two at most, ending at a word), with how old each is. */}
          <section class="inbox-strip" aria-label="Inbox">
            <div class="inbox-strip-head">
              <button type="button" class="inbox-strip-name" onClick={() => p.onTab("inbox")}>
                <b>Inbox</b>
                <span class="muted">{inbox().length} to file</span>
              </button>
              <span class="grow" />
              <button type="button" class="inbox-strip-review" onClick={p.onReview}>
                <kbd>r</kbd> review them one at a time
              </button>
            </div>
            <span class="inbox-strip-items">
              <For each={inbox().slice(0, 3)}>
                {(n) => (
                  <button type="button" class="inbox-line" onClick={() => p.onTab("inbox")}>
                    <span class="inbox-line-text">{plain(n.preview) || n.title}</span>
                    <span class="inbox-line-age">{ago(n.modifiedAt)}</span>
                  </button>
                )}
              </For>
            </span>
          </section>
        </Show>

        <Show when={copyShelves().length}>
          <Show when={band() === "all" && pageShelves().length}>
            <div class="shelf-band-head">
              <span>Ready to copy</span>
              <span class="shelf-band-rule" />
              <span class="shelf-band-note">Click copies or fills blanks</span>
            </div>
          </Show>
          <For each={copyShelves()}>{(s, i) => renderShelf(s, i)}</For>
        </Show>

        <Show when={pageShelves().length}>
          <Show when={band() === "all" && copyShelves().length}>
            <div class="shelf-band-head">
              <span>Pages</span>
              <span class="shelf-band-rule" />
              <span class="shelf-band-note">Click reads · e writes in it</span>
            </div>
          </Show>
          <For each={pageShelves()}>{(s, i) => renderShelf(s, () => copyShelves().length + i())}</For>
        </Show>

        <Show when={p.data && !shelves().length}>
          <p class="muted pad">{q() ? "Nothing matches." : "No collections yet. Make one in the sidebar: Prompts to copy, Travel for pages."}</p>
        </Show>
      </div>

      <footer class="lib-foot">
        <KeyHints
          hints={[
            ["↑ ↓ ← →", "move"],
            ["Enter", "copy or read"],
            ["Space", "peek"],
            ["e", "edit"],
            ["t", "look & kind"],
            inbox().length > 0 && ["r", "review"],
            ["/", "filter"],
          ]}
        />
        <span class="grow" />
        <KeyHints hints={[["Esc", "back to writing"]]} />
      </footer>
    </div>
  );
}
