// Settle a conflict: a note was changed in two places (Petrel and Drive, say), and the other text was kept beside
// it as a conflict copy. Both are shown side by side with what differs marked; keep the left, keep the right, or
// keep both. The side not kept goes to .trash/ (the toast's Undo brings it back).

import { createResource, For, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type Conflict } from "../api";
import { diff } from "../versions/diff";
import { ago, folderName, say } from "../ui";

export default function Settle(p: { conflict: Conflict; onClose(): void; onDone(): void }) {
  const [both] = createResource(async () => {
    const s = await api();
    const [mine, theirs] = await Promise.all([s.peekNote(p.conflict.original), s.peekNote(p.conflict.copy)]);
    return { mine, theirs, parts: diff(mine.body, theirs.body) };
  });

  async function keep(which: "left" | "right" | "both") {
    const s = await api();
    try {
      const t = await s.settleConflict(p.conflict.original, p.conflict.copy, which);
      const what = which === "both" ? "Kept both. The other one is now its own note." : which === "left" ? "Kept the note as it is" : "Kept the other text";
      say(what, { undo: () => s.undo(t.token).then(p.onDone) });
      p.onDone();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  const key = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") p.onClose();
    else if (e.key === "1" || e.key === "ArrowLeft") void keep("left");
    else if (e.key === "2" || e.key === "ArrowRight") void keep("right");
    else if (e.key === "b" || e.key === "3") void keep("both");
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => document.addEventListener("keydown", key, true));
  onCleanup(() => document.removeEventListener("keydown", key, true));

  return (
    <div class="scrim sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="settle" role="dialog" aria-label={`Settle ${p.conflict.title}`}>
        <header class="settle-head">
          <h2>{p.conflict.title}</h2>
          <span class="muted small">
            {folderName(p.conflict.folder)} · changed in two places. Pick the text to keep.
          </span>
        </header>
        <Show when={both()} fallback={<p class="muted pad">Reading both…</p>}>
          {(b) => (
            <div class="settle-sides">
              <section class="settle-side">
                <div class="side-head">The note now · edited {ago(b().mine.modifiedAt)}</div>
                <div class="settle-text">
                  <For each={b().parts.filter((x) => x.kind !== "add")}>{(x) => (x.kind === "del" ? <mark class="diff-del">{x.text}</mark> : x.text)}</For>
                </div>
                <button class="btn primary wide" onClick={() => void keep("left")}>
                  Keep this <kbd>1</kbd>
                </button>
              </section>
              <section class="settle-side">
                <div class="side-head">The other text · kept {ago(p.conflict.copiedAt)}</div>
                <div class="settle-text">
                  <For each={b().parts.filter((x) => x.kind !== "del")}>{(x) => (x.kind === "add" ? <mark class="diff-add">{x.text}</mark> : x.text)}</For>
                </div>
                <button class="btn primary wide" onClick={() => void keep("right")}>
                  Keep this <kbd>2</kbd>
                </button>
              </section>
            </div>
          )}
        </Show>
        <footer class="row end">
          <span class="muted small">The one not kept goes to the trash in your folder.</span>
          <span class="grow" />
          <button class="btn" onClick={() => void keep("both")}>
            Keep both <kbd>b</kbd>
          </button>
          <button class="btn" onClick={p.onClose}>
            Later <kbd>Esc</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}
