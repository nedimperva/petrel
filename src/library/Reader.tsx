// A collection of pages (Travel, Work, Journal), read rather than copied: the pages on the left, grouped by
// month with their first line, and the selected one on the right as it reads, with what links to it. Enter writes
// in it; m moves, p pins, d deletes; / filters; the chips sort (newest, A–Z) or narrow (pinned, with open tasks).

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type BackRef, type Note, type NoteSummary } from "../api";
import { folderName, KeyHints, say, typing, undoLast } from "../ui";
import Mark, { hueClass } from "./Mark";
import ReadNote from "./ReadNote";

type Order = "new" | "az" | "pinned" | "tasks";

const hasOpenTask = (n: NoteSummary) => /^\s*[-*] \[ \]/m.test(n.preview);

const firstLine = (n: NoteSummary) =>
  n.preview
    .split("\n")
    .map((l) => l.replace(/^#+\s+|^\s*[-*>]\s+(\[[ xX]\]\s*)?/g, "").trim())
    .find((l) => l && l !== n.title) ?? "";

export default function Reader(p: {
  top: string;
  notes: NoteSummary[];
  onEdit(id: number): void;
  onNew(folder: string): void;
  onMove(n: Note): void;
  onDelete(n: Note): void;
  onPin(n: NoteSummary): void;
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
  const [order, setOrder] = createSignal<Order>("new");
  const [sel, setSel] = createSignal<number | null>(p.start ?? null);
  createEffect(on(() => p.top, () => (setQ(""), setSel(null)), { defer: true }));

  const shown = createMemo(() => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    let ns = p.notes.filter((n) => words.every((w) => `${n.title} ${n.preview}`.toLowerCase().includes(w)));
    if (order() === "pinned") ns = ns.filter((n) => n.pinned);
    if (order() === "tasks") ns = ns.filter(hasOpenTask);
    return order() === "az" ? [...ns].sort((a, b) => a.title.localeCompare(b.title)) : [...ns].sort((a, b) => b.modifiedAt - a.modifiedAt);
  });
  /** Month headings when the list is by date. */
  const monthOf = (n: NoteSummary) => new Date(n.modifiedAt).toLocaleDateString(undefined, { month: "long", year: new Date(n.modifiedAt).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
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
      p.onChanged();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function follow(inner: string) {
    const r = await (await api()).resolveLink(inner);
    if (r.kind === "note") p.onEdit(r.id);
    else say("That note does not exist yet.");
  }

  function step(by: number) {
    const list = shown();
    if (!list.length) return;
    const i = list.findIndex((n) => n.id === current()?.id);
    const next = list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + by))];
    setSel(next.id);
    queueMicrotask(() => listEl?.querySelector(`[data-page="${next.id}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  const key = (e: KeyboardEvent) => {
    if (p.busy || e.ctrlKey || e.metaKey || e.altKey || document.querySelector(".scrim")) return;
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
        step(1);
        break;
      case "ArrowUp":
      case "k":
        step(-1);
        break;
      case "Enter":
      case "e":
        if (n) p.onEdit(n.id);
        break;
      case "m":
        if (note()) p.onMove(note()!);
        break;
      case "d":
      case "Delete":
        if (note()) p.onDelete(note()!);
        break;
      case "p":
        if (n) p.onPin(n);
        break;
      case "n":
        p.onNew(p.top);
        break;
      case "z":
        if (!undoLast()) return;
        break;
      case "/":
        filterInput.focus();
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          filterInput.focus();
          return;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  // Esc goes back to the cards, before the app takes it as "back to writing".
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !p.onBack || p.busy || typing(e) || document.querySelector(".scrim")) return;
    e.preventDefault();
    e.stopPropagation();
    p.onBack();
  };
  onMount(() => {
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
          <Mark folder={p.top} class="tile" />
          <h1>{folderName(p.top)}</h1>
          <span class="muted small">{p.notes.length} pages</span>
          <span class="grow" />
          <button type="button" class="icon-btn" title="New page (n)" aria-label={`New page in ${folderName(p.top)}`} onClick={() => p.onNew(p.top)}>
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
        <div class="reader-rows" ref={listEl}>
          <For each={shown()}>
            {(n, i) => (
              <>
                <Show when={order() !== "az" && (i() === 0 || monthOf(shown()[i() - 1]) !== monthOf(n))}>
                  <div class="reader-month">{monthOf(n)}</div>
                </Show>
                <button type="button" class="reader-row" classList={{ on: current()?.id === n.id }} data-page={n.id} onClick={() => setSel(n.id)} onDblClick={() => p.onEdit(n.id)}>
                  <span class="reader-row-top">
                    <span class="reader-row-title">{n.title}</span>
                    <Show when={n.pinned}>
                      <span class="muted small">pinned</span>
                    </Show>
                    <span class="reader-row-date">{new Date(n.modifiedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
                  </span>
                  <span class="reader-row-text">{firstLine(n)}</span>
                </button>
              </>
            )}
          </For>
          <Show when={!shown().length}>
            <p class="muted pad">{q() || order() !== "new" ? "Nothing here with that." : "No pages yet. n makes one."}</p>
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
                  <ReadNote body={body()} onLink={(inner) => void follow(inner)} onTick={(line, done) => void tick(line, done)} />
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

      <footer class="lib-foot">
        <KeyHints hints={[["↑ ↓", "pages"], ["Enter", "write in it"], ["m", "move"], ["p", "pin"], ["d", "delete"], ["n", "new"], ["/", "filter"]]} />
        <span class="grow" />
        <KeyHints hints={[["Esc", p.onBack ? "back to the cards" : "back to writing"]]} />
      </footer>
    </div>
  );
}
