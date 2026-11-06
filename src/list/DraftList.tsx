// The draft list panel (`Ctrl L`): folders, tag chips, search and keyboard triage over the editor's column,
// with the highlighted draft read in full beside the list so most drafts never need opening.
// It owns what it shows; App.tsx owns the open draft, the undo history and which panel is up.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, type Cursor, type Draft, type Folder, type ListQuery, type TagCount, type UndoToken } from "../api";
import { countWords } from "../editor/autosave";

export type Tab = "inbox" | "flagged" | "archive" | "trash" | "all";

export const TABS: { tab: Tab; label: string; key: string }[] = [
  { tab: "inbox", label: "Inbox", key: "i" },
  { tab: "flagged", label: "Flagged", key: "f" },
  { tab: "archive", label: "Archive", key: "a" },
  { tab: "trash", label: "Trash", key: "t" },
  { tab: "all", label: "All", key: "d" },
];

interface Row {
  id: number;
  title: string;
  /** Preview, or a search snippet with the match between U+0001 and U+0002. */
  text: string;
  flagged: boolean;
  folder: Folder;
  modifiedAt: number;
}

export interface ListHandle {
  /** Returns true when the key was the list's. */
  key(e: KeyboardEvent): boolean;
  reload(): void;
}

interface Props {
  openId: number | null;
  onOpen(id: number): void;
  onClose(): void;
  /** A batch ran; App keeps the token for `z`. */
  onBatch(label: string, token: UndoToken): void;
  onUndo(): void;
  onToast(text: string): void;
  /** `g l`: the action log. */
  onLog(): void;
  ref(h: ListHandle): void;
  /** Where the list opens: the command bar opens it on a tab or a tag. Inbox otherwise. */
  start?: { tab?: Tab; tag?: string; query?: string };
}

const PAGE = 100;

/** The preview waits this long after the cursor stops, so holding `j` doesn't read every row it passes. */
const PREVIEW_MS = 60;

/** A very long draft previews its start; Enter opens the whole thing. */
const PREVIEW_CHARS = 20_000;

