// The command bar (`Ctrl K`, package 05): one box for commands, actions, drafts, notes and tags. Empty, it shows what
// you used last, then every command. Typing ranks names (match.ts); drafts come from full-text search, so a
// word inside a draft finds it too. `Enter` runs the highlighted row, `Esc` goes back to the text.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, type Action, type NoteSummary, type SearchHit, type TagCount } from "../api";
import { pushRecent, rank } from "./match";

export interface Command {
  id: string;
  name: string;
  /** The key that does the same thing, shown so the bar teaches it. */
  keys?: string;
  run(): void;
}

type Item =
  | { kind: "command"; key: string; name: string; keys?: string; command: Command }
  | { kind: "action"; key: string; name: string; keys?: string; action: Action }
  | { kind: "tag"; key: string; name: string; count: number }
  | { kind: "draft"; key: string; name: string; hit: SearchHit }
  | { kind: "note"; key: string; name: string; note: NoteSummary };

interface Props {
  commands: Command[];
  actions: Action[];
  onAction(a: Action): void;
  onDraft(id: number): void;
  /** Opens a note on the note page. */
  onNote?(id: number): void;
  /** Opens the list filtered by the tag. */
  onTag(name: string): void;
  onClose(): void;
}

const RECENT_KEY = "petrel.palette.recent";
/** Typing stops this long before drafts are searched (package 05: live, debounced 80 ms). */
const SEARCH_MS = 80;
const DRAFTS_SHOWN = 8;
const NOTES_SHOWN = 6;
const SHOWN = 40;

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(keys: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(keys));
  } catch {
    // Recents are a convenience.
  }
}

const LABEL: Record<Item["kind"], string> = { command: "", action: "action", tag: "tag", draft: "draft", note: "note" };

