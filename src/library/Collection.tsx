// One collection, picked in the sidebar: Cards grid or Split view (remembered per collection).
// Things to copy (Prompts, Snippets) are tactile cards with blanks, versions, code wells and instant copy flash
// (or an always-open inline Sheet in Split mode). Pages (Travel, Work) are warm paper cards with serif titles,
// structured checklist/photo previews and open tasks (or Split Reader). Hover check circles or `x` enter quiet
// multi-selection mode for batch Move, Pin, Copy joined, and Delete.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { AiSuggestion, Note, NoteSummary } from "../api";
import { loadUsed, type Used } from "../collection/lastUsed";
import { ago, folderName, KeyHints, typing, undoLast } from "../ui";
import { kindOf } from "./Card";
import CardText from "./CardText";
import { toCopy } from "./faces";
import Mark, { faces, hueClass } from "./Mark";
import { blankNames, codePreview, photoCount, previewTasks, subOf } from "./preview";
import { pruneSelection, rangeSelection, toggleSelection } from "./selection";
import Sheet from "./Sheet";
import { loadTaskCounts, tasksOf } from "./taskCounts";

type Order = "use" | "new" | "az" | "tasks";

const openTasks = (n: NoteSummary) => tasksOf(n.id);
const words = (n: NoteSummary) => (n.preview.match(/[\p{L}\p{N}]+/gu) ?? []).length;

