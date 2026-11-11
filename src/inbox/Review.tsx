// Inbox review (`r` in the library, or the command bar): one capture at a time, oldest first. A number files it
// in one of the places offered (the ones used most and lately come first), `/` finds another, Space keeps it for
// later, `e` edits, `d` deletes, `s` asks Claude for a home (only then), `z` undoes. When the last one is gone:
// "Inbox clear." and the petrel crosses the page.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type AiSuggestion, type Note } from "../api";
import Petrel from "../joy/Petrel";
import Mark from "../library/Mark";
import { ago, say, undoLast } from "../ui";
import Destination, { placeRows, type Row, type Target } from "./Destination";
import { fileCapture, filedCounts } from "./file";

const PLACES = 6;

export default function Review(p: { aiReady: boolean; onDone(): void; onEdit(id: number): void; onAiSetup(): void; onChanged(): void }) {
  const [queue, setQueue] = createSignal<number[] | null>(null);
  const [total, setTotal] = createSignal(0);
  const [kept, setKept] = createSignal<number[]>([]);
  const [filed, setFiled] = createSignal(0);
  const [leaving, setLeaving] = createSignal(false);
  const [finding, setFinding] = createSignal(false);
  const [hint, setHint] = createSignal<AiSuggestion | "asking" | null>(null);
  const [rev, setRev] = createSignal(0);

  async function load() {
    const s = await api();
    const inbox = await s.listNotes({ folder: "inbox", limit: 1000 });
    const ids = inbox.sort((a, b) => a.modifiedAt - b.modifiedAt).map((n) => n.id).filter((id) => !kept().includes(id));
    setQueue(ids);
    if (!total()) setTotal(ids.length);
  }

  const id = () => queue()?.[0];
  // Signals, not resources: a resource would suspend the whole screen (App's Suspense) between cards.
  const [note, setNote] = createSignal<Note | null>(null);
  createEffect(
    on(id, (i) => {
      if (i == null) return setNote(null);
      void api()
        .then((s) => s.peekNote(i))
        .then((n) => id() === i && setNote(n), (e) => say(errText(e), { error: true }));
    }),
  );
  const [places, setPlaces] = createSignal<Row[]>([]);
  createEffect(
    on(rev, async () => {
      const s = await api();
      const [folders, recent, used] = await Promise.all([s.noteFolders(), s.listNotes({ limit: 8 }), filedCounts()]);
      const fs = folders.map((f) => f.path).filter((f) => f !== "inbox" && !f.startsWith("."));
      setPlaces(placeRows("", fs, recent.filter((n) => n.folder !== "inbox"), used, "").slice(0, PLACES));
    }),
  );
  const done = createMemo(() => queue() !== null && queue()!.length === 0);
  const position = () => total() - (queue()?.length ?? 0) + 1;

  async function file(t: Target) {
    const n = note();
    if (!n) return;
    setFinding(false);
    setHint(null);
    setLeaving(true);
    try {
      const [{ change, text }] = await Promise.all([fileCapture(n, t), new Promise((r) => setTimeout(r, 220))]);
      const s = await api();
      say(text, {
        undo: async () => {
          await s.undo(change.token.token);
          setFiled((x) => Math.max(0, x - 1));
          await load();
          // The capture came back: show it first again.
          setQueue((q) => (q ? [n.id, ...q.filter((x) => x !== n.id)] : q));
          p.onChanged();
        },
      });
      setFiled(filed() + 1);
      setQueue((q) => q?.filter((x) => x !== n.id) ?? q);
      setRev(rev() + 1);
      p.onChanged();
    } catch (e) {
      say(errText(e), { error: true });
    } finally {
      setLeaving(false);
    }
  }

  function keep() {
    const n = id();
    if (n == null) return;
    setHint(null);
    setKept([...kept(), n]);
    setQueue((q) => q?.filter((x) => x !== n) ?? q);
  }

  async function remove() {
    const n = note();
    if (!n) return;
    setHint(null);
    try {
      const s = await api();
      const t = await s.trashNote(n.id);
      say("Deleted", {
        undo: async () => {
          await s.undo(t.token);
          setQueue((q) => (q ? [n.id, ...q] : q));
          p.onChanged();
        },
      });
      setQueue((q) => q?.filter((x) => x !== n.id) ?? q);
      p.onChanged();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function suggest() {
    const n = note();
    if (!n) return;
    if (!p.aiReady) return p.onAiSetup();
    setHint("asking");
    try {
      const got = await (await api()).aiSuggestHome(n.id);
      if (id() !== n.id) return;
      setHint(got[0] ?? null);
      if (!got.length) say("Claude found no good home for this one");
    } catch (e) {
      setHint(null);
      say(errText(e), { error: true });
    }
  }
  const takeHint = (h: AiSuggestion) =>
    file(h.kind === "merge" && h.noteId != null ? { kind: "note", id: h.noteId, title: h.title } : { kind: "folder", folder: h.folder });

  const key = (e: KeyboardEvent) => {
    if (finding() || e.ctrlKey || e.metaKey || e.altKey || document.querySelector(".scrim")) return;
    if (done()) {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        p.onDone();
      }
      return;
    }
    if (leaving()) return e.preventDefault();
    const n = Number(e.key);
    const h = hint();
    if (n >= 1 && n <= PLACES && places()[n - 1]) void file(places()[n - 1].t);
    else if (e.key === " ") keep();
    else if (e.key === "/") setFinding(true);
    else if (e.key === "e" && note()) p.onEdit(note()!.id);
    else if (e.key === "d") void remove();
    else if (e.key === "s") void suggest();
    else if (e.key === "Enter" && h && h !== "asking") void takeHint(h);
    else if (e.key === "z") {
      if (!undoLast()) return;
    } else if (e.key === "Escape") p.onDone();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => {
    document.addEventListener("keydown", key);
    void load();
  });
  onCleanup(() => document.removeEventListener("keydown", key));

  return (
    <div class="review">
      <Show
        when={!done()}
        fallback={
          <div class="review-clear">
            <Petrel />
            <p class="review-clear-title">Inbox clear.</p>
            <p class="muted">
              {filed()} filed{kept().length ? ` · ${kept().length} kept for later` : ""}
            </p>
            <button class="btn" onClick={p.onDone}>
              Back to writing <kbd>Enter</kbd>
            </button>
          </div>
        }
      >
        <div class="review-main">
          <div class="review-progress" aria-label={`${position()} of ${total()}`}>
            <For each={Array.from({ length: Math.min(total(), 40) })}>
              {(_, i) => <span classList={{ done: i() < position() - 1, now: i() === position() - 1 }} />}
            </For>
          </div>
          <div class="review-stack">
            <Show when={(queue()?.length ?? 0) > 2}>
              <div class="review-card ghost two" />
            </Show>
            <Show when={(queue()?.length ?? 0) > 1}>
              <div class="review-card ghost one" />
            </Show>
            <Show when={note()} keyed>
              {(n: Note) => (
                <article class="review-card" classList={{ leaving: leaving() }}>
                  <div class="review-when">{ago(n.modifiedAt)}</div>
                  <div class="review-text">{n.body.trim() || "(empty)"}</div>
                  <Show when={hint()}>
                    {(h) => (
                      <div class="review-hint">
                        <span class="spark">✦</span>
                        <Show when={h() !== "asking"} fallback={<span class="ai-thinking">Claude is looking for a home…</span>}>
                          <span>
                            {(h() as AiSuggestion).kind === "merge" ? "Add to the end of " : "File in "}
                            <b>{(h() as AiSuggestion).kind === "merge" ? (h() as AiSuggestion).title : (h() as AiSuggestion).folder}</b>
                            {(h() as AiSuggestion).why ? `: ${(h() as AiSuggestion).why}` : ""}
                          </span>
                          <span class="grow" />
                          <button class="btn small" onClick={() => void takeHint(h() as AiSuggestion)}>
                            Take it <kbd>Enter</kbd>
                          </button>
                        </Show>
                      </div>
                    )}
                  </Show>
                </article>
              )}
            </Show>
          </div>
        </div>
        <aside class="review-places">
          <div class="muted small">File it</div>
          <For each={places()}>
            {(r, i) => (
              <button class="review-place" onClick={() => void file(r.t)}>
                <kbd>{i() + 1}</kbd>
                <Show when={r.t.kind !== "note"} fallback={<span class="row-icon">¶</span>}>
                  <Mark folder={r.folder} size={13} />
                </Show>
                <span class="review-place-label">{r.label}</span>
                <Show when={r.t.kind === "note"}>
                  <span class="muted small">note</span>
                </Show>
              </button>
            )}
          </For>
          <button class="review-place" onClick={() => setFinding(true)}>
            <kbd>/</kbd>
            <span class="review-place-label muted">Find another…</span>
          </button>
          <p class="muted small">The places you file into most come first.</p>
        </aside>
        <footer class="review-foot">
          <span>
            <kbd>1</kbd>–<kbd>{PLACES}</kbd> file
          </span>
          <span>
            <kbd>Space</kbd> keep for later
          </span>
          <span>
            <kbd>e</kbd> edit
          </span>
          <span>
            <kbd>d</kbd> delete
          </span>
          <span>
            <kbd>s</kbd> suggest a home
          </span>
          <span>
            <kbd>z</kbd> undo
          </span>
          <span class="grow" />
          <span>
            <kbd>Esc</kbd> stop
          </span>
        </footer>
      </Show>
      <Show when={finding() && note()}>
        <Destination exclude={note()!.id} onPick={(t) => void file(t)} onClose={() => setFinding(false)} />
      </Show>
    </div>
  );
}
