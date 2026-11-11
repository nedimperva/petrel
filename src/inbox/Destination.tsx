// Where a capture goes: a note to add it to, today's page, or a folder to file it in as its own note. The inbox's
// `m`, the review's `/` and the capture window's Tab open this. Typing narrows the list; a new folder name is
// offered as it is typed. With nothing typed, the places used most and lately come first.

import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { api, type NoteSummary } from "../api";
import { dayTitle, today } from "../journal/days";
import Mark from "../library/Mark";
import { folderName } from "../ui";
import { filedCounts } from "./file";
import { keyOf, score } from "./learn";

/** `day` without a date is today's page. */
export type Target = { kind: "note"; id: number; title: string } | { kind: "folder"; folder: string } | { kind: "day"; date?: string };

export function targetLabel(t: Target | null): string {
  if (!t) return "Inbox";
  if (t.kind === "day") return !t.date || t.date === today() ? "Today's page" : dayTitle(t.date);
  return t.kind === "note" ? t.title : folderName(t.folder);
}

/** The folder a target files into, for its mark. */
export const targetFolder = (t: Target | null, folderOfNote?: string) =>
  !t ? "inbox" : t.kind === "day" ? "journal" : t.kind === "folder" ? t.folder : (folderOfNote ?? "");

export interface Row {
  t: Target;
  label: string;
  sub: string;
  folder: string;
}

/** The places to offer, best first: learned order when nothing is typed, else what matches. */
export function placeRows(text: string, folders: string[], notes: NoteSummary[], used: Record<string, { n: number; at: number }>, typed: string): Row[] {
  const q = text.trim().toLowerCase();
  const day: Row = { t: { kind: "day" }, label: "Today's page", sub: "under the time", folder: "journal" };
  const fs = folders
    .filter((f) => f !== "journal" && (!q || f.toLowerCase().includes(q) || folderName(f).toLowerCase().includes(q)))
    .map((f): Row => ({ t: { kind: "folder", folder: f }, label: folderName(f), sub: "as a new note in this folder", folder: f }));
  const ns = notes.map((n): Row => ({ t: { kind: "note", id: n.id, title: n.title }, label: n.title, sub: `add to the end · ${folderName(n.folder)}`, folder: n.folder }));
  let out: Row[];
  if (!q) {
    const all = [day, ...fs, ...ns];
    const s = (r: Row) => score(used[keyOf(r.t)]);
    // Learned places first; the rest keep their order (folders, then recent notes).
    out = [...all.filter((r) => s(r) > 0).sort((a, b) => s(b) - s(a)), ...all.filter((r) => s(r) === 0)];
  } else {
    out = [...("today's page journal day".includes(q) || q.startsWith("tod") ? [day] : []), ...fs.slice(0, 6), ...ns];
  }
  const exact = folders.some((f) => f.toLowerCase() === q);
  if (q && !exact) out.push({ t: { kind: "folder", folder: typed.trim() }, label: `New folder “${typed.trim()}”`, sub: "made when the note is filed", folder: "" });
  return out;
}

export default function Destination(p: { exclude?: number; noDay?: boolean; onPick(t: Target): void; onClose(): void }) {
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  const [q, setQ] = createSignal("");
  const [i, setI] = createSignal(0);
  const [folders] = createResource(async () =>
    (await (await api()).noteFolders()).map((f) => f.path).filter((f) => f !== "inbox" && !f.startsWith(".")),
  );
  const [used] = createResource(filedCounts);
  const [notes] = createResource(q, async (text): Promise<NoteSummary[]> => {
    const s = await api();
    const found = text.trim() ? await s.findNotes(text, 12) : await s.listNotes({ limit: 12 });
    return found.filter((n) => n.folder !== "inbox" && n.id !== p.exclude);
  });

  const rows = () => placeRows(q(), folders() ?? [], notes() ?? [], used() ?? {}, q()).filter((r) => !(p.noDay && r.t.kind === "day"));

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
          placeholder="Move to a note, a collection or today's page…"
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
                <span class="row-icon">{r.t.kind === "note" ? "¶" : <Mark folder={r.folder} size={13} />}</span>
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