export { plain } from "./CardText";

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
  firstVersion: Record<number, string>;
  blanks: Record<number, string[]>;
  aiReady: boolean;
  view: "cards" | "split";
  onView(v: "cards" | "split"): void;
  onCopy(n: NoteSummary): void;
  onPeek(n: NoteSummary): void;
  onRead(id: number): void;
  onEdit(id: number): void;
  onNew(folder: string): void;
  onMove(n: NoteSummary): void;
  onMoveMany(ns: NoteSummary[]): void;
  onPin(n: NoteSummary): void;
  onPinMany(ns: NoteSummary[]): void;
  onCopyMany(ns: NoteSummary[]): void;
  onDelete(n: NoteSummary): void;
  onDeleteMany(ns: NoteSummary[]): void;
  onFace(top: string): void;
  onFile(note: Note, s: AiSuggestion): void;
  onChanged(): void;
  onAiSetup(): void;
  flashedId?: number | null;
  /** Something over this (a sheet, a list) has the keys. */
  busy?: boolean;
}) {
  let filterInput!: HTMLInputElement;
  let gridEl: HTMLDivElement | undefined;
  let splitRowsEl: HTMLDivElement | undefined;
  const copy = () => toCopy(p.top, faces());
  const code = () => kindOf(p.top) === "code";
  const song = () => kindOf(p.top) === "song";
  const [q, setQ] = createSignal("");
  const [sub, setSub] = createSignal<string>("");
  const [order, setOrder] = createSignal<Order>(copy() ? "use" : "new");
  // Null until keyboard navigation begins, so card 0 doesn't draw a loud focus ring on mount.
  const [sel, setSel] = createSignal<number | null>(null);
  const [splitId, setSplitId] = createSignal<number | null>(null);
  const [selected, setSelected] = createSignal<Set<number>>(new Set());
  const [anchor, setAnchor] = createSignal<number | null>(null);
  const [used, setUsed] = createSignal<Used>({});
  onMount(() => void loadUsed().then(setUsed, () => {}));
  createEffect(on(() => p.notes, () => void loadTaskCounts()));
  createEffect(
    on(
      () => p.top,
      () => {
        setQ("");
        setSub("");
        setSel(null);
        setSplitId(null);
        setSelected(new Set<number>());
        setAnchor(null);
        setOrder(copy() ? "use" : "new");
      },
      { defer: true },
    ),
  );

  const subfolders = createMemo(() => {
    const seen = new Set<string>();
    for (const n of p.notes) {
      const s = subOf(n.folder, p.top);
      if (s) seen.add(s);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  });

  const uses = (n: NoteSummary) => p.copies[n.path] ?? 0;
  const shown = createMemo(() => {
    const w = q().toLowerCase().split(/\s+/).filter(Boolean);
    const activeSub = sub();
    let ns = p.notes.filter((n) => {
      if (activeSub && subOf(n.folder, p.top) !== activeSub) return false;
      return w.every((x) => `${n.title} ${n.folder} ${n.preview} ${n.tags.join(" ")}`.toLowerCase().includes(x));
    });
    if (order() === "tasks") ns = ns.filter((n) => openTasks(n) > 0);
    const pin = (a: NoteSummary, b: NoteSummary) => Number(b.pinned) - Number(a.pinned);
    if (order() === "az") return [...ns].sort((a, b) => a.title.localeCompare(b.title));
    if (order() === "use") return [...ns].sort((a, b) => pin(a, b) || uses(b) - uses(a) || b.modifiedAt - a.modifiedAt);
    return [...ns].sort((a, b) => pin(a, b) || b.modifiedAt - a.modifiedAt);
  });

  // Keep selection pruned to visible items when filters or notes change.
  createEffect(() => {
    const ids = shown().map((n) => n.id);
    const cur = selected();
    if (cur.size) {
      const next = pruneSelection(cur, ids);
      if (next.size !== cur.size) setSelected(next);
    }
  });

  const selectedItems = createMemo(() => shown().filter((n) => selected().has(n.id)));
  const inSelectMode = () => selected().size > 0;
  const splitCurrent = () => shown().find((n) => n.id === splitId()) ?? shown()[0];
  const current = () => {
    if (copy() && p.view === "split") return splitCurrent();
    const idx = sel();
    if (idx === null) return undefined;
    return shown()[Math.min(idx, shown().length - 1)];
  };

  const monthUses = () => p.notes.reduce((k, n) => k + uses(n), 0);
  const lastWritten = () => Math.max(0, ...p.notes.map((n) => n.modifiedAt));

  /** How many cards fit across now: the cards on the first card's row. */
  const across = () => {
    const cards = gridEl ? [...gridEl.querySelectorAll<HTMLElement>(".ccard")] : [];
    if (!cards.length) return 1;
    const top = cards[0].offsetTop;
    return Math.max(1, cards.filter((c) => c.offsetTop === top).length);
  };

  const go = (i: number, extend = false) => {
    const list = shown();
    if (!list.length) return;
    const prevIdx = sel() ?? 0;
    const k = Math.max(0, Math.min(list.length - 1, i));
    setSel(k);
    if (extend) {
      const a = anchor() ?? list[prevIdx].id;
      setAnchor(a);
      setSelected(rangeSelection(selected(), list.map((n) => n.id), a, list[k].id));
    }
    queueMicrotask(() => gridEl?.querySelector(`[data-i="${k}"]`)?.scrollIntoView({ block: "nearest" }));
  };

  const stepSplit = (by: number, extend = false) => {
    const list = shown();
    if (!list.length) return;
    const cur = splitCurrent();
    const idx = Math.max(0, list.findIndex((n) => n.id === cur?.id));
    const next = list[Math.max(0, Math.min(list.length - 1, idx + by))];
    setSplitId(next.id);
    if (extend && cur) {
      const a = anchor() ?? cur.id;
      setAnchor(a);
      setSelected(rangeSelection(selected(), list.map((n) => n.id), a, next.id));
    }
    queueMicrotask(() => splitRowsEl?.querySelector(`[data-split-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" }));
  };

  const toggleItem = (id: number, shift = false) => {
    const ids = shown().map((n) => n.id);
    if (shift) {
      setSelected(rangeSelection(selected(), ids, anchor(), id));
    } else {
      setSelected(toggleSelection(selected(), id));
    }
    setAnchor(id);
  };

  const clearSelection = () => {
    setSelected(new Set<number>());
    setAnchor(null);
  };

  const open = (n: NoteSummary | undefined) => n && (copy() ? p.onCopy(n) : p.onRead(n.id));

  const runBatch = (act: "move" | "pin" | "copy" | "delete") => {
    const list = selectedItems();
    if (!list.length) return;
    if (act === "move") p.onMoveMany(list);
    else if (act === "pin") p.onPinMany(list);
    else if (act === "copy") p.onCopyMany(list);
    else if (act === "delete") p.onDeleteMany(list);
    clearSelection();
  };

  // Esc clears selection before App.tsx takes it as "back to writing".
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || p.busy || typing(e) || document.querySelector(".scrim")) return;
    if (!inSelectMode()) return;
    e.preventDefault();
    e.stopPropagation();
    clearSelection();
  };

  const key = (e: KeyboardEvent) => {
    if (p.busy || e.altKey || document.querySelector(".scrim")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !typing(e)) {
      const list = shown();
      if (!list.length) return;
      e.preventDefault();
      e.stopPropagation();
      setSelected(new Set(list.map((n) => n.id)));
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    if (typing(e)) {
      if (e.target === filterInput && (e.key === "ArrowDown" || e.key === "Enter")) {
        e.preventDefault();
        filterInput.blur();
        if (copy() && p.view === "split") stepSplit(0);
        else go(0);
      } else if (e.target === filterInput && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setQ("");
        filterInput.blur();
      }
      return;
    }
    const splitCopy = copy() && p.view === "split";
    const n = current();
    switch (e.key) {
      case "ArrowRight":
      case "l":
        if (splitCopy) return;
        go(sel() === null ? 0 : sel()! + 1, e.shiftKey);
        break;
      case "ArrowLeft":
      case "h":
        if (splitCopy) return;
        go(sel() === null ? 0 : sel()! - 1, e.shiftKey);
        break;
      case "ArrowDown":
      case "j":
        if (splitCopy) stepSplit(1, e.shiftKey);
        else go(sel() === null ? 0 : sel()! + across(), e.shiftKey);
        break;
      case "ArrowUp":
      case "k":
        if (splitCopy) stepSplit(-1, e.shiftKey);
        else go(sel() === null ? 0 : sel()! - across(), e.shiftKey);
        break;
      case "x": {
        const target = n ?? shown()[0];
        if (!target) return;
        if (!splitCopy && sel() === null) setSel(0);
        toggleItem(target.id, e.shiftKey);
        break;
      }
      case "Enter":
        if (splitCopy) return; // Inline Sheet handles Enter to copy.
        if (inSelectMode()) return;
        if (n) open(n);
        else return;
        break;
      case " ":
        if (splitCopy) return;
        if (n) p.onPeek(n);
        else return;
        break;
      case "e":
        if (n) p.onEdit(n.id);
        else return;
        break;
      case "c":
        if (inSelectMode()) runBatch("copy");
        else if (n && copy()) p.onCopy(n);
        else return;
        break;
      case "m":
        if (inSelectMode()) runBatch("move");
        else if (n) p.onMove(n);
        else return;
        break;
      case "p":
        if (inSelectMode()) runBatch("pin");
        else if (n) p.onPin(n);
        else return;
        break;
      case "d":
      case "Delete":
        if (inSelectMode()) runBatch("delete");
        else if (n) p.onDelete(n);
        else return;
        break;
      case "t":
        p.onFace(p.top);
        break;
      case "n":
        p.onNew(sub() ? `${p.top}/${sub()}` : p.top);
        break;
      case "z":
        if (!undoLast()) return;
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
  onMount(() => {
    document.addEventListener("keydown", key);
    document.addEventListener("keydown", esc, true);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", key);
    document.removeEventListener("keydown", esc, true);
  });

  const orders = (): [Order, string][] => (copy() ? [["use", "Most used"], ["new", "Lately"], ["az", "A–Z"]] : [["new", "Newest"], ["az", "A–Z"], ["tasks", "Open tasks"]]);
  const lastUse = (n: NoteSummary) => {
    const u = used()[n.path];
    return u ? `${u[0]} · ${ago(u[1])}` : "";
  };
  const blanksOf = (n: NoteSummary) => p.blanks[n.id] ?? blankNames(p.firstVersion[n.id] ?? n.preview);

  return (
    <div class={`collection ${hueClass(p.top)}`}>
      <header class="coll-head">
        <button type="button" class="mark-btn" title="Colour and kind (t)" aria-label={`Look and kind for ${folderName(p.top)}`} onClick={() => p.onFace(p.top)}>
          <Mark folder={p.top} class="tile big" />
        </button>
        <span class="coll-name">
          <span class="coll-title-row">
            <h1>{folderName(p.top)}</h1>
            <button type="button" class="coll-kind-pill" title="Change collection kind (t)" onClick={() => p.onFace(p.top)}>
              {copy() ? "To copy" : "Pages"}
            </button>
          </span>
          <span class="muted small">
            {copy()
              ? `${p.notes.length} to copy${monthUses() ? ` · copied ${monthUses()} ${monthUses() === 1 ? "time" : "times"}` : ""}`
              : `${p.notes.length} ${p.notes.length === 1 ? "page" : "pages"}${lastWritten() ? ` · last written in ${ago(lastWritten())}` : ""}`}
          </span>
        </span>
        <span class="grow" />
        <div class="seg coll-view-seg" role="group" aria-label="Layout">
          <button type="button" classList={{ on: p.view === "cards" }} aria-pressed={p.view === "cards"} onClick={() => p.onView("cards")}>
            Cards
          </button>
          <button type="button" classList={{ on: p.view === "split" }} aria-pressed={p.view === "split"} onClick={() => p.onView("split")}>
            {copy() ? "Split" : "Reader"}
          </button>
        </div>
        <span class="coll-chips" role="group" aria-label="Order">
          <For each={orders()}>
            {([id, label]) => (
              <button type="button" class="chip" classList={{ on: order() === id }} aria-pressed={order() === id} onClick={() => (setOrder(id), setSel(null))}>
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
          <input ref={filterInput} placeholder={`Filter ${folderName(p.top)}`} aria-label={`Filter ${folderName(p.top)}`} value={q()} onInput={(e) => (setQ(e.currentTarget.value), setSel(null))} />
          <kbd>/</kbd>
        </label>
        <button type="button" class="btn primary small" onClick={() => p.onNew(sub() ? `${p.top}/${sub()}` : p.top)}>
          {copy() ? "New" : "New page"} <kbd>n</kbd>
        </button>
      </header>

      <Show when={subfolders().length}>
        <div class="coll-subs" role="group" aria-label="Subfolders">
          <button type="button" class="chip small" classList={{ on: !sub() }} onClick={() => (setSub(""), setSel(null))}>
            All
          </button>
          <For each={subfolders()}>
            {(s) => (
              <button type="button" class="chip small" classList={{ on: sub() === s }} onClick={() => (setSub(s), setSel(null))}>
                {folderName(s)}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={!(copy() && p.view === "split")}
        fallback={
          <div class="coll-split">
            <div class="coll-split-list" ref={splitRowsEl}>
              <For each={shown()}>
                {(n) => {
                  const isAct = () => splitCurrent()?.id === n.id;
                  const isSel = () => selected().has(n.id);
                  const bs = () => blanksOf(n);
                  const subName = () => subOf(n.folder, p.top);
                  return (
                    <div
                      class="coll-split-row"
                      classList={{ on: isAct(), picked: isSel(), selecting: inSelectMode() }}
                      data-split-id={n.id}
                      onClick={(e) => {
                        if (inSelectMode() || e.shiftKey) toggleItem(n.id, e.shiftKey);
                        else setSplitId(n.id);
                      }}
                    >
                      <button
                        type="button"
                        class="sel-check"
                        classList={{ on: isSel() }}
                        aria-label={isSel() ? `Deselect ${n.title}` : `Select ${n.title}`}
                        aria-pressed={isSel()}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleItem(n.id, e.shiftKey);
                        }}
                      >
                        {isSel() ? "✓" : ""}
                      </button>
                      <div class="coll-split-row-body">
                        <div class="coll-split-row-top">
                          <span class="coll-split-row-title">{n.title}</span>
                          <Show when={p.versions[n.id]}>{(v) => <span class="scard-badge">{v()}v</span>}</Show>
                          <Show when={uses(n)}>
                            <span class="uses">{uses(n)}×</span>
                          </Show>
                        </div>
                        <div class="coll-split-row-meta">
                          <Show when={subName()}>
                            <span class="card-sub-tag">{folderName(subName())}</span>
                          </Show>
                          <Show when={bs().length}>
                            <span>{bs().length} {bs().length === 1 ? "blank" : "blanks"}</span>
                          </Show>
                          <span>{lastUse(n) || ago(n.modifiedAt)}</span>
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
              <Show when={!shown().length}>
                <p class="muted pad">{q() ? "Nothing here with that." : `Nothing in ${folderName(p.top)} yet. n makes one.`}</p>
              </Show>
            </div>
            <section class="coll-split-pane">
              <Show when={splitCurrent()} keyed fallback={<div class="empty"><p class="muted">Pick something on the left.</p></div>}>
                {(n) => (
                  <Sheet
                    inline
                    disabled={inSelectMode()}
                    id={n.id}
                    copies={uses(n)}
                    aiReady={p.aiReady}
                    onClose={() => {}}
                    onCopied={p.onChanged}
                    onEdit={(id) => p.onEdit(id)}
                    onMove={() => p.onMove(n)}
                    onFile={p.onFile}
                    onDelete={() => p.onDelete(n)}
                    onAiSetup={p.onAiSetup}
                  />
                )}
              </Show>
            </section>
          </div>
        }
      >
        <div class="coll-grid" classList={{ pages: !copy(), code: copy() && code(), selecting: inSelectMode() }} ref={gridEl}>
          <For each={shown()}>
            {(n, i) => {
              const on = () => sel() !== null && i() === Math.min(sel()!, shown().length - 1);
              const isSel = () => selected().has(n.id);
              const bs = () => (copy() ? blanksOf(n) : []);
              const tasks = () => (!copy() ? previewTasks(n.preview, 3) : []);
              const photos = () => (!copy() ? photoCount(n.preview) : 0);
              const subName = () => subOf(n.folder, p.top);
              const cp = () => (copy() && code() ? codePreview(p.firstVersion[n.id] ?? n.preview) : null);
              const flashed = () => p.flashedId === n.id;
              return (
                <article
                  class="ccard"
                  classList={{ on: on(), picked: isSel(), page: !copy(), code: copy() && code(), flash: flashed() }}
                  data-i={i()}
                  tabIndex={-1}
                  onClick={(e) => {
                    if (inSelectMode() || e.shiftKey) {
                      toggleItem(n.id, e.shiftKey);
                    } else {
                      open(n);
                    }
                  }}
                >
                  <button
                    type="button"
                    class="sel-check card-check"
                    classList={{ on: isSel() }}
                    title={isSel() ? "Deselect" : "Select (x)"}
                    aria-label={isSel() ? `Deselect ${n.title}` : `Select ${n.title}`}
                    aria-pressed={isSel()}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleItem(n.id, e.shiftKey);
                    }}
                  >
                    {isSel() ? "✓" : ""}
                  </button>
                  <Show
                    when={copy()}
                    fallback={
                      <>
                        <span class="ccard-meta">
                          <Show when={subName()}>
                            <span class="card-sub-tag">{folderName(subName())}</span>
                          </Show>
                          <span>{shortDay(n.modifiedAt)}</span>
                          <Show when={n.pinned}>
                            <span>· pinned</span>
                          </Show>
                          <span class="grow" />
                          <Show when={photos()}>
                            <span class="scard-photos" title={`${photos()} ${photos() === 1 ? "picture" : "pictures"}`}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                <rect x="3" y="5" width="18" height="14" rx="2" />
                                <circle cx="8.5" cy="10" r="1.5" />
                                <path d="m21 15-5-5-8 8" />
                              </svg>
                              {photos()}
                            </span>
                          </Show>
                          <span>{words(n)} words</span>
                        </span>
                        <span class="ccard-title serif">{n.title}</span>
                        <Show
                          when={tasks().length}
                          fallback={<CardText class={song() ? "ccard-text serif lines" : "ccard-text serif"} preserveLines={song()} text={n.preview} />}
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
                        <span class="ccard-foot">
                          <Show when={openTasks(n)}>
                            {(k) => (
                              <span class="ccard-tasks">
                                {k()} open {k() === 1 ? "task" : "tasks"}
                              </span>
                            )}
                          </Show>
                          <span class="grow" />
                          <Show when={!inSelectMode()} fallback={<span class="ccard-sel-hint">{isSel() ? "Selected" : "Click to select"}</span>}>
                            <span class="card-hover-acts">
                              <button type="button" class="card-mini-btn" title="Edit (e)" onClick={(e) => (e.stopPropagation(), p.onEdit(n.id))}>
                                Edit
                              </button>
                            </span>
                            <span class="ccard-go">
                              Read <Show when={on()}><kbd>Enter</kbd></Show>
                            </span>
                          </Show>
                        </span>
                      </>
                    }
                  >
                    <span class="ccard-top">
                      <Show when={subName()}>
                        <span class="card-sub-tag">{folderName(subName())}</span>
                      </Show>
                      <span class="ccard-title">{n.title}</span>
                      <Show when={n.pinned}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" role="img" aria-label="Pinned" class="ccard-pin">
                          <path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" />
                        </svg>
                      </Show>
                      <Show when={p.versions[n.id]}>{(v) => <span class="ccard-badge">{v()}v</span>}</Show>
                    </span>
                    <Show
                      when={code()}
                      fallback={<CardText class="ccard-text" text={p.firstVersion[n.id] ?? n.preview} />}
                    >
                      <span class="ccard-code-wrap">
                        <Show when={cp()?.lang}>
                          <span class="card-lang">{cp()!.lang}</span>
                        </Show>
                        <CardText class="ccard-code" code text={p.firstVersion[n.id] ?? n.preview} />
                      </span>
                    </Show>
                    <span class="ccard-foot">
                      <Show when={uses(n)}>
                        <span class="uses">{uses(n)}×</span>
                      </Show>
                      <span class="ccard-used">{lastUse(n)}</span>
                      <span class="grow" />
                      <Show when={!inSelectMode()} fallback={<span class="ccard-sel-hint">{isSel() ? "Selected" : "Click to select"}</span>}>
                        <span class="card-hover-acts">
                          <button type="button" class="card-mini-btn" title="Quick peek (Space)" onClick={(e) => (e.stopPropagation(), p.onPeek(n))}>
                            Peek
                          </button>
                          <button type="button" class="card-mini-btn" title="Edit (e)" onClick={(e) => (e.stopPropagation(), p.onEdit(n.id))}>
                            Edit
                          </button>
                        </span>
                        <span class="ccard-go" classList={{ ok: flashed() }}>
                          {flashed() ? "Copied ✓" : bs().length ? `Fill ${bs().length}` : "Copy"}
                          <Show when={on() && !flashed()}><kbd>Enter</kbd></Show>
                        </span>
                      </Show>
                    </span>
                  </Show>
                </article>
              );
            }}
          </For>
          <Show when={!shown().length}>
            <p class="muted pad">{q() || order() === "tasks" || sub() ? "Nothing here with that." : `Nothing in ${folderName(p.top)} yet. n makes one.`}</p>
          </Show>
        </div>
      </Show>

      <Show
        when={inSelectMode()}
        fallback={
          <footer class="lib-foot">
            <KeyHints
              hints={[
                [copy() && p.view === "split" ? "↑ ↓" : "← → ↑ ↓", copy() ? "cards" : "pages"],
                ["Enter", copy() ? "copy" : "read"],
                !(copy() && p.view === "split") && ["Space", "peek"],
                ["x", "select"],
                ["e", copy() ? "edit" : "write in it"],
                ["t", "look & kind"],
                ["/", "filter"],
              ]}
            />
            <span class="grow" />
            <KeyHints hints={[["Esc", "back to writing"]]} />
          </footer>
        }
      >
        <footer class="lib-foot selection-bar" role="region" aria-label="Selection actions">
          <span class="sel-count">
            <b>{selected().size}</b> selected
          </span>
          <button type="button" class="btn small" onClick={() => runBatch("move")}>
            Move <kbd>m</kbd>
          </button>
          <button type="button" class="btn small" onClick={() => runBatch("pin")}>
            Pin <kbd>p</kbd>
          </button>
          <button type="button" class="btn small" onClick={() => runBatch("copy")}>
            Copy joined <kbd>c</kbd>
          </button>
          <button type="button" class="btn small danger" onClick={() => runBatch("delete")}>
            Delete <kbd>d</kbd>
          </button>
          <span class="grow" />
          <button type="button" class="btn small" onClick={clearSelection}>
            Clear <kbd>Esc</kbd>
          </button>
        </footer>
      </Show>
    </div>
  );
}
