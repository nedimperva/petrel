// The library (Ctrl L): what you copy, as cards. Only collections of things to copy (Prompts, Snippets: `t` sets
// it) are rows of cards; collections of pages are tiles at the end, and their notes are found with Ctrl K. "All" is
// the shelf, the most used first; a collection's tab shows all its cards. The arrow keys move between cards, Enter
// opens one as a sheet, c copies, e edits, p pins, t sets the collection's look and kind, / filters, and in the inbox
// m files the card you are on and r reviews the inbox one card at a time. A note changed in two places is a card
// in the inbox until it is settled (Settle.tsx).

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type AiSuggestion, type Conflict, type Note, type NoteSummary } from "../api";
import { hasVersions, versionsOf } from "../collection/versions";
import { copyFilled, itemText } from "../collection/copyItem";
import Destination, { type Target } from "../inbox/Destination";
import { fileCapture } from "../inbox/file";
import { folderName, say, typing, undoLast } from "../ui";
import type { Tab } from "../TitleBar";
import Card, { topOf } from "./Card";
import FacePicker from "./FacePicker";
import Mark, { faces, loadFaces } from "./Mark";
import { toCopy } from "./faces";
import Settle from "./Settle";
import Sheet from "./Sheet";

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

/** The title bar's tabs: All, the Inbox, then each collection, the most used first. */
export function libraryTabs(d: LibraryData | undefined): Tab[] {
  if (!d) return [{ id: "all", label: "All" }];
  const inbox = d.notes.filter((n) => n.folder === "inbox").length;
  return [
    { id: "all", label: "All" },
    { id: "inbox", label: "Inbox", count: inbox || undefined },
    ...collections(d).map((c) => ({ id: `c:${c.top}`, label: folderName(c.top) })),
  ];
}

function collections(d: LibraryData): { top: string; notes: NoteSummary[]; use: number }[] {
  const by = new Map<string, NoteSummary[]>();
  for (const n of d.notes) {
    if (n.folder === "inbox") continue;
    const t = topOf(n.folder);
    by.set(t, [...(by.get(t) ?? []), n]);
  }
  return [...by.entries()]
    .map(([top, notes]) => ({ top, notes: sortByUse(notes, d.copies), use: notes.reduce((a, n) => a + (d.copies[n.path] ?? 0), 0) }))
    .sort((a, b) => b.use - a.use || b.notes.length - a.notes.length || a.top.localeCompare(b.top));
}

function sortByUse(ns: NoteSummary[], copies: Record<string, number>): NoteSummary[] {
  return [...ns].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (copies[b.path] ?? 0) - (copies[a.path] ?? 0) || b.modifiedAt - a.modifiedAt);
}