/** "now", "5 min", "3 hr", "2 d", then a date. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d`;
  return new Date(ms).toLocaleDateString();
}

/** The highlighted draft, read-only: the first line as the title, the rest as written. Plain text, not HTML. */
function Preview(props: { draft: Draft }) {
  const split = () => {
    const lines = props.draft.content.slice(0, PREVIEW_CHARS).split("\n");
    const i = lines.findIndex((l) => l.trim());
    if (i < 0) return { title: "", body: "" };
    return { title: lines[i].replace(/^#+\s*/, ""), body: lines.slice(i + 1).join("\n").replace(/^\n+/, "") };
  };
  const edited = () => {
    const a = ago(props.draft.modifiedAt);
    return a === "now" ? "just now" : /^\d+ (min|hr|d)$/.test(a) ? `${a} ago` : a;
  };
  return (
    <article class="preview-pane" aria-label="Preview">
      <div class="preview-text">
        <div class="preview-title">{split().title || "untitled"}</div>
        <Show when={split().body}>
          <div class="preview-body">{split().body}</div>
        </Show>
        <Show when={props.draft.content.length > PREVIEW_CHARS}>
          <div class="preview-more">
            … <kbd>Enter</kbd> to read the rest
          </div>
        </Show>
        <div class="preview-meta">
          <For each={props.draft.tags}>{(t) => <span>#{t}</span>}</For>
          <Show when={props.draft.folder !== "inbox"}>
            <span>{props.draft.folder}</span>
          </Show>
          <Show when={props.draft.flagged}>
            <span>flagged</span>
          </Show>
          <span>edited {edited()}</span>
          <span>{countWords(props.draft.content).toLocaleString()} words</span>
        </div>
      </div>
    </article>
  );
}

function Snippet(props: { text: string }) {
  // Split on the engine's markers; odd parts are matches.
  const parts = () => props.text.split(/\u0001|\u0002/);
  return <For each={parts()}>{(p, i) => (i() % 2 ? <mark>{p}</mark> : p)}</For>;
}

export default function DraftList(props: Props) {
  let panel!: HTMLDivElement;
  let search!: HTMLInputElement;
  let tagInput!: HTMLInputElement;
  let body!: HTMLDivElement;
  const [tab, setTab] = createSignal<Tab>(props.start?.tab ?? (props.start?.tag ? "all" : "inbox"));
  const [tag, setTag] = createSignal<string | null>(props.start?.tag ?? null);
  const [query, setQuery] = createSignal(props.start?.query ?? "");
  const [rows, setRows] = createSignal<Row[]>([]);
  const [next, setNext] = createSignal<Cursor | null>(null);
  const [at, setAt] = createSignal(0);
  const [picked, setPicked] = createSignal<Set<number>>(new Set());
  const [mode, setMode] = createSignal<null | "tag" | "empty">(null);
  const [tags, setTags] = createSignal<TagCount[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [shown, setShown] = createSignal<Draft | null>(null);
  let gPending = false;
  let generation = 0;

  function listQuery(cursor: Cursor | null): ListQuery {
    const t = tab();
    return {
      folder: t === "all" || t === "flagged" ? null : t,
      flaggedOnly: t === "flagged",
      tagsAll: tag() ? [tag()!] : [],
      cursor,
      limit: PAGE,
    };
  }

  /** The search box plus the tab and chip, in the engine's search syntax. */
  function searchText(): string {
    const parts = [query().trim()];
    const t = tab();
    if (t === "flagged") parts.push("is:flagged");
    else if (t !== "all") parts.push(`in:${t}`);
    if (tag()) parts.push(`tag:${tag()}`);
    return parts.join(" ");
  }

  async function load(reset: boolean) {
    const a = await api;
    const mine = ++generation;
    setLoading(true);
    try {
      if (query().trim()) {
        const hits = await a.searchDrafts(searchText(), 200);
        if (mine !== generation) return;
        // Hits carry no folder or flag; the list shows them as found.
        setRows(hits.map((h) => ({ id: h.id, title: h.title, text: h.snippet, flagged: false, folder: "inbox", modifiedAt: h.modifiedAt })));
        setNext(null);
      } else {
        const page = await a.listDrafts(listQuery(reset ? null : next()));
        if (mine !== generation) return;
        const fresh = page.rows.map((r) => ({ id: r.id, title: r.title, text: r.preview, flagged: r.flagged, folder: r.folder, modifiedAt: r.modifiedAt }));
        setRows(reset ? fresh : [...rows(), ...fresh]);
        setNext(page.next);
      }
      if (reset) {
        setAt((i) => Math.min(i, Math.max(0, rows().length - 1)));
        const t = tab();
        setTags(await a.tagCounts(t === "all" || t === "flagged" ? null : t));
      }
    } catch (e) {
      props.onToast(`List failed: ${e}`);
    } finally {
      if (mine === generation) setLoading(false);
    }
  }

  function more() {
    if (next() && !loading()) load(false);
  }

  // A new tab, chip or query starts at the top.
  createEffect(
    on([tab, tag], () => {
      setAt(0);
      setPicked(new Set<number>());
      load(true);
    }),
  );
  let searchTimer: number | undefined;
  createEffect(
    on(
      query,
      () => {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => {
          setAt(0);
          load(true);
        }, 80);
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const i = at();
    body?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
    if (i >= rows().length - 10) more();
  });

  // The preview follows the highlighted row. A peek, not an open: it doesn't mark the draft accessed. It reruns
  // when the rows reload, so a batch that moved or flagged the row shows in the pane.
  let previewTimer: number | undefined;
  let previewFor: number | null = null;
  createEffect(() => {
    const r = rows()[at()];
    window.clearTimeout(previewTimer);
    previewFor = r?.id ?? null;
    if (!r) {
      setShown(null);
      return;
    }
    previewTimer = window.setTimeout(async () => {
      try {
        const d = await (await api).peekDraft(r.id);
        if (previewFor === r.id) setShown(d);
      } catch {
        if (previewFor === r.id) setShown(null);
      }
    }, PREVIEW_MS);
  });
  onCleanup(() => window.clearTimeout(previewTimer));

  function targets(): number[] {
    const p = picked();
    if (p.size) return [...p];
    const r = rows()[at()];
    return r ? [r.id] : [];
  }

  async function batch(label: string, run: (ids: number[]) => Promise<UndoToken>) {
    const ids = targets();
    if (!ids.length) return;
    try {
      const token = await run(ids);
      setPicked(new Set<number>());
      props.onBatch(`${label} ${ids.length === 1 ? "1 draft" : `${ids.length} drafts`}`, token);
      await load(true);
    } catch (e) {
      props.onToast(`${label} failed: ${e}`);
    }
  }

  const a = () => api;
  // In Archive, `e` sends back to Inbox; in Trash, `#` does. Each key toggles its folder.
  const archive = () =>
    batch(tab() === "archive" ? "Moved to Inbox" : "Archived", async (ids) =>
      (await a()).moveDrafts(ids, tab() === "archive" ? "inbox" : "archive"),
    );
  const trash = () =>
    batch(tab() === "trash" ? "Restored" : "Trashed", async (ids) =>
      (await a()).moveDrafts(ids, tab() === "trash" ? "inbox" : "trash"),
    );
  const flag = () => {
    const ids = new Set(targets());
    const allFlagged = rows().filter((r) => ids.has(r.id)).every((r) => r.flagged);
    batch(allFlagged ? "Unflagged" : "Flagged", async (ids) => (await a()).flagDrafts(ids, !allFlagged));
  };

  async function applyTags() {
    const names = tagInput.value.split(/[,\s]+/).filter(Boolean);
    setMode(null);
    panel.focus();
    if (names.length) await batch(`Tagged ${names.join(", ")} on`, async (ids) => (await a()).addTags(ids, names));
  }

  async function emptyTrash() {
    setMode(null);
    panel.focus();
    try {
      const n = await (await api).emptyTrash();
      props.onToast(`Trash emptied: ${n} ${n === 1 ? "draft" : "drafts"} deleted.`);
      await load(true);
    } catch (e) {
      props.onToast(`Empty trash failed: ${e}`);
    }
  }

  function key(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (mode() === "empty") {
      if (e.key === "Enter") emptyTrash();
      else if (e.key === "Escape") setMode(null);
      return true;
    }
    if (gPending) {
      gPending = false;
      if (e.key === "l") {
        props.onLog();
        return true;
      }
      const t = TABS.find((t) => t.key === e.key);
      if (t) {
        setTab(t.tab);
        return true;
      }
    }
    const n = rows().length;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        setAt((i) => Math.min(i + 1, Math.max(0, n - 1)));
        return true;
      case "k":
      case "ArrowUp":
        setAt((i) => Math.max(i - 1, 0));
        return true;
      case "Home":
        setAt(0);
        return true;
      case "End":
        setAt(Math.max(0, n - 1));
        return true;
      case "Enter": {
        const r = rows()[at()];
        if (r) props.onOpen(r.id);
        return true;
      }
      case "Escape":
        if (picked().size) setPicked(new Set<number>());
        else if (query()) setQuery("");
        else if (tag()) setTag(null);
        else props.onClose();
        return true;
      case "x": {
        const r = rows()[at()];
        if (!r) return true;
        const p = new Set(picked());
        p.has(r.id) ? p.delete(r.id) : p.add(r.id);
        setPicked(p);
        setAt((i) => Math.min(i + 1, Math.max(0, n - 1)));
        return true;
      }
      case "e":
        archive();
        return true;
      case "#":
        trash();
        return true;
      case "f":
        flag();
        return true;
      case "t":
        if (targets().length) {
          setMode("tag");
          queueMicrotask(() => tagInput.focus());
        }
        return true;
      case "z":
        props.onUndo();
        return true;
      case "/":
        search.focus();
        search.select();
        return true;
      case "g":
        gPending = true;
        return true;
      case "Delete":
        if (tab() === "trash" && n) setMode("empty");
        return true;
    }
    return false;
  }

  onMount(() => {
    props.ref({ key, reload: () => load(true) });
    panel.focus();
  });

  return (
    <div class="list drafts" ref={panel} tabindex="-1">
      <div class="drafts-side">
      <div class="list-head">
        <input
          ref={search}
          class="search"
          type="search"
          aria-label="Search drafts"
          placeholder="Search  /"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
              panel.focus();
            } else if (e.key === "Enter" || e.key === "ArrowDown") {
              e.preventDefault();
              e.stopPropagation();
              setAt(0);
              panel.focus();
            }
          }}
        />
        <nav class="tabs">
          <For each={TABS}>
            {(t) => (
              <button
                class="tab"
                classList={{ on: tab() === t.tab }}
                title={`g ${t.key}`}
                onClick={() => {
                  setTab(t.tab);
                  panel.focus();
                }}
              >
                {t.label}
              </button>
            )}
          </For>
        </nav>
        <Show when={tags().length}>
          <div class="chips">
            <For each={tags()}>
              {(t) => (
                <button
                  class="chip"
                  classList={{ on: tag() === t.name }}
                  onClick={() => {
                    setTag(tag() === t.name ? null : t.name);
                    panel.focus();
                  }}
                >
                  {t.name} <span class="n">{t.count}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={mode() === "tag"}>
          <div class="bar">
            <span>Add tags to {targets().length === 1 ? "1 draft" : `${targets().length} drafts`}:</span>
            <input
              ref={tagInput}
              list="petrel-tags"
              placeholder="work, idea"
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
                if (e.key === "Enter") applyTags();
                else if (e.key === "Escape") {
                  setMode(null);
                  panel.focus();
                }
              }}
            />
          </div>
        </Show>
        <Show when={mode() === "empty"}>
          <div class="bar danger">
            <span>Delete everything in Trash for good? This cannot be undone.</span>
            <button class="danger" onClick={emptyTrash}>
              Empty trash <kbd>Enter</kbd>
            </button>
            <button onClick={() => setMode(null)}>
              Cancel <kbd>Esc</kbd>
            </button>
          </div>
        </Show>
      </div>
      <div
        class="list-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight > el.scrollHeight - 400) more();
        }}
      >
        <For each={rows()}>
          {(r, i) => (
            <div
              class="row draft"
              data-i={i()}
              classList={{ at: i() === at(), picked: picked().has(r.id), open: r.id === props.openId }}
              onClick={() => {
                setAt(i());
                panel.focus();
              }}
              onDblClick={() => props.onOpen(r.id)}
            >
              <div class="row-top">
                <span class="title" classList={{ recent: Date.now() - r.modifiedAt < 3_600_000 }}>
                  {r.title || "untitled"}
                </span>
                <Show when={r.flagged}>
                  <span class="flag on" title="Flagged" />
                </Show>
                <span class="time">{ago(r.modifiedAt)}</span>
              </div>
              <Show when={r.text}>
                <span class="preview">
                  <Snippet text={r.text} />
                </span>
              </Show>
            </div>
          )}
        </For>
        <Show when={!rows().length && !loading()}>
          <div class="empty">
            {query() ? "No matches." : `${TABS.find((t) => t.tab === tab())!.label} is empty.`}
          </div>
        </Show>
      </div>
      <Show when={tab() === "trash" && rows().length}>
        <div class="list-foot">
          <button class="danger" onClick={() => setMode("empty")}>
            Empty trash <kbd>Del</kbd>
          </button>
        </div>
      </Show>
      </div>
      <Show when={shown()}>{(d) => <Preview draft={d()} />}</Show>
    </div>
  );
}
