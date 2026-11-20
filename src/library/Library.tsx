// The library (Ctrl L): everything at once on Shelves, one collection as Cards or Split (remembered per collection),
// and the Inbox as a list beside its inline Sheet (or one-at-a-time Review). Supports Quick Peek (Space), hue copy
// flash, look & kind (`t`) everywhere, and multi-selection batch Move, Pin, Copy joined, and Delete with undo.

import { createEffect, createMemo, createSignal, For, lazy, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type AiSuggestion, type Conflict, type Note, type NoteSummary } from "../api";
import { copyFilled, itemText } from "../collection/copyItem";
import { copyBody } from "../collection/snippetText";
import Destination, { type Target } from "../inbox/Destination";
import { fileCapture } from "../inbox/file";
import { keyLabel } from "../keys";
import { ago, folderName, Kbd, KeyHints, say, typing, undoLast } from "../ui";
import { topOf } from "./Card";
import Collection from "./Collection";
import type { LibraryData } from "./data";
import FacePicker from "./FacePicker";
import { toCopy } from "./faces";
import Mark, { faces, hueClass, loadFaces } from "./Mark";
import { plain } from "./preview";
import Reader from "./Reader";
import ReadNote from "./ReadNote";
import { pruneSelection, rangeSelection, toggleSelection } from "./selection";
import Settle from "./Settle";
import Sheet from "./Sheet";
import Shelves from "./Shelves";

// The review is a mode of the inbox's cards: one at a time, in the library's place.
const Review = lazy(() => import("../inbox/Review"));

export { loadLibrary, type LibraryData } from "./data";

function sortByUse(ns: NoteSummary[], copies: Record<string, number>): NoteSummary[] {
  return [...ns].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (copies[b.path] ?? 0) - (copies[a.path] ?? 0) || b.modifiedAt - a.modifiedAt);
}

