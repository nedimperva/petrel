// "The week, when you ask" (`Ctrl J` on today's page, or the command bar). What you wrote and what is still open
// are counted here, from the files, with no AI. Claude writes a few sentences on the week only after Enter, and
// says first how much it will read. Enter keeps it as `journal/<year>-W<week>.md`; Esc closes and saves nothing.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type Note } from "../api";
import { colorOf, topOf } from "../library/faces";
import { faces, loadFaces } from "../library/Mark";
import { folderName, say } from "../ui";
import { dayTitle, isDayNote, isoWeek, JOURNAL, lastWeek } from "./days";

interface Open {
  text: string;
  note: Note;
}

/** Unchecked `- [ ]` items, each with its note. */
export function openTasks(notes: Note[], max = 8): Open[] {
  const out: Open[] = [];
  for (const n of notes) {
    for (const line of n.body.split("\n")) {
      const m = /^\s*[-*+] \[ \]\s+(.+)$/.exec(line);
      if (m) out.push({ text: m[1].trim(), note: n });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** `[[Title]]` in a sentence as pieces to draw: text, or a title to open. */
function pieces(text: string): { text: string; link?: string }[] {
  const out: { text: string; link?: string }[] = [];
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[1], link: m[1] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

export default function Week(p: { aiReady: boolean; onClose(): void; onOpen(id: number): void; onAiSetup(): void; onReview(): void }) {
  const range = lastWeek();
  // Signals, not resources: this sits over the page, and a resource would suspend the page under it.
  const [notes, setNotes] = createSignal<Note[] | undefined>();
  const [inbox, setInbox] = createSignal(0);
  onMount(async () => {
    const s = await api();
    setNotes(await s.notesBetween(range.from, range.to).catch(() => []));
    setInbox((await s.listNotes({ folder: "inbox", limit: 1000 }).catch(() => [])).length);
  });
  const [prose, setProse] = createSignal<string | "asking" | null>(null);
  onMount(() => void loadFaces());

  const words = createMemo(() => (notes() ?? []).reduce((a, n) => a + n.body.split(/\s+/).filter(Boolean).length, 0));
  /** New this week, by collection: what you caught. */
  const caught = createMemo(() => {
    const by = new Map<string, number>();
    for (const n of notes() ?? []) {
      if (n.createdAt < range.from || n.folder === JOURNAL) continue;
      const t = n.folder === "inbox" ? "inbox" : topOf(n.folder);
      by.set(t, (by.get(t) ?? 0) + 1);
    }
    return [...by.entries()].sort((a, b) => b[1] - a[1]);
  });
  const total = () => caught().reduce((a, [, n]) => a + n, 0);
  const open = createMemo(() => openTasks(notes() ?? []));

  async function ask() {
    if (!p.aiReady) return p.onAiSetup();
    setProse("asking");
    try {
      setProse(await (await api()).aiWeek(range.from, range.to));
    } catch (e) {
      setProse(null);
      say(errText(e), { error: true });
    }
  }

  const text = () => {
    const out: string[] = [];
    const pr = prose();
    if (pr && pr !== "asking") out.push(pr.trim());
    if (caught().length) out.push(`What I wrote: ${caught().map(([t, n]) => `${folderName(t)} ${n}`).join(", ")}.`);
    if (open().length) out.push(`## Still open\n\n${open().map((o) => `- [ ] ${o.text} ([[${o.note.title}]])`).join("\n")}`);
    return out.join("\n\n") + "\n";
  };

  async function keep() {
    try {
      const s = await api();
      const n = await s.createNote(JOURNAL, isoWeek(), text(), ["week"]);
      say(`Kept as ${n.path}`);
      p.onClose();
      p.onOpen(n.id);
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function follow(title: string) {
    const r = await (await api()).resolveLink(title);
    if (r.kind === "note") {
      p.onClose();
      p.onOpen(r.id);
    }
  }

  const key = (e: KeyboardEvent) => {
    const pr = prose();
    if (e.key === "Escape") p.onClose();
    else if (e.key === "Enter" && !e.ctrlKey && pr === null && (notes()?.length ?? 0) > 0) void ask();
    else if (e.key === "Enter" && pr && pr !== "asking") void keep();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && pr && pr !== "asking" && !getSelection()?.toString()) {
      void api()
        .then((s) => s.copyText(text(), false))
        .then(() => say("Copied the week"));
    } else if (e.key.toLowerCase() === "r" && !e.ctrlKey && pr && pr !== "asking") void ask();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => document.addEventListener("keydown", key, true));
  onCleanup(() => document.removeEventListener("keydown", key, true));

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="dialog week" role="dialog" aria-label="Your week">
        <header class="dialog-head">
          <h2>Your week, {range.label}</h2>
          <span class="grow" />
          <span class="muted small">from {notes()?.length ?? "…"} notes</span>
        </header>

        <section class="week-caught">
          <div class="muted small">What you wrote · {total()}</div>
          <Show when={total()} fallback={<p class="muted">Nothing new this week yet.</p>}>
            <div class="week-bar" role="img" aria-label={caught().map(([t, n]) => `${folderName(t)} ${n}`).join(", ")}>
              <For each={caught()}>{([t, n]) => <span class={`hue-${colorOf(t, faces())}`} style={{ flex: n }} />}</For>
            </div>
            <div class="week-legend">
              <For each={caught()}>
                {([t, n]) => (
                  <span>
                    <span class={`dot hue-${colorOf(t, faces())}`} /> {folderName(t)} {n}
                  </span>
                )}
              </For>
            </div>
          </Show>
        </section>

        <section class="week-prose">
          <Show
            when={prose()}
            fallback={
              <div class="week-ask">
                <span class="spark">✦</span>
                <p>
                  Claude can look back on it with you. It reads this week's {notes()?.length ?? 0} notes, about {words().toLocaleString()} words, and
                  nothing else. <b>Enter</b> sends, <b>Esc</b> doesn't.
                </p>
              </div>
            }
          >
            <Show when={prose() !== "asking"} fallback={<p class="ai-thinking">Claude is reading your week…</p>}>
              <For each={(prose() as string).split(/\n{2,}/)}>
                {(para) => (
                  <p>
                    <For each={pieces(para)}>
                      {(x) =>
                        x.link ? (
                          <button class="link" onClick={() => void follow(x.link!)}>
                            {x.text}
                          </button>
                        ) : (
                          x.text
                        )
                      }
                    </For>
                  </p>
                )}
              </For>
            </Show>
          </Show>
        </section>

        <section class="week-open">
          <div class="muted small">Still open</div>
          <For each={open()}>
            {(o) => (
              <div class="week-task">
                <span class="muted">☐</span>
                <span class="grow">{o.text}</span>
                <button class="link small" onClick={() => (p.onClose(), p.onOpen(o.note.id))}>
                  {isDayNote(o.note.folder, o.note.title) ? dayTitle(o.note.title) : o.note.title}
                </button>
              </div>
            )}
          </For>
          <Show when={inbox()}>
            <div class="week-task">
              <span class="muted">☐</span>
              <span class="grow">
                {inbox()} {inbox() === 1 ? "capture" : "captures"} waiting in the Inbox
              </span>
              <button class="link small" onClick={() => (p.onClose(), p.onReview())}>
                Review
              </button>
            </div>
          </Show>
          <Show when={!open().length && !inbox()}>
            <p class="muted small">Nothing left open.</p>
          </Show>
        </section>

        <footer class="week-foot">
          <Show
            when={prose() && prose() !== "asking"}
            fallback={
              <span>
                <kbd>Enter</kbd> ask Claude
              </span>
            }
          >
            <span>
              <kbd>Enter</kbd> keep as {JOURNAL}/{isoWeek()}.md
            </span>
            <span>
              <kbd>Ctrl C</kbd> copy
            </span>
            <span>
              <kbd>R</kbd> try again
            </span>
          </Show>
          <span class="grow" />
          <span>
            <kbd>Esc</kbd> close, nothing saved
          </span>
        </footer>
      </div>
    </div>
  );
}
