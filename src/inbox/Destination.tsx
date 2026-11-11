// Where a capture goes: a note to add it to, or a folder to file it in as its own note. The inbox's `m` and the
// capture window's Tab both open this. Typing narrows the list; a new folder name is offered as it is typed.

import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { api, type NoteSummary } from "../api";
import { folderName } from "../ui";

export type Target = { kind: "note"; id: number; title: string } | { kind: "folder"; folder: string };

export function targetLabel(t: Target | null): string {
  if (!t) return "Inbox";
  return t.kind === "note" ? t.title : folderName(t.folder);
}

export default function Destination(p: { exclude?: number; onPick(t: Target): void; onClose(): void }) {
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  const [q, setQ] = createSignal("");
  const [i, setI] = createSignal(0);
  const [folders] = createResource(async () =>
    (await (await api()).noteFolders()).filter((f) => f.path !== "inbox" && !f.path.startsWith(".")),
  );
  const [notes] = createResource(q, async (text): Promise<NoteSummary[]> => {
    const s = await api();
    const found = text.trim() ? await s.findNotes(text, 12) : await s.listNotes({ limit: 12 });
    return found.filter((n) => n.folder !== "inbox" && n.id !== p.exclude);
  });

  const rows = (): { t: Target; label: string; sub: string }[] => {
    const text = q().trim().toLowerCase();
    const fs = (folders() ?? [])
      .filter((f) => !text || f.path.toLowerCase().includes(text) || folderName(f.path).toLowerCase().includes(text))
      .map((f) => ({ t: { kind: "folder", folder: f.path } as Target, label: folderName(f.path), sub: "as a new note in this folder" }));
    const ns = (notes() ?? []).map((n) => ({
      t: { kind: "note", id: n.id, title: n.title } as Target,
      label: n.title,
      sub: `add to the end · ${folderName(n.folder)}`,
    }));
    const out = [...fs.slice(0, 6), ...ns];
    const exact = (folders() ?? []).some((f) => f.path.toLowerCase() === text);
    if (text && !exact) out.push({ t: { kind: "folder", folder: q().trim() }, label: `New folder “${q().trim()}”`, sub: "made when the note is filed" });
    return out;
  };

  const key = (e: KeyboardEvent) => {
    const n = rows().length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n") || (e.key === "Tab" && !e.shiftKey)) setI((i() + 1) % Math.max(1, n));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p") || (e.key === "Tab" && e.shiftKey)) setI((i() + n - 1) % Math.max(1, n));
    else if (e.key === "Enter") {
      const r = rows()[i()];
      if (r) p.onPick(r.t);
    } else if (e.key === "Escape") p.onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="palette dest">
        <input
          class="palette-input"
          ref={input}
          placeholder="Move to a note or a collection…"
          value={q()}
          onInput={(e) => {
            setQ(e.currentTarget.value);
            setI(0);
          }}
          onKeyDown={key}
        />
        <div class="palette-list">
          <For each={rows()}>
            {(r, k) => (
              <button class="palette-row" classList={{ on: k() === i() }} onMouseMove={() => setI(k())} onClick={() => p.onPick(r.t)}>
                <span class="row-icon">{r.t.kind === "note" ? "¶" : "▤"}</span>
                <span class="row-label">{r.label}</span>
                <span class="row-sub">{r.sub}</span>
              </button>
            )}
          </For>
          <Show when={!rows().length}>
            <p class="muted pad">No notes or folders yet.</p>
          </Show>
        </div>
      </div>
    </div>
  );
}
