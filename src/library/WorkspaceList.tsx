// Unified Workspace List: one calm slim list column for Inbox, To-copy collections, and Pages collections.
// Replaces Shelves, Collection cards, Reader, and Review:
// - Clicking a Page opens it LIVE and EDITABLE right beside this list.
// - Clicking a To-copy card shows it with inline-editable `{{blanks}}` right beside this list.
// - Clicking an Inbox capture shows it with its 1-Click Filing Bar right beside this list.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { Conflict, NoteSummary } from "../api";
import { listName } from "../journal/days";
import { ago, folderName, Kbd, typing, undoLast } from "../ui";
import { keyLabel } from "../keys";
import type { LibraryData } from "./data";
import { toCopy } from "./faces";
import Mark, { faces, hueClass } from "./Mark";
import { blankNames, plain, subOf } from "./preview";
import { pruneSelection, rangeSelection, toggleSelection } from "./selection";
import { loadTaskCounts, tasksOf } from "./taskCounts";

type Order = "default" | "az" | "tasks";

export default function WorkspaceList(p: {
  /** `"inbox"` or `"c:<folder>"`. */
  place: string;
  data: LibraryData | undefined;
  /** Currently selected note id in the right stage. */
  activeId: number | null;
  /** Paths snoozed until tomorrow in Inbox. */
  snoozed?: Set<string>;
  onSelect(n: NoteSummary): void;
  onNew(folder: string): void;
  onMoveMany(ns: NoteSummary[]): void;
  onPinMany(ns: NoteSummary[]): void;
  onCopyMany(ns: NoteSummary[]): void;
  onDeleteMany(ns: NoteSummary[]): void;
  onSettle(c: Conflict): void;
  onFace(top: string): void;
  onPin(n: NoteSummary): void;
  /** True when a modal or overlay has keyboard focus. */
  busy?: boolean;
}) {
  let filterInput!: HTMLInputElement;
  let rowsEl: HTMLDivElement | undefined;
  const [q, setQ] = createSignal("");
  const [sub, setSub] = createSignal("");
  const [order, setOrder] = createSignal<Order>("default");
  const [selected, setSelected] = createSignal<Set<number>>(new Set());
  const [anchor, setAnchor] = createSignal<number | null>(null);

  const isInbox = () => p.place === "inbox";
  const folder = () => (p.place.startsWith("c:") ? p.place.slice(2) : "");
  const isCopy = () => !isInbox() && toCopy(folder(), faces());
  const title = () => (isInbox() ? "Inbox" : folderName(folder()));

  createEffect(on(() => p.data, () => void loadTaskCounts()));
  createEffect(
    on(
      () => p.place,
      () => {
        setQ("");
        setSub("");
        setOrder("default");
        setSelected(new Set<number>());
        setAnchor(null);
      },
    ),
  );

  const raw = createMemo(() => {
    const all = p.data?.notes ?? [];
    if (isInbox()) {
      const sn = p.snoozed;
      return all.filter((n) => n.folder === "inbox" && !(sn && sn.has(n.path)));
    }
    const f = folder();
    return f === "" ? all.filter((n) => n.folder === "") : all.filter((n) => n.folder === f || n.folder.startsWith(`${f}/`));
  });

  const subfolders = createMemo(() => {
    if (isInbox() || !folder()) return [];
    const seen = new Set<string>();
    for (const n of raw()) {
      const s = subOf(n.folder, folder());
      if (s) seen.add(s);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  });

  const uses = (n: NoteSummary) => p.data?.copies[n.path] ?? 0;

  const items = createMemo(() => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    const activeSub = sub();
    let ns = raw().filter((n) => {
      if (activeSub && subOf(n.folder, folder()) !== activeSub) return false;
      return words.every((w) => `${n.title} ${n.folder} ${n.preview} ${n.tags.join(" ")}`.toLowerCase().includes(w));
    });
    if (order() === "tasks") ns = ns.filter((n) => tasksOf(n.id) > 0);
    const pin = (a: NoteSummary, b: NoteSummary) => Number(b.pinned) - Number(a.pinned);
    if (order() === "az") return [...ns].sort((a, b) => a.title.localeCompare(b.title));
    if (isCopy()) return [...ns].sort((a, b) => pin(a, b) || uses(b) - uses(a) || b.modifiedAt - a.modifiedAt);
    return [...ns].sort((a, b) => pin(a, b) || b.modifiedAt - a.modifiedAt);
  });

  createEffect(() => {
    const cur = selected();
    if (cur.size) {
      const next = pruneSelection(cur, items().map((n) => n.id));
      if (next.size !== cur.size) setSelected(next);
    }
  });

  const selectedItems = createMemo(() => items().filter((n) => selected().has(n.id)));
  const inSelect = () => selected().size > 0;
  const conflicts = () => (isInbox() && !q() ? (p.data?.conflicts ?? []) : []);
  const blanksOf = (n: NoteSummary) => p.data?.blanks[n.id] ?? blankNames(p.data?.firstVersion[n.id] ?? n.preview);

  const toggleItem = (id: number, shift = false) => {
    const ids = items().map((n) => n.id);
    setSelected(shift ? rangeSelection(selected(), ids, anchor(), id) : toggleSelection(selected(), id));
    setAnchor(id);
  };
  const clearSelect = () => (setSelected(new Set<number>()), setAnchor(null));

  const runBatch = (act: "move" | "pin" | "copy" | "delete") => {
    const list = selectedItems();
    if (!list.length) return;
    if (act === "move") p.onMoveMany(list);
    else if (act === "pin") p.onPinMany(list);
    else if (act === "copy") p.onCopyMany(list);
    else if (act === "delete") p.onDeleteMany(list);
    clearSelect();
  };

  function step(by: number, extend = false) {
    const list = items();
    if (!list.length) return;
    const idx = list.findIndex((n) => n.id === p.activeId);
    const next = list[Math.min(list.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + by))];
    p.onSelect(next);
    if (extend && idx >= 0) {
      const a = anchor() ?? list[idx].id;
      setAnchor(a);
      setSelected(rangeSelection(selected(), list.map((n) => n.id), a, next.id));
    }
    queueMicrotask(() => rowsEl?.querySelector(`[data-row="${next.id}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  const onKey = (e: KeyboardEvent) => {
    if (p.busy || e.altKey || document.querySelector(".scrim")) return;
    if (e.key === "Escape" && inSelect() && !typing(e)) {
      e.preventDefault();
      e.stopPropagation();
      clearSelect();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !typing(e)) {
      const list = items();
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
        if (items()[0]) p.onSelect(items()[0]);
      } else if (e.target === filterInput && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setQ("");
        filterInput.blur();
      }
      return;
    }
    const cur = items().find((n) => n.id === p.activeId) ?? items()[0];
    switch (e.key) {
      case "ArrowDown":
      case "j":
        step(1, e.shiftKey);
        break;
      case "ArrowUp":
      case "k":
        step(-1, e.shiftKey);
        break;
      case "x":
        if (cur) toggleItem(cur.id, e.shiftKey);
        else return;
        break;
      case "m":
        if (inSelect()) runBatch("move");
        else return;
        break;
      case "p":
        if (inSelect()) runBatch("pin");
        else if (cur && !isInbox()) p.onPin(cur);
        else return;
        break;
      case "c":
        if (inSelect()) runBatch("copy");
        else return;
        break;
      case "d":
      case "Delete":
        if (inSelect()) runBatch("delete");
        else return;
        break;
      case "t":
        if (!isInbox() && folder()) p.onFace(folder().split("/")[0]);
        else return;
        break;
      case "n":
        if (!isInbox()) p.onNew(sub() ? `${folder()}/${sub()}` : folder());
        else return;
        break;
      case "/":
        filterInput.focus();
        break;
      case "z":
        if (!undoLast()) return;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  const firstLine = (n: NoteSummary) => {
    const rawLine = n.folder === "inbox" ? n.preview.split("\n").slice(1).join(" ") : n.preview;
    return plain(rawLine);
  };

  return (
    <section class={`ws-list ${hueClass(folder() || "inbox")}`} aria-label={title()}>
      <div class="ws-list-head">
        <Show
          when={!isInbox() && folder()}
          fallback={<Mark folder="inbox" class="tile" />}
        >
          <button type="button" class="mark-btn" title="Colour and kind (t)" aria-label={`Look and kind for ${title()}`} onClick={() => p.onFace(folder().split("/")[0])}>
            <Mark folder={folder()} class="tile" />
          </button>
        </Show>
        <h2>{title()}</h2>
        <span class="muted small">{items().length}</span>
        <span class="grow" />
        <Show when={!isInbox()}>
          <button
            type="button"
            class="icon-btn"
            title={`New in ${title()} (n)`}
            aria-label={`New in ${title()}`}
            onClick={() => p.onNew(sub() ? `${folder()}/${sub()}` : folder())}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </Show>
      </div>

      <label class="lib-filter ws-filter">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input ref={filterInput} placeholder={`Filter ${title()}`} aria-label={`Filter ${title()}`} value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
        <kbd>/</kbd>
      </label>

      <Show when={!isInbox()}>
        <div class="ws-list-chips" role="group" aria-label="Sort">
          <button type="button" class="chip small" classList={{ on: order() === "default" }} onClick={() => setOrder("default")}>
            {isCopy() ? "Most used" : "Newest"}
          </button>
          <button type="button" class="chip small" classList={{ on: order() === "az" }} onClick={() => setOrder("az")}>
            A–Z
          </button>
          <Show when={!isCopy()}>
            <button type="button" class="chip small" classList={{ on: order() === "tasks" }} onClick={() => setOrder("tasks")}>
              Open tasks
            </button>
          </Show>
        </div>
      </Show>

      <Show when={subfolders().length}>
        <div class="ws-list-chips" role="group" aria-label="Subfolders">
          <button type="button" class="chip small" classList={{ on: !sub() }} onClick={() => setSub("")}>All</button>
          <For each={subfolders()}>
            {(s) => (
              <button type="button" class="chip small" classList={{ on: sub() === s }} onClick={() => setSub(s)}>
                {folderName(s)}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="ws-list-rows" classList={{ selecting: inSelect() }} ref={rowsEl}>
        <For each={conflicts()}>
          {(c) => (
            <button type="button" class="ws-row conflict" onClick={() => p.onSettle(c)}>
              <div class="ws-row-top">
                <span class="ws-row-title">{c.title}</span>
                <span class="ws-row-meta bad">to settle</span>
              </div>
              <span class="ws-row-sub">Changed in two places — click to pick which to keep</span>
            </button>
          )}
        </For>

        <For each={items()}>
          {(n) => {
            const isSel = () => selected().has(n.id);
            const subName = () => (!isInbox() && folder() ? subOf(n.folder, folder()) : "");
            const bs = () => (isCopy() ? blanksOf(n).length : 0);
            const vCount = () => p.data?.versions[n.id] ?? 0;
            const k = () => uses(n);
            return (
              <div
                class="ws-row"
                classList={{ on: p.activeId === n.id, picked: isSel() }}
                data-row={n.id}
                onClick={(e) => {
                  if (inSelect() || e.shiftKey) toggleItem(n.id, e.shiftKey);
                  else p.onSelect(n);
                }}
              >
                <button
                  type="button"
                  class="sel-check"
                  classList={{ on: isSel() }}
                  aria-label={isSel() ? `Deselect ${n.title}` : `Select ${n.title}`}
                  onClick={(e) => (e.stopPropagation(), toggleItem(n.id, e.shiftKey))}
                >
                  {isSel() ? "✓" : ""}
                </button>
                <div class="ws-row-body">
                  <div class="ws-row-top">
                    <span class="ws-row-title">{isInbox() ? n.preview.split("\n")[0] || n.title : listName(n)}</span>
                    <Show when={vCount()}>{(v) => <span class="scard-badge">{v()}v</span>}</Show>
                    <span class="ws-row-meta">
                      {isCopy()
                        ? k() ? `${k()}×` : bs() ? `${bs()}b` : ""
                        : ago(n.modifiedAt)}
                    </span>
                  </div>
                  <div class="ws-row-sub">
                    <Show when={subName()}><span class="card-sub-tag">{folderName(subName())}</span> </Show>
                    <Show when={n.pinned}><span class="muted">pinned · </span></Show>
                    {firstLine(n) || (isCopy() ? ago(n.modifiedAt) : "")}
                  </div>
                </div>
              </div>
            );
          }}
        </For>

        <Show when={p.data && !items().length && !conflicts().length}>
          <p class="muted pad">
            {q() || order() === "tasks" || sub()
              ? "Nothing matches."
              : isInbox()
                ? `Inbox zero. Captures from ${keyLabel("capture")} land here.`
                : `Nothing in ${title()} yet.`}
          </p>
        </Show>

        <Show when={!isInbox()}>
          <button type="button" class="lib-new" onClick={() => p.onNew(sub() ? `${folder()}/${sub()}` : folder())}>
            New in {title()} <Kbd keys={keyLabel("new")} />
          </button>
        </Show>
      </div>

      <Show when={inSelect()}>
        <footer class="ws-batch-bar" role="region" aria-label="Selection actions">
          <span class="sel-count"><b>{selected().size}</b></span>
          <button type="button" class="btn small" onClick={() => runBatch("move")}>Move</button>
          <Show when={!isInbox()}>
            <button type="button" class="btn small" onClick={() => runBatch("pin")}>Pin</button>
          </Show>
          <button type="button" class="btn small" onClick={() => runBatch("copy")}>Copy</button>
          <button type="button" class="btn small danger" onClick={() => runBatch("delete")}>Delete</button>
          <span class="grow" />
          <button type="button" class="btn small" onClick={clearSelect}>Esc</button>
        </footer>
      </Show>
    </section>
  );
}