export default function Library(p: {
  tab: string;
  data: LibraryData | undefined;
  aiReady: boolean;
  onTab(id: string): void;
  onEdit(id: number): void;
  onNew(folder: string): void;
  onChanged(): void;
  onAiSetup(): void;
  onReview(): void;
  /** The inbox, one card at a time. */
  reviewing?: boolean;
  onReviewDone?(): void;
}) {
  let grid!: HTMLDivElement;
  let filterInput!: HTMLInputElement;
  let rowsEl: HTMLDivElement | undefined;
  const [q, setQ] = createSignal("");
  const [sel, setSel] = createSignal<number | null>(null);
  const [inboxSelected, setInboxSelected] = createSignal<Set<number>>(new Set());
  const [inboxAnchor, setInboxAnchor] = createSignal<number | null>(null);
  const [moving, setMoving] = createSignal<Note | null>(null);
  const [movingMany, setMovingMany] = createSignal<NoteSummary[] | null>(null);
  const [facing, setFacing] = createSignal<string | null>(null);
  const [settling, setSettling] = createSignal<Conflict | null>(null);
  const [flashedId, setFlashedId] = createSignal<number | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  /** Per-collection Cards | Split preference (`ui.collView.<top>`). */
  const [views, setViews] = createSignal<Record<string, "cards" | "split">>({});
  onMount(() => {
    void api()
      .then((s) => s.uiSettings())
      .then((m) => {
        const out: Record<string, "cards" | "split"> = {};
        for (const [k, v] of Object.entries(m)) {
          if (k.startsWith("ui.collView.") && (v === "cards" || v === "split")) out[k.slice("ui.collView.".length)] = v;
        }
        setViews(out);
      }, () => {});
  });

  const pageTop = () => p.tab.slice(2);
  const collView = (): "cards" | "split" => views()[pageTop()] ?? "cards";
  const setCollView = (v: "cards" | "split") => {
    const top = pageTop();
    if (!top) return;
    setViews((prev) => ({ ...prev, [top]: v }));
    if (v === "cards") setReading(null);
    void api()
      .then((s) => s.setUiSetting(`ui.collView.${top}`, v))
      .catch(() => {});
  };

  /** A page opened from Shelves or a collection's cards, read beside the others until Esc. */
  const [reading, setReading] = createSignal<number | null>(null);
  let pendingRead: number | null = null;

  createEffect(
    on(
      () => p.tab,
      () => {
        setQ("");
        setSel(null);
        setInboxSelected(new Set<number>());
        setInboxAnchor(null);
        if (pendingRead !== null) {
          setReading(pendingRead);
          pendingRead = null;
        } else {
          setReading(null);
        }
      },
    ),
  );

  const isCollectionCopy = () => p.tab.startsWith("c:") && toCopy(pageTop(), faces());
  /** "all" is Shelves; a pages collection in split or with a reading page is Reader; otherwise Collection; inbox is list. */
  const mode = () =>
    p.reviewing
      ? "review"
      : p.tab === "all"
        ? "shelves"
        : p.tab.startsWith("c:")
          ? !isCollectionCopy() && (reading() !== null || collView() === "split")
            ? "reader"
            : "collection"
          : "list";

  /** The full note, for the move list. */
  const moveCard = (n: NoteSummary) => void api().then((s) => s.peekNote(n.id)).then(setMoving, (e) => say(errText(e), { error: true }));
  /** A card from the shelves or collection with blanks or versions (or Space peek), open as a sheet. */
  const [sheet, setSheet] = createSignal<NoteSummary | null>(null);
  /** Quick peek for a Page card (Space or Peek button). */
  const [peekPage, setPeekPage] = createSignal<Note | null>(null);

  function flash(id: number) {
    setFlashedId(id);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlashedId((cur) => (cur === id ? null : cur)), 1100);
  }

  async function copyCard(n: NoteSummary) {
    const t = await itemText(n.id).catch(() => null);
    if (!t) return;
    if (t.hasBlanks) setSheet(n);
    else if (await copyFilled(n, t.text)) {
      flash(n.id);
      p.onChanged();
    }
  }

  function peekCard(n: NoteSummary) {
    if (toCopy(n.folder, faces())) {
      setSheet(n);
    } else {
      void api()
        .then((s) => s.peekNote(n.id))
        .then(setPeekPage, (e) => say(errText(e), { error: true }));
    }
  }

  function readFromShelf(top: string, id: number) {
    pendingRead = id;
    p.onTab(`c:${top}`);
  }

  const pages = createMemo(() => (p.data?.notes ?? []).filter((n) => n.folder === pageTop() || n.folder.startsWith(`${pageTop()}/`)));
  const copies = (n: NoteSummary) => p.data?.copies[n.path] ?? 0;
  const match = (n: NoteSummary) => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${n.title} ${n.preview} ${n.tags.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const inbox = createMemo(() => (p.data?.notes ?? []).filter((n) => n.folder === "inbox").sort((a, b) => b.modifiedAt - a.modifiedAt));

  const conflicts = () => p.data?.conflicts ?? [];
  const items = createMemo((): NoteSummary[] => {
    const all = p.data?.notes ?? [];
    const use = p.data?.copies ?? {};
    if (p.tab === "inbox") return inbox().filter(match);
    if (p.tab === "all") return sortByUse(all.filter((n) => n.folder !== "inbox" && toCopy(n.folder, faces())), use).filter(match);
    const f = p.tab.slice(2);
    return sortByUse(all.filter((n) => n.folder === f || n.folder.startsWith(`${f}/`)), use).filter(match);
  });

  createEffect(() => {
    const cur = inboxSelected();
    if (cur.size) {
      const next = pruneSelection(cur, items().map((n) => n.id));
      if (next.size !== cur.size) setInboxSelected(next);
    }
  });

  const inboxSelectedItems = createMemo(() => items().filter((n) => inboxSelected().has(n.id)));
  const inInboxSelect = () => inboxSelected().size > 0;
  const current = () => items().find((n) => n.id === sel()) ?? items()[0];
  const heading = () => (p.tab === "inbox" ? "Inbox" : p.tab.startsWith("c:") ? folderName(p.tab.slice(2)) : "");

  async function file(note: Note, t: Target) {
    setMoving(null);
    try {
      const { change, text } = await fileCapture(note, t);
      const s = await api();
      say(text, { undo: () => s.undo(change.token.token).then(p.onChanged) });
      p.onChanged();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function fileMany(ns: NoteSummary[], t: Target) {
    setMovingMany(null);
    try {
      const s = await api();
      const whole = await s.peekNotes(ns.map((x) => x.id));
      const tokens: string[] = [];
      for (const note of whole) {
        const { change } = await fileCapture(note, t);
        tokens.push(change.token.token);
      }
      const n = tokens.length;
      if (n) {
        say(`Moved ${n} ${n === 1 ? "note" : "notes"}`, {
          undo: async () => {
            for (const tok of [...tokens].reverse()) await s.undo(tok);
            p.onChanged();
          },
        });
        p.onChanged();
      }
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  const fileSuggested = (note: Note, s: AiSuggestion) =>
    file(note, s.kind === "merge" && s.noteId != null ? { kind: "note", id: s.noteId, title: s.title } : { kind: "folder", folder: s.folder });

  async function remove(note: Pick<Note, "id">) {
    try {
      const s = await api();
      const t = await s.trashNote(note.id);
      say("Deleted", { undo: () => s.undo(t.token).then(p.onChanged) });
      p.onChanged();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function removeMany(ns: NoteSummary[]) {
    try {
      const s = await api();
      const tokens: string[] = [];
      for (const n of ns) {
        const t = await s.trashNote(n.id);
        tokens.push(t.token);
      }
      if (tokens.length) {
        say(`Deleted ${tokens.length} ${tokens.length === 1 ? "note" : "notes"}`, {
          undo: async () => {
            for (const tok of [...tokens].reverse()) await s.undo(tok);
            p.onChanged();
          },
        });
        p.onChanged();
      }
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function pin(n: NoteSummary) {
    try {
      await (await api()).pinNote(n.id, !n.pinned);
      say(n.pinned ? "Unpinned" : `Pinned to the front of ${folderName(topOf(n.folder))}`);
      p.onChanged();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function pinMany(ns: NoteSummary[]) {
    try {
      const s = await api();
      const wantPin = ns.some((n) => !n.pinned);
      for (const n of ns) await s.pinNote(n.id, wantPin);
      say(`${wantPin ? "Pinned" : "Unpinned"} ${ns.length} ${ns.length === 1 ? "note" : "notes"}`);
      p.onChanged();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function copyMany(ns: NoteSummary[]) {
    try {
      const s = await api();
      const whole = await s.peekNotes(ns.map((n) => n.id));
      const joined = whole.map((n) => copyBody(n)).filter(Boolean).join("\n\n---\n\n");
      if (!joined) return;
      await s.copyText(joined, false);
      say(`Copied ${whole.length} ${whole.length === 1 ? "item" : "items"}`);
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function tickPeek(line: number, done: boolean) {
    const n = peekPage();
    if (!n) return;
    const lines = n.body.split("\n");
    const firstIsTitle = lines[0]?.replace(/^#\s+/, "").trim() === n.title;
    const at = line + (firstIsTitle ? 1 : 0);
    const old = lines[at] ?? "";
    lines[at] = done ? old.replace("[ ]", "[x]") : old.replace(/\[[xX]\]/, "[ ]");
    try {
      const s = await api();
      const saved = await s.saveNote(n.id, lines.join("\n"), n.hash);
      setPeekPage({ ...n, body: lines.join("\n"), hash: saved.hash, modifiedAt: saved.modifiedAt });
      p.onChanged();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  /** Only a collection has a look of its own: not the inbox, not the top of the folder. */
  const canFace = (top: string) => !!top && top !== "inbox";

  const toggleInboxItem = (id: number, shift = false) => {
    const ids = items().map((n) => n.id);
    setInboxSelected(shift ? rangeSelection(inboxSelected(), ids, inboxAnchor(), id) : toggleSelection(inboxSelected(), id));
    setInboxAnchor(id);
  };

  const clearInboxSelection = () => {
    setInboxSelected(new Set<number>());
    setInboxAnchor(null);
  };

  const runInboxBatch = (act: "move" | "copy" | "delete") => {
    const list = inboxSelectedItems();
    if (!list.length) return;
    if (act === "move") setMovingMany(list);
    else if (act === "copy") void copyMany(list);
    else if (act === "delete") void removeMany(list);
    clearInboxSelection();
  };

  /** The row above or below, kept in view. */
  function step(by: number, extend = false) {
    const list = items();
    if (!list.length) return;
    const cur = current();
    const i = list.findIndex((n) => n.id === cur?.id);
    const next = list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + by))];
    setSel(next.id);
    if (extend && cur) {
      const a = inboxAnchor() ?? cur.id;
      setInboxAnchor(a);
      setInboxSelected(rangeSelection(inboxSelected(), list.map((n) => n.id), a, next.id));
    }
    queueMicrotask(() => rowsEl?.querySelector(`[data-card="${next.id}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  const escOverlay = (e: KeyboardEvent) => {
    if (e.key !== "Escape" && !(e.key === " " && peekPage())) return;
    if (peekPage()) {
      e.preventDefault();
      e.stopPropagation();
      setPeekPage(null);
      return;
    }
    if (e.key === "Escape" && mode() === "list" && inInboxSelect() && !typing(e) && !document.querySelector(".scrim")) {
      e.preventDefault();
      e.stopPropagation();
      clearInboxSelection();
    }
  };

  const key = (e: KeyboardEvent) => {
    if (mode() !== "list" || moving() || movingMany() || facing() !== null || settling() || peekPage() || e.altKey) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !typing(e)) {
      const list = items();
      if (!list.length) return;
      e.preventDefault();
      e.stopPropagation();
      setInboxSelected(new Set(list.map((n) => n.id)));
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    if (typing(e)) {
      if (e.target === filterInput && (e.key === "ArrowDown" || e.key === "Enter")) {
        e.preventDefault();
        filterInput.blur();
        if (e.key === "Enter" && current()) rowsEl?.querySelector<HTMLElement>(`[data-card="${current()!.id}"]`)?.focus();
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
        if (n) toggleInboxItem(n.id, e.shiftKey);
        else return;
        break;
      case "m":
        if (inInboxSelect()) runInboxBatch("move");
        else return;
        break;
      case "c":
        if (inInboxSelect()) runInboxBatch("copy");
        else return;
        break;
      case "d":
      case "Delete":
        if (inInboxSelect()) runInboxBatch("delete");
        else return;
        break;
      case "p":
        if (n && n.folder !== "inbox") void pin(n);
        else return;
        break;
      case "t":
        if (n && canFace(topOf(n.folder))) setFacing(topOf(n.folder));
        else return;
        break;
      case "r":
        if (inbox().length) p.onReview();
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
  onMount(() => {
    document.addEventListener("keydown", key);
    document.addEventListener("keydown", escOverlay, true);
    void loadFaces();
  });
  onCleanup(() => {
    document.removeEventListener("keydown", key);
    document.removeEventListener("keydown", escOverlay, true);
  });

  const meta = (n: NoteSummary) => {
    const out: string[] = [];
    const k = copies(n);
    if (p.tab === "all") out.push(folderName(topOf(n.folder)));
    if (n.pinned) out.push("pinned");
    if (p.data?.versions[n.id]) out.push(`${p.data.versions[n.id]} versions`);
    if (k) out.push(`${k}×`);
    if (n.folder === "inbox") out.push(ago(n.modifiedAt));
    return out.join(" · ");
  };

  const peekBody = () => {
    const n = peekPage();
    if (!n) return "";
    const lines = n.body.split("\n");
    return lines[0]?.replace(/^#\s+/, "").trim() === n.title ? lines.slice(1).join("\n") : n.body;
  };

  const overlayBusy = () => !!sheet() || !!moving() || !!movingMany() || facing() !== null || !!peekPage();

  return (
    <div class="library lib-split" ref={grid}>
      <Show when={p.reviewing}>
        <div class="lib-review">
          <Review aiReady={p.aiReady} onDone={() => p.onReviewDone?.()} onEdit={p.onEdit} onAiSetup={p.onAiSetup} onChanged={p.onChanged} />
        </div>
      </Show>
      <Show when={mode() === "shelves"}>
        <div class="lib-span">
          <Shelves
            data={p.data}
            onTab={p.onTab}
            onRead={readFromShelf}
            onEdit={p.onEdit}
            onCopy={(n) => void copyCard(n)}
            onPeek={peekCard}
            onFace={(top) => setFacing(top)}
            onReview={p.onReview}
            flashedId={flashedId()}
            busy={overlayBusy()}
          />
        </div>
      </Show>
      <Show when={mode() === "collection"}>
        <div class="lib-span">
          <Collection
            top={pageTop()}
            notes={pages()}
            copies={p.data?.copies ?? {}}
            versions={p.data?.versions ?? {}}
            firstVersion={p.data?.firstVersion ?? {}}
            blanks={p.data?.blanks ?? {}}
            aiReady={p.aiReady}
            view={collView()}
            onView={setCollView}
            onCopy={(n) => void copyCard(n)}
            onPeek={peekCard}
            onRead={(id) => setReading(id)}
            onEdit={p.onEdit}
            onNew={p.onNew}
            onMove={moveCard}
            onMoveMany={(ns) => setMovingMany(ns)}
            onPin={(n) => void pin(n)}
            onPinMany={(ns) => void pinMany(ns)}
            onCopyMany={(ns) => void copyMany(ns)}
            onDelete={(n) => void remove(n)}
            onDeleteMany={(ns) => void removeMany(ns)}
            onFace={(top) => setFacing(top)}
            onFile={fileSuggested}
            onChanged={p.onChanged}
            onAiSetup={p.onAiSetup}
            flashedId={flashedId()}
            busy={overlayBusy()}
          />
        </div>
      </Show>
      <Show when={mode() === "reader"}>
        <div class="lib-span">
          <Reader
            start={reading() ?? undefined}
            onBack={collView() === "cards" ? () => setReading(null) : undefined}
            onView={setCollView}
            top={pageTop()}
            notes={pages()}
            onEdit={p.onEdit}
            onNew={p.onNew}
            onMove={(n) => setMoving(n)}
            onMoveMany={(ns) => setMovingMany(ns)}
            onDelete={(n) => void remove(n)}
            onDeleteMany={(ns) => void removeMany(ns)}
            onPin={(n) => void pin(n)}
            onPinMany={(ns) => void pinMany(ns)}
            onCopyMany={(ns) => void copyMany(ns)}
            onFace={(top) => setFacing(top)}
            onChanged={p.onChanged}
            busy={!!moving() || !!movingMany() || facing() !== null}
          />
        </div>
      </Show>
      <Show when={mode() === "list"}>
        <section class="lib-list" aria-label={heading() || "Everything to copy"}>
          <div class="lib-list-head">
            <Show when={p.tab.startsWith("c:") && canFace(topOf(p.tab.slice(2)))} fallback={<Mark folder={p.tab === "inbox" ? "inbox" : p.tab.slice(2)} class="tile" />}>
              <button type="button" class="mark-btn" title="Colour and mark (t)" aria-label="Colour and mark" onClick={() => setFacing(topOf(p.tab.slice(2)))}>
                <Mark folder={p.tab.slice(2)} class="tile" />
              </button>
            </Show>
            <h1>{heading() || "Everything to copy"}</h1>
            <span class="muted small">{items().length}</span>
            <span class="grow" />
            <Show when={p.tab === "inbox" && inbox().length}>
              <button type="button" class="btn small" onClick={p.onReview}>
                One at a time <kbd>r</kbd>
              </button>
            </Show>
          </div>
          <label class="lib-filter">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input ref={filterInput} placeholder={heading() ? `Filter ${heading()}` : "Filter"} aria-label="Filter" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
            <kbd>/</kbd>
          </label>
          <div class="lib-rows" classList={{ selecting: inInboxSelect() }} ref={rowsEl}>
            <Show when={p.tab === "inbox" && !q()}>
              <For each={conflicts()}>
                {(c) => (
                  <button type="button" class="lib-row conflict" onClick={() => setSettling(c)}>
                    <span class="lib-row-top">
                      <span class="lib-row-title">{c.title}</span>
                      <span class="lib-row-meta">to settle</span>
                    </span>
                    <span class="lib-row-text">Changed in two places. Open it to keep one text, or both.</span>
                  </button>
                )}
              </For>
            </Show>
            <For each={items()}>
              {(n) => {
                const isSel = () => inboxSelected().has(n.id);
                return (
                  <div
                    class="lib-row lib-row-selectable"
                    classList={{ on: current()?.id === n.id, picked: isSel() }}
                    data-card={n.id}
                    onClick={(e) => {
                      if (inInboxSelect() || e.shiftKey) toggleInboxItem(n.id, e.shiftKey);
                      else setSel(n.id);
                    }}
                    onDblClick={() => !inInboxSelect() && p.onEdit(n.id)}
                  >
                    <button
                      type="button"
                      class="sel-check"
                      classList={{ on: isSel() }}
                      aria-label={isSel() ? `Deselect ${n.title}` : `Select ${n.title}`}
                      aria-pressed={isSel()}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleInboxItem(n.id, e.shiftKey);
                      }}
                    >
                      {isSel() ? "✓" : ""}
                    </button>
                    <div class="lib-row-body">
                      <span class="lib-row-top">
                        <span class="lib-row-title">{n.folder === "inbox" ? n.preview.split("\n")[0] || n.title : n.title}</span>
                        <span class="lib-row-meta">{meta(n)}</span>
                      </span>
                      <span class="lib-row-text">{(n.folder === "inbox" ? plain(n.preview.split("\n").slice(1).join("\n")) : plain(n.preview)) || ago(n.modifiedAt)}</span>
                    </div>
                  </div>
                );
              }}
            </For>
            <Show when={p.data && !items().length && !(p.tab === "inbox" && conflicts().length)}>
              <p class="muted pad">
                {q()
                  ? "Nothing matches."
                  : p.tab === "inbox"
                    ? `Inbox zero. Captures from ${keyLabel("capture")} land here until you file them.`
                    : p.tab === "all"
                      ? "Nothing to copy yet. Make a collection like Prompts or Snippets in the sidebar."
                      : "Nothing here yet."}
              </p>
            </Show>
            <Show when={p.tab.startsWith("c:")}>
              <button type="button" class="lib-new" onClick={() => p.onNew(p.tab.slice(2))}>
                New in {heading()} <Kbd keys={keyLabel("new")} />
              </button>
            </Show>
          </div>
        </section>
        <section class="lib-preview">
          <Show when={current()} keyed fallback={<div class="empty"><p class="muted">Pick something on the left.</p></div>}>
            {(n) => (
              <Sheet
                inline
                disabled={inInboxSelect()}
                id={n.id}
                copies={copies(n)}
                aiReady={p.aiReady}
                onClose={() => {}}
                onCopied={p.onChanged}
                onEdit={(i) => p.onEdit(i)}
                onMove={(x) => setMoving(x)}
                onFile={fileSuggested}
                onDelete={remove}
                onAiSetup={p.onAiSetup}
              />
            )}
          </Show>
        </section>
        <Show
          when={inInboxSelect()}
          fallback={
            <footer class="lib-foot">
              <KeyHints
                hints={[
                  ["↑ ↓", "move"],
                  ["Enter", p.tab === "inbox" ? "file" : "copy"],
                  ["x", "select"],
                  ["e", "edit"],
                  ["m", "move"],
                  ["d", "delete"],
                  p.tab === "inbox" && ["r", "one at a time"],
                  p.tab !== "inbox" && ["p", "pin"],
                  p.tab !== "inbox" && ["t", "look and kind"],
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
              <b>{inboxSelected().size}</b> selected
            </span>
            <button type="button" class="btn small" onClick={() => runInboxBatch("move")}>
              Move <kbd>m</kbd>
            </button>
            <button type="button" class="btn small" onClick={() => runInboxBatch("copy")}>
              Copy joined <kbd>c</kbd>
            </button>
            <button type="button" class="btn small danger" onClick={() => runInboxBatch("delete")}>
              Delete <kbd>d</kbd>
            </button>
            <span class="grow" />
            <button type="button" class="btn small" onClick={clearInboxSelection}>
              Clear <kbd>Esc</kbd>
            </button>
          </footer>
        </Show>
      </Show>

      <Show when={moving()}>
        {(n) => <Destination exclude={n().id} what={n().folder === "inbox" ? undefined : n().title} from={n().folder === "inbox" ? undefined : n().folder} onPick={(t) => void file(n(), t)} onClose={() => setMoving(null)} />}
      </Show>
      <Show when={movingMany()}>
        {(ns) => (
          <Destination
            exclude={ns().map((n) => n.id)}
            what={`${ns().length} selected ${ns().length === 1 ? "note" : "notes"}`}
            from={p.tab.startsWith("c:") ? pageTop() : undefined}
            onPick={(t) => void fileMany(ns(), t)}
            onClose={() => setMovingMany(null)}
          />
        )}
      </Show>
      <Show when={sheet()}>
        {(n) => (
          <Sheet
            id={n().id}
            copies={p.data?.copies[n().path] ?? 0}
            aiReady={p.aiReady}
            onClose={() => setSheet(null)}
            onCopied={p.onChanged}
            onEdit={(i) => (setSheet(null), p.onEdit(i))}
            onMove={(x) => (setSheet(null), setMoving(x))}
            onFile={(x, sg) => (setSheet(null), void fileSuggested(x, sg))}
            onDelete={(x) => (setSheet(null), void remove(x))}
            onAiSetup={p.onAiSetup}
          />
        )}
      </Show>
      <Show when={peekPage()}>
        {(n) => (
          <div class="scrim sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && setPeekPage(null)}>
            <div class={`peek-modal ${hueClass(n().folder)}`} role="dialog" aria-label={n().title}>
              <header class="peek-modal-head">
                <span class="lcard-where">
                  <Mark folder={n().folder} size={13} />
                  {folderName(topOf(n().folder))}
                </span>
                <span class="muted small">edited {ago(n().modifiedAt)}</span>
                <span class="grow" />
                <button
                  type="button"
                  class="btn small"
                  onClick={() => {
                    const target = n();
                    setPeekPage(null);
                    readFromShelf(topOf(target.folder), target.id);
                  }}
                >
                  Open in Reader
                </button>
                <button
                  type="button"
                  class="btn small primary"
                  onClick={() => {
                    const id = n().id;
                    setPeekPage(null);
                    p.onEdit(id);
                  }}
                >
                  Write in it
                </button>
                <button type="button" class="btn small" onClick={() => setPeekPage(null)}>
                  Close <kbd>Esc</kbd>
                </button>
              </header>
              <div class="peek-modal-body">
                <h2 class="reader-title">{n().title}</h2>
                <ReadNote
                  body={peekBody()}
                  folder={n().folder}
                  onLink={(inner) =>
                    void api()
                      .then((s) => s.resolveLink(inner))
                      .then((r) => {
                        if (r.kind === "note") (setPeekPage(null), p.onEdit(r.id));
                        else say("That note does not exist yet.");
                      })
                  }
                  onTick={(line, done) => void tickPeek(line, done)}
                />
              </div>
            </div>
          </div>
        )}
      </Show>
      <Show when={facing()}>{(top) => <FacePicker top={top()} onClose={() => setFacing(null)} />}</Show>
      <Show when={settling()}>
        {(c) => (
          <Settle
            conflict={c()}
            onClose={() => setSettling(null)}
            onDone={() => {
              setSettling(null);
              p.onChanged();
            }}
          />
        )}
      </Show>
    </div>
  );
}
