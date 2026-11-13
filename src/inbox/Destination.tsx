// Where a capture goes: a note to add it to, today's page, or a folder to file it in as its own note. The inbox's
// `m`, the review's `/` and the capture window's Tab open this. Typing narrows the list; a new folder name is
// offered as it is typed. With nothing typed, the places used most and lately come first.

import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { api, type NoteSummary } from "../api";
import { dayTitle, today } from "../journal/days";
import Mark from "../library/Mark";
import { folderName, KeyHints } from "../ui";
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

/** The heading a row sits under. */
const groupOf = (r: Row) => (r.t.kind === "day" ? "Days" : r.t.kind === "note" ? "Add to the end of a note" : r.folder ? "Collections" : "New");
const ORDER = ["Days", "Collections", "Add to the end of a note", "New"];

export default function Destination(p: {
  exclude?: number;
  noDay?: boolean;
  /** What is being moved, for the heading: a note's title. */
  what?: string;
  /** The folder it is in now: shown, and not offered. */
  from?: string;
  onPick(t: Target): void;
  onClose(): void;
}) {
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  const [q, setQ] = createSignal("");
  const [i, setI] = createSignal(0);
  const [folders] = createResource(async () => (await (await api()).noteFolders()).filter((f) => f.path !== "inbox" && !f.path.startsWith(".")));
  const [used] = createResource(filedCounts);
  const [notes] = createResource(q, async (text): Promise<NoteSummary[]> => {
    const s = await api();
    const found = text.trim() ? await s.findNotes(text, 12) : await s.listNotes({ limit: 12 });
    return found.filter((n) => n.folder !== "inbox" && n.id !== p.exclude);
  });
  const count = (folder: string) => folders()?.find((f) => f.path === folder)?.count;

  // Grouped (days, collections, notes, a new one), keeping the learned order inside each group.
  const rows = () => {
    const all = placeRows(
      q(),
      (folders() ?? []).map((f) => f.path),
      notes() ?? [],
      used() ?? {},
      q(),
    ).filter((r) => !(p.noDay && r.t.kind === "day") && !(r.t.kind === "folder" && p.from && r.t.folder === p.from));
    return ORDER.flatMap((g) => all.filter((r) => groupOf(r) === g));
  };

  const pick = (r: Row | undefined) => r && p.onPick(r.t);
  const key = (e: KeyboardEvent) => {
    const n = rows().length;
    const digit = Number(e.key);
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n") || (e.key === "Tab" && !e.shiftKey)) setI((i() + 1) % Math.max(1, n));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p") || (e.key === "Tab" && e.shiftKey)) setI((i() + n - 1) % Math.max(1, n));
    else if (e.key === "Enter") pick(rows()[i()]);
    else if (e.key === "Escape") p.onClose();
    // With nothing typed, a number picks; once typing, digits are part of the name.
    else if (!q() && !e.ctrlKey && !e.altKey && digit >= 1 && digit <= Math.min(9, n)) pick(rows()[digit - 1]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const show = () => queueMicrotask(() => document.querySelector(".dest .palette-row.on")?.scrollIntoView({ block: "nearest" }));

  return (
    <div class="scrim top" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="palette dest" role="dialog" aria-label={p.what ? `Move ${p.what}` : "Where it goes"}>
        <div class="dest-field">
          <span class="dest-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <path d="M10 13h6M13 10l3 3-3 3" />
            </svg>
          </span>
          <label class="dest-label">
            <span class="dest-what">{p.what ? `Move “${p.what}” to` : "Where it goes"}</span>
            <input
              ref={input}
              placeholder="A collection, a note or a day…"
              value={q()}
              onInput={(e) => {
                setQ(e.currentTarget.value);
                setI(0);
              }}
              onKeyDown={(e) => (key(e), show())}
            />
          </label>
          <Show when={p.from}>
            <span class="dest-from">now in {folderName(p.from!)}</span>
          </Show>
        </div>
        <div class="palette-list">
          <For each={rows()}>
            {(r, k) => (
              <>
                <Show when={k() === 0 || groupOf(rows()[k() - 1]) !== groupOf(r)}>
                  <Show when={groupOf(r) !== "New"}>
                    <div class="dest-group">{groupOf(r)}</div>
                  </Show>
                </Show>
                <button class="palette-row" classList={{ on: k() === i(), "dest-new": groupOf(r) === "New" }} onMouseMove={() => setI(k())} onClick={() => p.onPick(r.t)}>
                  <span class="row-icon">
                    <Show
                      when={groupOf(r) !== "New"}
                      fallback={
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                      }
                    >
                      <Show
                        when={r.t.kind !== "note"}
                        fallback={
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                            <path d="M6 3h9l4 4v14H6z" />
                          </svg>
                        }
                      >
                        <Mark folder={r.folder} size={13} />
                      </Show>
                    </Show>
                  </span>
                  <span class="row-label">{r.label}</span>
                  <span class="row-sub">
                    {r.t.kind === "folder" && count(r.folder) !== undefined ? `${count(r.folder)} ${count(r.folder) === 1 ? "note" : "notes"}` : r.t.kind === "note" ? folderName(r.folder) : r.sub}
                  </span>
                  <Show when={k() === i()} fallback={<Show when={!q() && k() < 9}><kbd class="dest-num">{k() + 1}</kbd></Show>}>
                    <kbd>↵</kbd>
                  </Show>
                </button>
              </>
            )}
          </For>
          <Show when={!rows().length}>
            <p class="muted pad">No notes or folders yet.</p>
          </Show>
        </div>
        <footer class="dest-foot">
          <KeyHints hints={[["↑ ↓", "choose"], !q() && ["1–9", "pick"], ["Enter", p.what ? "move" : "choose"], ["Esc", "back"]]} />
          <span class="grow" />
          <Show when={p.what}>
            <span class="muted small">Undo is on the toast</span>
          </Show>
        </footer>
      </div>
    </div>
  );
}
