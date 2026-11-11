// Ctrl K: search or ask. Typing finds notes (by title first, then by words) and commands. A question (ending in
// `?`, or `Tab` on any text) asks Claude to answer from the notes, with the notes it used as cards to open.
// Ctrl P opens the same bar on notes only. A few words narrow the notes found: `in:travel`, `pinned`, `today`,
// `this week`, `has:link`, `has:picture`, `has:task` (palette/filters.ts). After an answer, Tab asks again: the
// follow-up goes with the earlier answers and the same notes, and Ctrl Enter keeps the whole exchange as a note.

import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { api, errText, type AiAnswer, type AiSource, type NoteSummary } from "../api";
import { answerHtml } from "../copy";
import { folderName, Kbd, say } from "../ui";
import { keep, noFilters, parseFilters } from "./filters";
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
  placeholder?: string;
  /** The notes written on last, newest first: the list before anything is typed. */
  recent?: number[];
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
  /** The questions answered before the latest one, in this exchange. */
  const [thread, setThread] = createSignal<{ question: string; answer: AiAnswer }[]>([]);
  const [following, setFollowing] = createSignal(false);
  const [more, setMore] = createSignal("");
  const [moreLoading, setMoreLoading] = createSignal(false);
  const filters = () => parseFilters(q());
  const [notes] = createResource(q, async (text) => {
    const s = await api();
    const f = parseFilters(text);
    if (noFilters(f)) {
      if (!text.trim()) {
        const ids = (p.recent ?? []).slice(0, 8);
        const ns = (await Promise.all(ids.map((id) => s.peekNote(id).catch(() => null)))).filter((n) => !!n);
        const recent: NoteSummary[] = ns.map((n) => ({ id: n.id, path: n.path, folder: n.folder, title: n.title, preview: n.body.slice(0, 200), tags: n.tags, pinned: n.pinned, modifiedAt: n.modifiedAt }));
        if (!p.notesOnly) return recent;
        const seen = new Set(recent.map((n) => n.id));
        return [...recent, ...(await s.listNotes({ limit: 12 })).filter((n) => !seen.has(n.id))].slice(0, 12);
      }
      const [byTitle, byWords] = await Promise.all([s.findNotes(text, 8), s.searchNotes(text, 12)]);
      const seen = new Set(byTitle.map((n) => n.id));
      return [...byTitle, ...byWords.filter((n) => !seen.has(n.id))].slice(0, 12);
    }
    // With filters, look wider and narrow after.
    let found: NoteSummary[];
    if (f.words) {
      const [byTitle, byWords] = await Promise.all([s.findNotes(f.words, 200), s.searchNotes(f.words, 200)]);
      const seen = new Set(byTitle.map((n) => n.id));
      found = [...byTitle, ...byWords.filter((n) => !seen.has(n.id))];
    } else found = await s.listNotes({ limit: 1000 });
    found = found.filter((n) => keep(n, f));
    // `has:` is asked of the engine, which reads every note's text.
    for (const h of f.has) {
      const ok = new Set(await s.notesHaving(h));
      found = found.filter((n) => ok.has(n.id));
    }
    return found.slice(0, 30);
  });

  const commands = () => {
    if (p.notesOnly) return [];
    const live = p.commands.filter((c) => !c.when || c.when());
    return q().trim() ? rank(q(), live, (c) => c.label) : live.slice(0, 9);
  };
  const isQuestion = () => noFilters(filters()) && (/\?\s*$/.test(q()) || /^(what|how|why|when|where|who|which|do|did|does|is|are|can|should|summari[sz]e|list|find)\b/i.test(q().trim()));

  const rows = (): Row[] => {
    const out: Row[] = [];
    const ns = (notes() ?? []).map((n) => ({ kind: "note", n }) as Row);
    const cs = commands().map((c) => ({ kind: "command", c }) as Row);
    if (q().trim() && !p.notesOnly && isQuestion()) out.push({ kind: "ask" });
    // A command that matches well beats notes; otherwise notes first.
    out.push(...(q().trim() && cs.length && ns.length === 0 ? cs : [...ns, ...cs]));
    if (q().trim() && !p.notesOnly && !isQuestion() && noFilters(filters())) out.push({ kind: "ask" });
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
    setThread([]);
    setFollowing(false);
    setAnswer("loading");
    try {
      setAnswer(await (await api()).aiAsk(question));
    } catch (e) {
      setAnswer(null);
      say(errText(e), { error: true });
    }
  }

  /** Every turn so far, the latest last. */
  const turns = () => {
    const a = answer();
    return a && a !== "loading" ? [...thread(), { question: asked(), answer: a }] : thread();
  };

  /** A question that follows the answer: same notes, the talk so far. */
  async function askMore() {
    const question = more().trim();
    const a = answer();
    if (!question || !a || a === "loading" || moreLoading()) return;
    const all = turns();
    const notes = [...new Set(all.flatMap((t) => t.answer.read ?? t.answer.sources.map((s) => s.id)))];
    setMoreLoading(true);
    try {
      const next = await (await api()).aiAsk(
        question,
        all.map((t) => ({ question: t.question, answer: t.answer.answer })),
        notes,
      );
      setThread(all);
      setAsked(question);
      setAnswer(next);
      setMore("");
    } catch (e) {
      say(errText(e), { error: true });
    } finally {
      setMoreLoading(false);
    }
  }

  /** The notes any answer in the exchange came from, each once. */
  const allSources = (): AiSource[] => {
    const seen = new Set<number>();
    return turns()
      .flatMap((t) => t.answer.sources)
      .filter((s) => !seen.has(s.id) && seen.add(s.id));
  };

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
    const all = turns();
    const refs = allSources()
      .map((x) => `- [[${x.title}]]`)
      .join("\n");
    const talk = all.map((t) => `> ${t.question}\n\n${t.answer.answer}`).join("\n\n");
    const first = all[0]?.question ?? asked();
    const n = await s.createNote("", `Q ${first.replace(/[?\\/:*"<>|]/g, "").slice(0, 50)}`, `${talk}\n\n${refs ? `Sources:\n${refs}\n` : ""}`, ["answer"]);
    p.onClose();
    p.onOpen(n.id);
    say("Saved the answer as a note");
  }

  const key = (e: KeyboardEvent) => {
    const n = rows().length;
    if (answer() && e.key === "Escape") {
      e.preventDefault();
      setThread([]);
      setFollowing(false);
      return setAnswer(null);
    }
    if (e.key === "Tab" && answer() && answer() !== "loading" && !p.notesOnly) {
      e.preventDefault();
      e.stopPropagation();
      return setFollowing(true);
    }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setI((i() + 1) % Math.max(1, n));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p" && !p.notesOnly)) setI((i() + n - 1) % Math.max(1, n));
    else if (e.key === "Tab" && !p.notesOnly && q().trim() && noFilters(filters())) void ask();
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
            placeholder={p.placeholder ?? (p.notesOnly ? "Find a note…" : "Search, run a command, or ask your notes a question…")}
            value={q()}
            onInput={(e) => {
              setQ(e.currentTarget.value);
              setI(0);
              setAnswer(null);
              setThread([]);
              setFollowing(false);
            }}
            onKeyDown={key}
          />
          <Show when={!p.notesOnly && q().trim() && noFilters(filters())}>
            <span class="muted small nowrap">
              <kbd>Tab</kbd> {answer() && answer() !== "loading" ? "ask again" : "ask"}
            </span>
          </Show>
        </div>
        <Show when={!noFilters(filters())}>
          <div class="palette-filters">
            <Show when={filters().folder}>
              <span class="chip on">in {filters().folder}</span>
            </Show>
            <Show when={filters().pinned}>
              <span class="chip on">pinned</span>
            </Show>
            <Show when={filters().since !== null}>
              <span class="chip on">since {new Date(filters().since!).toLocaleDateString(undefined, { weekday: "long" })}</span>
            </Show>
            <For each={filters().has}>{(h) => <span class="chip on">has a {h}</span>}</For>
            <span class="muted small">{notes()?.length ?? 0} found</span>
          </div>
        </Show>
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
                    <For each={thread()}>
                      {(t) => (
                        <div class="answer-turn earlier">
                          <p class="answer-q">{t.question}</p>
                          <div class="answer-text" innerHTML={answerHtml(t.answer.answer)} />
                        </div>
                      )}
                    </For>
                    <Show when={thread().length}>
                      <p class="answer-q">{asked()}</p>
                    </Show>
                    <div class="answer-text" innerHTML={answerHtml(a.answer)} />
                    <Show when={following()}>
                      <form
                        class="answer-more"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void askMore();
                        }}
                      >
                        <span class="spark">✦</span>
                        <input
                          ref={(el) => setTimeout(() => el.focus())}
                          placeholder="Ask again, about the same notes…"
                          value={more()}
                          disabled={moreLoading()}
                          onInput={(e) => setMore(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.preventDefault();
                              e.stopPropagation();
                              setFollowing(false);
                              input.focus();
                            } else if (e.key === "Enter" && e.ctrlKey) {
                              e.preventDefault();
                              e.stopPropagation();
                              void saveAnswer();
                            }
                          }}
                        />
                        <Show when={moreLoading()} fallback={<span class="muted small nowrap"><kbd>Enter</kbd> ask</span>}>
                          <span class="ai-thinking small">Claude is reading…</span>
                        </Show>
                      </form>
                    </Show>
                    <Show when={allSources().length}>
                      <div class="sources">
                        <For each={allSources()}>
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
                      <Show when={!following()}>
                        <button class="btn" onClick={() => setFollowing(true)}>
                          Ask again <kbd>Tab</kbd>
                        </button>
                      </Show>
                      <button class="btn primary" onClick={saveAnswer}>
                        {thread().length ? "Save the exchange as a note" : "Save answer as a note"} <Kbd keys="Ctrl Enter" />
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
