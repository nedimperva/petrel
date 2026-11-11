// Ctrl K: search or ask. Typing finds notes (by title first, then by words) and commands. A question (ending in
// `?`, or `Tab` on any text) asks Claude to answer from the notes, with the notes it used as cards to open.
// Ctrl P opens the same bar on notes only.

import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { api, errText, type AiAnswer, type NoteSummary } from "../api";
import { answerHtml } from "../copy";
import { folderName, Kbd, say } from "../ui";
import { rank } from "./match";

export interface Command {
  id: string;
  label: string;
  keys?: string;
  /** Hidden unless the condition holds (a note is open, say). */
  when?: () => boolean;
  run(): void;
}

type Row = { kind: "ask" } | { kind: "note"; n: NoteSummary } | { kind: "command"; c: Command };

export default function CommandBar(p: {
  commands: Command[];
  notesOnly?: boolean;
  aiReady: boolean;
  onOpen(id: number): void;
  onAiSetup(): void;
  onClose(): void;
}) {
  let input!: HTMLInputElement;
  // Focused at once, so the first letters typed after Ctrl K are not lost.
  onMount(() => input.focus());
  const [q, setQ] = createSignal("");
  const [i, setI] = createSignal(0);
  const [answer, setAnswer] = createSignal<AiAnswer | "loading" | null>(null);
  const [asked, setAsked] = createSignal("");
  const [notes] = createResource(q, async (text) => {
    const s = await api();
    if (!text.trim()) return p.notesOnly ? s.listNotes({ limit: 12 }) : [];
    const [byTitle, byWords] = await Promise.all([s.findNotes(text, 8), s.searchNotes(text, 12)]);
    const seen = new Set(byTitle.map((n) => n.id));
    return [...byTitle, ...byWords.filter((n) => !seen.has(n.id))].slice(0, 12);
  });

  const commands = () => {
    if (p.notesOnly) return [];
    const live = p.commands.filter((c) => !c.when || c.when());
    return q().trim() ? rank(q(), live, (c) => c.label) : live.slice(0, 9);
  };
  const isQuestion = () => /\?\s*$/.test(q()) || /^(what|how|why|when|where|who|which|do|did|does|is|are|can|should|summari[sz]e|list|find)\b/i.test(q().trim());

  const rows = (): Row[] => {
    const out: Row[] = [];
    const ns = (notes() ?? []).map((n) => ({ kind: "note", n }) as Row);
    const cs = commands().map((c) => ({ kind: "command", c }) as Row);
    if (q().trim() && !p.notesOnly && isQuestion()) out.push({ kind: "ask" });
    // A command that matches well beats notes; otherwise notes first.
    out.push(...(q().trim() && cs.length && ns.length === 0 ? cs : [...ns, ...cs]));
    if (q().trim() && !p.notesOnly && !isQuestion()) out.push({ kind: "ask" });
    return out;
  };

  async function ask() {
    const question = q().trim();
    if (!question) return;
    if (!p.aiReady) {
      p.onClose();
      return p.onAiSetup();
    }
    setAsked(question);
    setAnswer("loading");
    try {
      setAnswer(await (await api()).aiAsk(question));
    } catch (e) {
      setAnswer(null);
      say(errText(e), { error: true });
    }
  }

  const choose = (r: Row | undefined) => {
    if (!r) return;
    if (r.kind === "ask") return void ask();
    p.onClose();
    if (r.kind === "note") p.onOpen(r.n.id);
    else r.c.run();
  };

  async function saveAnswer() {
    const a = answer();
    if (!a || a === "loading") return;
    const s = await api();
    const refs = a.sources.map((x) => `- [[${x.title}]]`).join("\n");
    const n = await s.createNote("", `Q ${asked().replace(/[?\\/:*"<>|]/g, "").slice(0, 50)}`, `> ${asked()}\n\n${a.answer}\n\n${refs ? `Sources:\n${refs}\n` : ""}`, ["answer"]);
    p.onClose();
    p.onOpen(n.id);
    say("Saved the answer as a note");
  }

  const key = (e: KeyboardEvent) => {
    const n = rows().length;
    if (answer() && e.key === "Escape") {
      e.preventDefault();
      return setAnswer(null);
    }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setI((i() + 1) % Math.max(1, n));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p" && !p.notesOnly)) setI((i() + n - 1) % Math.max(1, n));
    else if (e.key === "Tab" && !p.notesOnly && q().trim()) void ask();
    else if (e.key === "Enter" && answer() && answer() !== "loading" && e.ctrlKey) void saveAnswer();
    else if (e.key === "Enter") choose(rows()[i()]);
    else if (e.key === "Escape") p.onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class="scrim top" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="palette" classList={{ answering: !!answer() }}>
        <div class="palette-field">
          <span class="spark">{p.notesOnly ? "¶" : "✦"}</span>
          <input
            class="palette-input"
            ref={input}
            placeholder={p.notesOnly ? "Find a note…" : "Search, run a command, or ask your notes a question…"}
            value={q()}
            onInput={(e) => {
              setQ(e.currentTarget.value);
              setI(0);
              setAnswer(null);
            }}
            onKeyDown={key}
          />
          <Show when={!p.notesOnly && q().trim()}>
            <span class="muted small nowrap">
              <kbd>Tab</kbd> ask
            </span>
          </Show>
        </div>
        <Show
          when={answer()}
          fallback={
            <div class="palette-list">
              <For each={rows()}>
                {(r, k) => (
                  <button class="palette-row" classList={{ on: k() === i(), ask: r.kind === "ask" }} onMouseMove={() => setI(k())} onClick={() => choose(r)}>
                    {r.kind === "ask" ? (
                      <>
                        <span class="row-icon spark">✦</span>
                        <span class="row-label">Ask your notes: “{q().trim()}”</span>
                        <span class="row-sub">{p.aiReady ? "Claude answers from your notes" : "add a key in Settings first"}</span>
                      </>
                    ) : r.kind === "note" ? (
                      <>
                        <span class="row-icon">¶</span>
                        <span class="row-label">{r.n.folder === "inbox" ? r.n.preview.split("\n")[0] || r.n.title : r.n.title}</span>
                        <span class="row-sub">{folderName(r.n.folder)}</span>
                      </>
                    ) : (
                      <>
                        <span class="row-icon">›</span>
                        <span class="row-label">{r.c.label}</span>
                        <Show when={r.c.keys}>
                          <Kbd keys={r.c.keys!} />
                        </Show>
                      </>
                    )}
                  </button>
                )}
              </For>
              <Show when={!rows().length}>
                <p class="muted pad">{q().trim() ? "Nothing found." : p.notesOnly ? "No notes yet." : "Type to search your notes."}</p>
              </Show>
            </div>
          }
        >
          <div class="answer">
            <Show when={answer() !== "loading"} fallback={<p class="ai-thinking">Claude is reading your notes…</p>}>
              {(() => {
                const a = answer() as AiAnswer;
                return (
                  <>
                    <div class="answer-text" innerHTML={answerHtml(a.answer)} />
                    <Show when={a.sources.length}>
                      <div class="sources">
                        <For each={a.sources}>
                          {(s) => (
                            <button class="source" onClick={() => (p.onClose(), p.onOpen(s.id))}>
                              <span class="source-title">{s.folder === "inbox" ? "A capture" : s.title}</span>
                              <span class="source-where">{folderName(s.folder)}</span>
                              <span class="source-text">{s.preview}</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                    <div class="row end">
                      <Show when={a.sources.length}>
                        <button class="btn" onClick={() => (p.onClose(), p.onOpen(a.sources[0].id))}>
                          Open {a.sources[0].title}
                        </button>
                      </Show>
                      <button class="btn primary" onClick={saveAnswer}>
                        Save answer as a note <Kbd keys="Ctrl Enter" />
                      </button>
                    </div>
                  </>
                );
              })()}
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