const ROW = 4;

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
}) {
  let grid!: HTMLDivElement;
  let filterInput!: HTMLInputElement;
  const [q, setQ] = createSignal("");
  const [sel, setSel] = createSignal<number | null>(null);
  const [open, setOpen] = createSignal<number | null>(null);
  const [moving, setMoving] = createSignal<Note | null>(null);
  const [facing, setFacing] = createSignal<string | null>(null);
  const [settling, setSettling] = createSignal<Conflict | null>(null);
  // The card just copied lights up once in its collection's colour.
  const [flash, setFlash] = createSignal<number | null>(null);
  createEffect(on(() => p.tab, () => (setQ(""), setSel(null))));

  const copies = (n: NoteSummary) => p.data?.copies[n.path] ?? 0;
  const match = (n: NoteSummary) => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${n.title} ${n.preview} ${n.tags.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const cols = createMemo(() => (p.data ? collections(p.data) : []));
  const inbox = createMemo(() => (p.data?.notes ?? []).filter((n) => n.folder === "inbox").sort((a, b) => b.modifiedAt - a.modifiedAt));

  /** Shelf rows, or the one collection's cards. */
  const conflicts = () => p.data?.conflicts ?? [];
  const pageCols = createMemo(() => cols().filter((c) => !toCopy(c.top, faces())));
  const shelf = createMemo(() => {
    const rows: { id: string; top: string; label: string; sub: string; notes: NoteSummary[]; total: number }[] = [];
    if (inbox().length || conflicts().length)
      rows.push({ id: "inbox", top: "inbox", label: "Inbox", sub: "captures waiting for a home", notes: inbox().filter(match), total: inbox().length });
    for (const c of cols()) {
      if (!toCopy(c.top, faces())) continue;
      const ns = c.notes.filter(match);
      rows.push({ id: `c:${c.top}`, top: c.top, label: folderName(c.top), sub: c.use ? "most copied first" : "newest first", notes: ns, total: c.notes.length });
    }
    return rows.filter((r) => r.notes.length || (r.id === "inbox" && conflicts().length && !q()));
  });
  /** A note changed in two places: a card in the inbox until it is settled. */
  const conflictCard = (c: Conflict) => (
    <button type="button" class="lcard conflict" onClick={() => setSettling(c)}>
      <div class="lcard-top">
        <span class="lcard-where">To settle · {folderName(c.folder)}</span>
      </div>
      <h3 class="lcard-title">{c.title}</h3>
      <div class="lcard-body">Changed in two places. Open it to compare the two texts and keep one, or both.</div>
      <footer class="lcard-meta">Settle</footer>
    </button>
  );
  const items = createMemo((): NoteSummary[] => {
    if (p.tab === "all") return shelf().flatMap((r) => r.notes.slice(0, ROW));
    if (p.tab === "inbox") return inbox().filter(match);
    const top = p.tab.slice(2);
    return (cols().find((c) => c.top === top)?.notes ?? []).filter(match);
  });
  const current = () => items().find((n) => n.id === sel()) ?? items()[0];
  const heading = () => (p.tab === "inbox" ? "Inbox" : p.tab.startsWith("c:") ? folderName(p.tab.slice(2)) : "");
  const tags = createMemo(() => {
    const seen = new Map<string, number>();
    for (const n of items()) for (const t of n.tags) seen.set(t, (seen.get(t) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
  });

  async function copy(n: NoteSummary) {
    const it = await itemText(n.id);
    if (it.hasBlanks) return setOpen(n.id);
    if (await copyFilled(n, it.text)) {
      setFlash(n.id);
      setTimeout(() => flash() === n.id && setFlash(null), 700);
      p.onChanged();
    }
  }

  async function file(note: Note, t: Target) {
    setMoving(null);
    setOpen(null);
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

  async function remove(note: Note) {
    setOpen(null);
    try {
      const s = await api();
      const t = await s.trashNote(note.id);
      say("Deleted", { undo: () => s.undo(t.token).then(p.onChanged) });
      p.onChanged();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }
  const moveSummary = async (n: NoteSummary) => setMoving(await (await api()).peekNote(n.id));

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

  /** The nearest card in a direction, by where the cards are drawn, so the shelf and the columns move alike. */
  function step(dx: number, dy: number) {
    const cards = [...grid.querySelectorAll<HTMLElement>("[data-card]")];
    const at = cards.find((c) => Number(c.dataset.card) === current()?.id);
    if (!at) return cards[0] && setSel(Number(cards[0].dataset.card));
    const a = at.getBoundingClientRect();
    let best: HTMLElement | undefined;
    let score = Infinity;
    for (const c of cards) {
      if (c === at) continue;
      const b = c.getBoundingClientRect();
      const ddx = b.left + b.width / 2 - (a.left + a.width / 2);
      const ddy = b.top + b.height / 2 - (a.top + a.height / 2);
      const along = dx ? ddx * dx : ddy * dy;
      if (along <= 4) continue;
      const across = dx ? Math.abs(ddy) : Math.abs(ddx);
      const s = along + across * 3;
      if (s < score) (score = s), (best = c);
    }
    if (best) {
      setSel(Number(best.dataset.card));
      best.scrollIntoView({ block: "nearest" });
    }
  }

  const key = (e: KeyboardEvent) => {
    if (open() !== null || moving() || facing() !== null || settling() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing(e)) {
      if (e.target === filterInput && (e.key === "ArrowDown" || e.key === "Enter")) {
        e.preventDefault();
        filterInput.blur();
        if (e.key === "Enter" && current()) setOpen(current()!.id);
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
        step(1, 0);
        break;
      case "ArrowLeft":
      case "h":
        step(-1, 0);
        break;
      case "ArrowDown":
      case "j":
        step(0, 1);
        break;
      case "ArrowUp":
      case "k":
        step(0, -1);
        break;
      case "Enter":
        if (n) setOpen(n.id);
        break;
      case "c":
        if (n) void copy(n);
        break;
      case "e":
        if (n) p.onEdit(n.id);
        break;
      case "m":
        if (n?.folder === "inbox") void moveSummary(n);
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
        // Typing a letter starts the filter, so finding needs no key first.
        if (e.key.length === 1 && /\S/.test(e.key) && !/[cejkhlmprtz]/.test(e.key)) {
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

  const card = (n: NoteSummary, where = false) => (
    <Card
      n={n}
      copies={copies(n)}
      versions={p.data?.versions[n.id] ?? 0}
      on={current()?.id === n.id}
      flash={flash() === n.id}
      showWhere={where}
      onSelect={() => setSel(n.id)}
      onOpen={() => setOpen(n.id)}
      onCopy={() => void copy(n)}
      onEdit={() => p.onEdit(n.id)}
      onMove={n.folder === "inbox" ? () => void moveSummary(n) : undefined}
    />
  );

  return (
    <div class="library" ref={grid}>
      <div class="lib-head">
        <Show when={heading()}>
          <div class="lib-title">
            <Show when={p.tab.startsWith("c:") && canFace(p.tab.slice(2))}>
              <button type="button" class="mark-btn" title="Colour and mark (t)" aria-label="Colour and mark" onClick={() => setFacing(p.tab.slice(2))}>
                <Mark folder={p.tab.slice(2)} class="tile" />
              </button>
            </Show>
            <h1>{heading()}</h1>
            <Show when={p.tab === "inbox" && inbox().length}>
              <button type="button" class="btn small" onClick={p.onReview}>
                Review <kbd>r</kbd>
              </button>
            </Show>
            <span class="muted">
              {p.tab === "inbox"
                ? `${inbox().length} ${inbox().length === 1 ? "capture" : "captures"} to file`
                : `${items().length} ${items().length === 1 ? "note" : "notes"}, most copied first`}
            </span>
          </div>
        </Show>
        <label class="lib-filter">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={filterInput}
            placeholder={heading() ? `Filter ${heading()}` : "Filter everything"}
            aria-label="Filter"
            value={q()}
            onInput={(e) => setQ(e.currentTarget.value)}
          />
          <kbd>/</kbd>
        </label>
        <Show when={heading() && tags().length}>
          <div class="lib-tags">
            <For each={tags()}>
              {(t) => (
                <button type="button" class="chip" classList={{ on: q() === `${t}` }} onClick={() => setQ(q() === t ? "" : t)}>
                  {t}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show
        when={p.tab === "all"}
        fallback={
          <div class="lib-grid">
            <Show when={p.tab === "inbox" && !q()}>
              <For each={conflicts()}>{conflictCard}</For>
            </Show>
            <For each={items()}>{(n) => card(n)}</For>
            <Show when={p.tab !== "inbox"}>
              <button type="button" class="lcard add" onClick={() => p.onNew(p.tab.slice(2))}>
                New in {heading()}
              </button>
            </Show>
          </div>
        }
      >
        <For each={shelf()}>
          {(r) => (
            <section class="shelf-row">
              <div class="shelf-head">
                <Show when={canFace(r.top)} fallback={<Mark folder={r.top} class="tile" />}>
                  <button type="button" class="mark-btn" title="Colour and mark" aria-label={`Colour and mark of ${r.label}`} onClick={() => setFacing(r.top)}>
                    <Mark folder={r.top} class="tile" />
                  </button>
                </Show>
                <h2>{r.label}</h2>
                <span class="muted small">
                  {r.total} · {r.sub}
                </span>
                <span class="grow" />
                <Show when={r.id === "inbox"}>
                  <button type="button" class="link small" onClick={p.onReview}>
                    Review one by one
                  </button>
                </Show>
                <Show when={r.total > ROW}>
                  <button type="button" class="link small" onClick={() => p.onTab(r.id)}>
                    All {r.total}
                  </button>
                </Show>
              </div>
              <div class="shelf-cards">
                <Show when={r.id === "inbox" && !q()}>
                  <For each={conflicts()}>{conflictCard}</For>
                </Show>
                <For each={r.notes.slice(0, ROW - (r.id === "inbox" && !q() ? Math.min(conflicts().length, ROW) : 0))}>{(n) => card(n)}</For>
              </div>
            </section>
          )}
        </For>
        <Show when={pageCols().length && !q()}>
          <section class="shelf-row">
            <div class="shelf-head">
              <h2>Pages</h2>
              <span class="muted small">notes you write, found with Ctrl K · t on a collection makes it one to copy</span>
            </div>
            <div class="page-tiles">
              <For each={pageCols()}>
                {(c) => (
                  <button type="button" class="page-tile" onClick={() => p.onTab(`c:${c.top}`)}>
                    <Mark folder={c.top} size={12} />
                    <span>{folderName(c.top)}</span>
                    <span class="muted small">{c.notes.length}</span>
                  </button>
                )}
              </For>
            </div>
          </section>
        </Show>
      </Show>

      <Show when={p.data && !items().length && !(p.tab === "all" && (pageCols().length || conflicts().length)) && !(p.tab === "inbox" && conflicts().length)}>
        <div class="empty">
          <p class="empty-title">{q() ? "Nothing matches." : p.tab === "inbox" ? "Inbox zero" : "Nothing here yet"}</p>
          <p class="muted">
            {q()
              ? "Try fewer words."
              : p.tab === "inbox"
                ? "Captures from Ctrl Alt Space land here until you file them."
                : "A collection is a folder of Markdown files. Make one like Prompts or Snippets, or move a note there."}
          </p>
        </div>
      </Show>

      <footer class="lib-foot">
        <span>
          <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> open
        </span>
        <span>
          <kbd>c</kbd> copy
        </span>
        <span>
          <kbd>e</kbd> edit
        </span>
        <Show when={p.tab === "inbox"}>
          <span>
            <kbd>m</kbd> move
          </span>
          <span>
            <kbd>r</kbd> review
          </span>
        </Show>
        <Show when={p.tab !== "inbox"}>
          <span>
            <kbd>p</kbd> pin
          </span>
          <span>
            <kbd>t</kbd> colour and mark
          </span>
        </Show>
        <span class="grow" />
        <span>
          <kbd>Esc</kbd> back to writing
        </span>
      </footer>

      <Show when={open()} keyed>
        {(id) => (
          <Sheet
            id={id}
            copies={items().find((n) => n.id === id) ? copies(items().find((n) => n.id === id)!) : 0}
            aiReady={p.aiReady}
            onClose={() => setOpen(null)}
            onEdit={(i) => (setOpen(null), p.onEdit(i))}
            onMove={(n) => setMoving(n)}
            onFile={fileSuggested}
            onDelete={remove}
            onAiSetup={p.onAiSetup}
          />
        )}
      </Show>
      <Show when={moving()}>
        {(n) => <Destination exclude={n().id} onPick={(t) => void file(n(), t)} onClose={() => setMoving(null)} />}
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

