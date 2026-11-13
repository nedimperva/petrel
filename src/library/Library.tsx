// The library (Ctrl L): what you copy, as cards. Only collections of things to copy (Prompts, Snippets: `t` sets
// it) are rows of cards; collections of pages are tiles at the end, and their notes are found with Ctrl K. "All" is
// the shelf, the most used first; a collection's tab shows all its cards. The arrow keys move between cards, Enter
// opens one as a sheet, c copies, e edits, p pins, t sets the collection's look and kind, / filters, and in the inbox
// m files the card you are on and r reviews the inbox one card at a time. A note changed in two places is a card
// in the inbox until it is settled (Settle.tsx).

import { createEffect, createMemo, createSignal, For, lazy, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type AiSuggestion, type Conflict, type Note, type NoteSummary } from "../api";
import { hasVersions, versionsOf } from "../collection/versions";
import Destination, { type Target } from "../inbox/Destination";
import { fileCapture } from "../inbox/file";
import { ago, folderName, KeyHints, say, typing, undoLast } from "../ui";
import { topOf } from "./Card";
import FacePicker from "./FacePicker";
import Mark, { faces, loadFaces } from "./Mark";
import { toCopy } from "./faces";
import Collection from "./Collection";
import Reader from "./Reader";
import Settle from "./Settle";
import Shelves from "./Shelves";
import Sheet from "./Sheet";
import { copyFilled, itemText } from "../collection/copyItem";

// The review is a mode of the inbox's cards: one at a time, in the library's place.
const Review = lazy(() => import("../inbox/Review"));

export interface LibraryData {
  notes: NoteSummary[];
  copies: Record<string, number>;
  /** How many `## versions` a prompt or snippet has, by id, when it has two or more. */
  versions: Record<number, number>;
  /** Notes with a conflict copy beside them; the copies are not cards of their own. */
  conflicts: Conflict[];
}