export default function CommandBar(props: Props) {
  let input!: HTMLInputElement;
  let body!: HTMLDivElement;
  const [query, setQuery] = createSignal("");
  const [at, setAt] = createSignal(0);
  const [tags, setTags] = createSignal<TagCount[]>([]);
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [noteHits, setNoteHits] = createSignal<NoteSummary[]>([]);
  const [recent, setRecent] = createSignal(loadRecent());
  let timer: number | undefined;
  let generation = 0;

  const fixed = (): Item[] => [
    ...props.commands.map((c): Item => ({ kind: "command", key: `cmd:${c.id}`, name: c.name, keys: c.keys, command: c })),
    ...props.actions
      .filter((a) => !a.hidden && !a.disabled)
      .map((a): Item => ({ kind: "action", key: `action:${a.uuid}`, name: a.name, keys: a.shortcut ?? undefined, action: a })),
    ...tags().map((t): Item => ({ kind: "tag", key: `tag:${t.name}`, name: `#${t.name}`, count: t.count })),
  ];

  const items = (): Item[] => {
    const q = query().trim();
    if (!q) {
      // What you used last first, then the commands; actions and tags are a word away.
      const all = fixed();
      const byKey = new Map(all.map((i) => [i.key, i]));
      const first = recent().map((k) => byKey.get(k)).filter((i): i is Item => !!i);
      const rest = all.filter((i) => i.kind === "command" && !recent().includes(i.key));
      return [...first, ...rest];
    }
    const named = rank(q.replace(/^#/, ""), fixed(), (i) => (i.kind === "tag" ? i.name.slice(1) : i.name));
    const seen = new Set(named.map((i) => i.key));
    const drafts = hits()
      .map((h): Item => ({ kind: "draft", key: `draft:${h.id}`, name: h.title || "untitled", hit: h }))
      .filter((i) => !seen.has(i.key));
    const notes = noteHits().map((n): Item => ({ kind: "note", key: `note:${n.id}`, name: n.title, note: n }));
    return [...named.slice(0, SHOWN - drafts.length - notes.length), ...notes, ...drafts];
  };

  createEffect(
    on(query, (q) => {
      setAt(0);
      window.clearTimeout(timer);
      const mine = ++generation;
      // A command name is two letters away; drafts need a little more to be worth a search.
      if (q.trim().length < 2) {
        setNoteHits([]);
        return setHits([]);
      }
      timer = window.setTimeout(async () => {
        if (props.onNote) {
          void (async () => {
            const a = await api;
            const byTitle = await a.findNotes(q.trim(), NOTES_SHOWN).catch(() => [] as NoteSummary[]);
            const byText = await a.searchNotes(q.trim(), NOTES_SHOWN).catch(() => [] as NoteSummary[]);
            const seen = new Set<number>();
            const all = [...byTitle, ...byText].filter((n) => !seen.has(n.id) && seen.add(n.id)).slice(0, NOTES_SHOWN);
            if (mine === generation) setNoteHits(all);
          })();
        }
        try {
          const found = await (await api).searchDrafts(q.trim(), DRAFTS_SHOWN);
          if (mine === generation) setHits(found);
        } catch {
          // A query the parser cannot use (a lone `tag:`) finds no drafts; the names still match.
          if (mine === generation) setHits([]);
        }
      }, SEARCH_MS);
    }),
  );

  onMount(async () => {
    input.focus();
    try {
      setTags(await (await api).tagCounts(null));
    } catch {
      // Tags are one of four kinds of row; the bar works without them.
    }
  });
  onCleanup(() => window.clearTimeout(timer));

  function choose(i: Item | undefined) {
    if (!i) return;
    const next = pushRecent(recent(), i.key);
    setRecent(next);
    saveRecent(next);
    props.onClose();
    if (i.kind === "command") i.command.run();
    else if (i.kind === "action") props.onAction(i.action);
    else if (i.kind === "tag") props.onTag(i.name.slice(1));
    else if (i.kind === "note") props.onNote?.(i.note.id);
    else props.onDraft(i.hit.id);
  }

  function move(by: number) {
    const n = items().length;
    if (!n) return;
    setAt((i) => (i + by + n) % n);
    queueMicrotask(() => body.querySelector(".at")?.scrollIntoView({ block: "nearest" }));
  }

  function onKey(e: KeyboardEvent) {
    // Every key stays here: the app's own shortcuts would act on the text behind the bar.
    e.stopPropagation();
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === "Escape" || (ctrl && k === "k")) {
      e.preventDefault();
      return props.onClose();
    }
    if (e.key === "ArrowDown" || (ctrl && (k === "j" || k === "n"))) {
      e.preventDefault();
      return move(1);
    }
    if (e.key === "ArrowUp" || (ctrl && k === "p")) {
      e.preventDefault();
      return move(-1);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      return choose(items()[at()]);
    }
  }

  return (
    <div class="scrim palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="palette" role="dialog" aria-label="Command bar">
        <input
          ref={input}
          class="palette-input"
          placeholder="Command, action, draft, note or #tag"
          spellcheck={false}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKey}
          aria-activedescendant={`palette-${at()}`}
        />
        <div class="palette-body" ref={body} role="listbox">
          <For each={items()}>
            {(i, n) => (
              <div
                id={`palette-${n()}`}
                role="option"
                aria-selected={n() === at()}
                class="palette-row"
                classList={{ at: n() === at() }}
                onMouseMove={() => setAt(n())}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(i);
                }}
              >
                <span class="name">{i.name}</span>
                <Show when={i.kind === "draft" && i.hit.snippet}>
                  <span class="snippet">{snippet(i.kind === "draft" ? i.hit.snippet : "")}</span>
                </Show>
                <Show when={i.kind === "note" && (i.note.folder || i.note.preview)}>
                  <span class="snippet">{i.kind === "note" ? i.note.folder || i.note.preview : ""}</span>
                </Show>
                <span class="grow" />
                <Show when={i.kind === "tag"}>
                  <span class="n">{i.kind === "tag" ? i.count : ""}</span>
                </Show>
                <Show when={LABEL[i.kind]}>
                  <span class="kind">{LABEL[i.kind]}</span>
                </Show>
                <Show when={"keys" in i && i.keys}>
                  <kbd>{"keys" in i ? i.keys : ""}</kbd>
                </Show>
              </div>
            )}
          </For>
          <Show when={!items().length}>
            <div class="palette-empty">Nothing matches “{query().trim()}”.</div>
          </Show>
        </div>
        <div class="palette-foot">
          <span>
            <kbd>↑ ↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> run
          </span>
          <span>
            <kbd>Esc</kbd> back
          </span>
        </div>
      </div>
    </div>
  );
}

/** The search snippet without its match markers (the bar is one line; the list highlights). */
function snippet(s: string): string {
  return s.replace(/[\u0001\u0002]/g, "");
}
