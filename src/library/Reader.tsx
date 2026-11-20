// A collection of pages (Travel, Work, Journal), read rather than copied: the pages on the left, grouped by
// month with their first line and subfolder tag, and the selected one on the right as it reads, with images,
// tickable tasks, code copy and what links to it. Enter writes in it; x or hover-check enters multi-select for
// batch Move, Pin, Copy joined and Delete; t sets look & kind; / filters.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type BackRef, type Note, type NoteSummary } from "../api";
import { folderName, KeyHints, say, typing, undoLast } from "../ui";
import Mark, { hueClass } from "./Mark";
import { plain, subOf } from "./preview";
import ReadNote from "./ReadNote";
import { pruneSelection, rangeSelection, toggleSelection } from "./selection";
import { loadTaskCounts, tasksOf } from "./taskCounts";

type Order = "new" | "az" | "pinned" | "tasks";

const hasOpenTask = (n: NoteSummary) => tasksOf(n.id) > 0;

const firstLine = (n: NoteSummary) =>
  n.preview
    .split("\n")
    .map((l) => plain(l))
    .find((l) => l && l !== n.title) ?? "";

export default function Reader(p: {
  top: string;
  notes: NoteSummary[];
  onEdit(id: number): void;
  onNew(folder: string): void;
  onMove(n: Note): void;
  onMoveMany(ns: NoteSummary[]): void;
  onDelete(n: Note): void;
  onDeleteMany(ns: NoteSummary[]): void;
  onPin(n: NoteSummary): void;
  onPinMany(ns: NoteSummary[]): void;
  onCopyMany(ns: NoteSummary[]): void;
  onFace(top: string): void;
  onView?(v: "cards" | "split"): void;
  onChanged(): void;
  /** Something else (a list over this one) has the keys. */
  busy?: boolean;
  /** The page to show first: the card it was opened from. */
  start?: number;
  /** Esc: back to the collection's cards. */
  onBack?(): void;
}) {
  let filterInput!: HTMLInputElement;
  let listEl: HTMLDivElement | undefined;
  const [q, setQ] = createSignal("");
  const [sub, setSub] = createSignal("");
  const [order, setOrder] = createSignal<Order>("new");
  const [sel, setSel] = createSignal<number | null>(p.start ?? null);
  const [selected, setSelected] = createSignal<Set<number>>(new Set());
  const [anchor, setAnchor] = createSignal<number | null>(null);
  createEffect(
    on(
      () => p.top,
      () => {
        setQ("");
        setSub("");
        setSel(null);
        setSelected(new Set<number>());
        setAnchor(null);
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => p.start,
      (id) => {
        if (id != null) setSel(id);
      },
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

  const shown = createMemo(() => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    const activeSub = sub();
    let ns = p.notes.filter((n) => {
      if (activeSub && subOf(n.folder, p.top) !== activeSub) return false;
      return words.every((w) => `${n.title} ${n.folder} ${n.preview}`.toLowerCase().includes(w));
    });
    if (order() === "pinned") ns = ns.filter((n) => n.pinned);
    if (order() === "tasks") ns = ns.filter(hasOpenTask);
    return order() === "az" ? [...ns].sort((a, b) => a.title.localeCompare(b.title)) : [...ns].sort((a, b) => b.modifiedAt - a.modifiedAt);
  });

  createEffect(() => {
    const cur = selected();
    if (cur.size) {
      const next = pruneSelection(cur, shown().map((n) => n.id));
      if (next.size !== cur.size) setSelected(next);
    }
  });

  const selectedItems = createMemo(() => shown().filter((n) => selected().has(n.id)));
  const inSelectMode = () => selected().size > 0;

  /** Month headings when the list is by date. */
  const monthOf = (n: NoteSummary) =>
    new Date(n.modifiedAt).toLocaleDateString(undefined, {
      month: "long",
      year: new Date(n.modifiedAt).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    });
  const current = () => shown().find((n) => n.id === sel()) ?? shown()[0];

  // The page on the right, read whole. Signals, not resources (App's Suspense would take the page away).
  const [note, setNote] = createSignal<Note | null>(null);
  const [links, setLinks] = createSignal<BackRef[]>([]);
  const load = (id: number) =>
    void api().then(async (s) => {
      const [n, b] = await Promise.all([s.peekNote(id), s.backlinks(id).catch(() => ({ linked: [], mentioned: [] }))]);
      if (current()?.id !== id) return;
      setNote(n);
      setLinks(b.linked.filter((x) => x.kind === "note").slice(0, 8));
    });
  createEffect(on(() => current()?.id, (id) => (id == null ? setNote(null) : load(id))));

  const body = () => {
    const n = note();
    if (!n) return "";
    // The title is shown above; a first line that only repeats it is left out.
    const lines = n.body.split("\n");
    return lines[0]?.replace(/^#\s+/, "").trim() === n.title ? lines.slice(1).join("\n") : n.body;
  };
  const offset = () => (note() && body() !== note()!.body ? 1 : 0);

  async function tick(line: number, done: boolean) {
    const n = note();
    if (!n) return;
    const lines = n.body.split("\n");
    const at = line + offset();
    const old = lines[at] ?? "";
    lines[at] = done ? old.replace("[ ]", "[x]") : old.replace(/\[[xX]\]/, "[ ]");
    try {
      const s = await api();
      const saved = await s.saveNote(n.id, lines.join("\n"), n.hash);
      setNote({ ...n, body: lines.join("\n"), hash: saved.hash, modifiedAt: saved.modifiedAt });
      if (saved.conflict) say(`It was also changed elsewhere; that copy is kept as ${saved.conflict}.`, { error: true });
      void loadTaskCounts();
      p.onChanged();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function copyPage() {
    const n = note();
    if (!n) return;
    try {
      await (await api()).copyText(n.body, false);
      say(`Copied “${n.title}”`);
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function follow(inner: string) {
    const r = await (await api()).resolveLink(inner);
    if (r.kind === "note") p.onEdit(r.id);
    else say("That note does not exist yet.");
  }

  const toggleItem = (id: number, shift = false) => {
    const ids = shown().map((n) => n.id);
    setSelected(shift ? rangeSelection(selected(), ids, anchor(), id) : toggleSelection(selected(), id));
    setAnchor(id);
  };

  const clearSelection = () => {
    setSelected(new Set<number>());
    setAnchor(null);
  };

  const runBatch = (act: "move" | "pin" | "copy" | "delete") => {
    const list = selectedItems();
    if (!list.length) return;
    if (act === "move") p.onMoveMany(list);
    else if (act === "pin") p.onPinMany(list);
    else if (act === "copy") p.onCopyMany(list);
    else if (act === "delete") p.onDeleteMany(list);
    clearSelection();
  };

  function step(by: number, extend = false) {
    const list = shown();
    if (!list.length) return;
    const cur = current();
    const i = list.findIndex((n) => n.id === cur?.id);
    const next = list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + by))];
    setSel(next.id);
    if (extend && cur) {
      const a = anchor() ?? cur.id;
      setAnchor(a);
      setSelected(rangeSelection(selected(), list.map((n) => n.id), a, next.id));
    }
    queueMicrotask(() => listEl?.querySelector(`[data-page="${next.id}"]`)?.scrollIntoView({ block: "nearest" }));
  }

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
      case "ArrowDown":
      case "j":
        step(1, e.shiftKey);
        break;
      case "ArrowUp":
      case "k":
        step(-1, e.shiftKey);
        break;
      case "x":
        if (n) toggleItem(n.id, e.shiftKey);
        else return;
        break;
      case "Enter":
      case "e":
        if (inSelectMode()) return;
        if (n) p.onEdit(n.id);
        else return;
        break;
      case "c":
        if (inSelectMode()) runBatch("copy");
        else void copyPage();
        break;
      case "m":
        if (inSelectMode()) runBatch("move");
        else if (note()) p.onMove(note()!);
        else return;
        break;
      case "d":
      case "Delete":
        if (inSelectMode()) runBatch("delete");
        else if (note()) p.onDelete(note()!);
        else return;
        break;
      case "p":
        if (inSelectMode()) runBatch("pin");
        else if (n) p.onPin(n);
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

  // Esc clears selection first, then goes back to the cards (when opened from cards), before App takes it.
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || p.busy || typing(e) || document.querySelector(".scrim")) return;
    if (inSelectMode()) {
      e.preventDefault();
      e.stopPropagation();
      clearSelection();
      return;
    }
    if (!p.onBack) return;
    e.preventDefault();
    e.stopPropagation();
    p.onBack();
  };

  onMount(() => {
    void loadTaskCounts();
    document.addEventListener("keydown", key);
    document.addEventListener("keydown", esc, true);
    queueMicrotask(() => listEl?.querySelector(".reader-row.on")?.scrollIntoView({ block: "center" }));
  });
  onCleanup(() => {
    document.removeEventListener("keydown", key);
    document.removeEventListener("keydown", esc, true);
  });

  const words = () => (note()?.body.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  const open = () => (note()?.body.match(/^\s*[-*] \[ \]/gm) ?? []).length;

  return (
    <div class={`reader ${hueClass(p.top)}`}>
      <section class="reader-list" aria-label={folderName(p.top)}>
        <div class="reader-head">
          <button type="button" class="mark-btn" title="Colour and kind (t)" aria-label={`Look and kind for ${folderName(p.top)}`} onClick={() => p.onFace(p.top)}>
            <Mark folder={p.top} class="tile" />
          </button>
          <h1>{folderName(p.top)}</h1>
          <span class="muted small">{p.notes.length}</span>
          <span class="grow" />
          <Show when={p.onView}>
            <div class="seg reader-view-seg" role="group" aria-label="Layout">
              <button type="button" onClick={() => p.onView?.("cards")}>
                Cards
              </button>
              <button type="button" class="on" aria-pressed={true}>
                Reader
              </button>
            </div>
          </Show>
          <button type="button" class="icon-btn" title="New page (n)" aria-label={`New page in ${folderName(p.top)}`} onClick={() => p.onNew(sub() ? `${p.top}/${sub()}` : p.top)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        <label class="lib-filter">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input ref={filterInput} placeholder={`Filter ${folderName(p.top)}`} aria-label="Filter" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
          <kbd>/</kbd>
        </label>
        <div class="reader-chips" role="group" aria-label="Order">
          <For each={[["new", "Newest"], ["az", "A–Z"], ["pinned", "Pinned"], ["tasks", "Open tasks"]] as [Order, string][]}>
            {([id, label]) => (
              <button type="button" class="chip" classList={{ on: order() === id }} aria-pressed={order() === id} onClick={() => setOrder(id)}>
                {label}
              </button>
            )}
          </For>
        </div>
        <Show when={subfolders().length}>
          <div class="reader-subs" role="group" aria-label="Subfolders">
            <button type="button" class="chip small" classList={{ on: !sub() }} onClick={() => setSub("")}>
              All
            </button>
            <For each={subfolders()}>
              {(s) => (
                <button type="button" class="chip small" classList={{ on: sub() === s }} onClick={() => setSub(s)}>
                  {folderName(s)}
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="reader-rows" classList={{ selecting: inSelectMode() }} ref={listEl}>
          <For each={shown()}>
            {(n, i) => {
              const isSel = () => selected().has(n.id);
              const subName = () => subOf(n.folder, p.top);
              return (
                <>
                  <Show when={order() !== "az" && (i() === 0 || monthOf(shown()[i() - 1]) !== monthOf(n))}>
                    <div class="reader-month">{monthOf(n)}</div>
                  </Show>
                  <div
                    class="reader-row"
                    classList={{ on: current()?.id === n.id, picked: isSel() }}
                    data-page={n.id}
                    onClick={(e) => {
                      if (inSelectMode() || e.shiftKey) toggleItem(n.id, e.shiftKey);
                      else setSel(n.id);
                    }}
                    onDblClick={() => !inSelectMode() && p.onEdit(n.id)}
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
                    <div class="reader-row-main">
                      <span class="reader-row-top">
                        <span class="reader-row-title">{n.title}</span>
                        <Show when={n.pinned}>
                          <span class="muted small">pinned</span>
                        </Show>
                        <span class="reader-row-date">{new Date(n.modifiedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
                      </span>
                      <span class="reader-row-text">
                        <Show when={subName()}>
                          <span class="card-sub-tag">{folderName(subName())}</span>{" "}
                        </Show>
                        {firstLine(n)}
                      </span>
                    </div>
                  </div>
                </>
              );
            }}
          </For>
          <Show when={!shown().length}>
            <p class="muted pad">{q() || order() !== "new" || sub() ? "Nothing here with that." : "No pages yet. n makes one."}</p>
          </Show>
        </div>
      </section>

      <article class="reader-page" aria-label={note()?.title ?? "Page"}>
        <Show when={note()} fallback={<div class="empty"><p class="muted">Pick a page on the left.</p></div>}>
          {(n) => (
            <>
              <div class="reader-bar">
                <span class="muted small">
                  Edited {new Date(n().modifiedAt).toLocaleDateString(undefined, { day: "numeric", month: "long" })} · {words()} words
                  {open() ? ` · ${open()} open ${open() === 1 ? "task" : "tasks"}` : ""}
                </span>
                <span class="grow" />
                <button type="button" class="btn small" onClick={() => void copyPage()}>
                  Copy <kbd>c</kbd>
                </button>
                <button type="button" class="btn small" onClick={() => p.onMove(n())}>
                  Move <kbd>m</kbd>
                </button>
                <button type="button" class="btn small primary" onClick={() => p.onEdit(n().id)}>
                  Write in it <kbd>Enter</kbd>
                </button>
              </div>
              <div class="reader-scroll">
                <div class="reader-text">
                  <h2 class="reader-title">{n().title}</h2>
                  <ReadNote body={body()} folder={n().folder} highlight={q()} onLink={(inner) => void follow(inner)} onTick={(line, done) => void tick(line, done)} />
                </div>
              </div>
              <Show when={links().length}>
                <div class="reader-links">
                  <span class="muted small">Links here</span>
                  <For each={links()}>
                    {(l) => (
                      <button type="button" class="chip" onClick={() => p.onEdit(l.id)}>
                        {l.title}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </article>

      <Show
        when={inSelectMode()}
        fallback={
          <footer class="lib-foot">
            <KeyHints hints={[["↑ ↓", "pages"], ["Enter", "write in it"], ["x", "select"], ["c", "copy"], ["m", "move"], ["p", "pin"], ["t", "look & kind"], ["/", "filter"]]} />
            <span class="grow" />
            <KeyHints hints={[["Esc", p.onBack ? "back to the cards" : "back to writing"]]} />
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