export async function loadLibrary(): Promise<LibraryData> {
  const s = await api();
  const [all, copies, conflicts] = await Promise.all([s.listNotes({ limit: 5000 }), s.copyCounts(), s.conflicts().catch(() => [] as Conflict[])]);
  const copyIds = new Set(conflicts.map((c) => c.copy));
  const notes = all.filter((n) => !n.folder.startsWith(".") && !copyIds.has(n.id));
  // The preview has no headings in it, so the few prompts and snippets are read whole to count their versions.
  const versions: Record<number, number> = {};
  await Promise.all(
    notes
      .filter((n) => hasVersions(n.folder))
      .slice(0, 400)
      .map(async (n) => {
        const k = versionsOf((await s.peekNote(n.id).catch(() => null))?.body ?? "").length;
        if (k > 1) versions[n.id] = k;
      }),
  );
  return { notes, copies, versions, conflicts };
}

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
  const [moving, setMoving] = createSignal<Note | null>(null);
  const [facing, setFacing] = createSignal<string | null>(null);
  const [settling, setSettling] = createSignal<Conflict | null>(null);
  createEffect(on(() => p.tab, () => (setQ(""), setSel(null))));
  /** A page opened from a collection's cards, read beside the others until Esc. */
  const [reading, setReading] = createSignal<number | null>(null);
  createEffect(on(() => p.tab, () => setReading(null)));
  /** "all" is the shelves (Everything); a collection is its cards, and a page from them is read; the inbox is the list. */
  const mode = () => (p.reviewing ? "review" : p.tab === "all" ? "shelves" : p.tab.startsWith("c:") ? (reading() !== null ? "reader" : "collection") : "list");
  /** The full note, for the move list. */
  const moveCard = (n: NoteSummary) => void api().then((s) => s.peekNote(n.id)).then(setMoving, (e) => say(errText(e), { error: true }));
  /** A card from the shelves with blanks or versions, open as a sheet over them. */
  const [sheet, setSheet] = createSignal<NoteSummary | null>(null);
  async function copyCard(n: NoteSummary) {
    const t = await itemText(n.id).catch(() => null);
    if (!t) return;
    if (t.hasBlanks) setSheet(n);
    else if (await copyFilled(n, t.text)) p.onChanged();
  }
  const pageTop = () => p.tab.slice(2);
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

  async function pin(n: NoteSummary) {
    try {
      await (await api()).pinNote(n.id, !n.pinned);
      say(n.pinned ? "Unpinned" : `Pinned to the front of ${folderName(topOf(n.folder))}`);
      p.onChanged();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }
  /** Only a collection has a look of its own: not the inbox, not the top of the folder. */
  const canFace = (top: string) => !!top && top !== "inbox";

  /** The row above or below, kept in view. */
  function step(by: number) {
    const list = items();
    if (!list.length) return;
    const i = list.findIndex((n) => n.id === current()?.id);
    const next = list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + by))];
    setSel(next.id);
    queueMicrotask(() => rowsEl?.querySelector(`[data-card="${next.id}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  const key = (e: KeyboardEvent) => {
    if (mode() !== "list" || moving() || facing() !== null || settling() || e.ctrlKey || e.metaKey || e.altKey) return;
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
        step(1);
        break;
      case "ArrowUp":
      case "k":
        step(-1);
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
        // Typing a letter starts the filter, so finding needs no key first.
        if (e.key.length === 1 && /\S/.test(e.key) && !/[cdejkhlmprtz]/.test(e.key)) {
          filterInput.focus();
          return;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => {
    document.addEventListener("keydown", key);
    void loadFaces();
  });
  onCleanup(() => document.removeEventListener("keydown", key));

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

  return (
    <div class="library lib-split" ref={grid}>
      <Show when={p.reviewing}>
        <div class="lib-review">
          <Review aiReady={p.aiReady} onDone={() => p.onReviewDone?.()} onEdit={p.onEdit} onAiSetup={p.onAiSetup} onChanged={p.onChanged} />
        </div>
      </Show>
      <Show when={mode() === "shelves"}>
        <div class="lib-span">
          <Shelves data={p.data} onTab={p.onTab} onEdit={p.onEdit} onCopy={(n) => void copyCard(n)} onReview={p.onReview} busy={!!sheet() || !!moving()} />
        </div>
      </Show>
      <Show when={mode() === "collection"}>
        <div class="lib-span">
          <Collection
            top={pageTop()}
            notes={pages()}
            copies={p.data?.copies ?? {}}
            versions={p.data?.versions ?? {}}
            onCopy={(n) => void copyCard(n)}
            onRead={(id) => setReading(id)}
            onEdit={p.onEdit}
            onNew={p.onNew}
            onMove={moveCard}
            onPin={(n) => void pin(n)}
            onDelete={(n) => void remove(n)}
            busy={!!sheet() || !!moving() || facing() !== null}
          />
        </div>
      </Show>
      <Show when={mode() === "reader"}>
        <div class="lib-span">
          <Reader
            start={reading() ?? undefined}
            onBack={() => setReading(null)}
            top={pageTop()}
            notes={pages()}
            onEdit={p.onEdit}
            onNew={p.onNew}
            onMove={(n) => setMoving(n)}
            onDelete={(n) => void remove(n)}
            onPin={(n) => void pin(n)}
            onChanged={p.onChanged}
            busy={!!moving() || facing() !== null}
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
          <div class="lib-rows" ref={rowsEl}>
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
              {(n) => (
                <button
                  type="button"
                  class="lib-row"
                  classList={{ on: current()?.id === n.id }}
                  data-card={n.id}
                  onClick={() => setSel(n.id)}
                  onDblClick={() => p.onEdit(n.id)}
                >
                  <span class="lib-row-top">
                    <span class="lib-row-title">{n.folder === "inbox" ? n.preview.split("\n")[0] || n.title : n.title}</span>
                    <span class="lib-row-meta">{meta(n)}</span>
                  </span>
                  <span class="lib-row-text">{(n.folder === "inbox" ? n.preview.split("\n").slice(1).join(" ") : n.preview.replace(/\n/g, " ")) || ago(n.modifiedAt)}</span>
                </button>
              )}
            </For>
            <Show when={p.data && !items().length && !(p.tab === "inbox" && conflicts().length)}>
              <p class="muted pad">
                {q()
                  ? "Nothing matches."
                  : p.tab === "inbox"
                    ? "Inbox zero. Captures from Ctrl Alt Space land here until you file them."
                    : p.tab === "all"
                      ? "Nothing to copy yet. Make a collection like Prompts or Snippets in the sidebar."
                      : "Nothing here yet."}
              </p>
            </Show>
            <Show when={p.tab.startsWith("c:")}>
              <button type="button" class="lib-new" onClick={() => p.onNew(p.tab.slice(2))}>
                New in {heading()} <kbd>Ctrl N</kbd>
              </button>
            </Show>
          </div>
        </section>
        <section class="lib-preview">
          <Show when={current()} keyed fallback={<div class="empty"><p class="muted">Pick something on the left.</p></div>}>
            {(n) => (
              <Sheet
                inline
                id={n.id}
                copies={copies(n)}
                aiReady={p.aiReady}
                onClose={() => {}}
                onEdit={(i) => p.onEdit(i)}
                onMove={(x) => setMoving(x)}
                onFile={fileSuggested}
                onDelete={remove}
                onAiSetup={p.onAiSetup}
              />
            )}
          </Show>
        </section>
        <footer class="lib-foot">
          <KeyHints
            hints={[
              ["↑ ↓", "move"],
              ["Enter", p.tab === "inbox" ? "file" : "copy"],
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
      </Show>

      <Show when={moving()}>
        {(n) => <Destination exclude={n().id} what={n().folder === "inbox" ? undefined : n().title} from={n().folder === "inbox" ? undefined : n().folder} onPick={(t) => void file(n(), t)} onClose={() => setMoving(null)} />}
      </Show>
      <Show when={sheet()}>
        {(n) => (
          <Sheet
            id={n().id}
            copies={p.data?.copies[n().path] ?? 0}
            aiReady={p.aiReady}
            onClose={() => setSheet(null)}
            onEdit={(i) => (setSheet(null), p.onEdit(i))}
            onMove={(x) => (setSheet(null), setMoving(x))}
            onFile={(x, sg) => (setSheet(null), void fileSuggested(x, sg))}
            onDelete={(x) => (setSheet(null), void remove(x))}
            onAiSetup={p.onAiSetup}
          />
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
