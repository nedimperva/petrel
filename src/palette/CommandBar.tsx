// Ctrl K: search or ask. Typing finds notes (by title first, then by words) and commands. A question (ending in
// `?`, or the Ask row at the end of the list) asks Claude to answer from the notes, with the notes it used as cards to open.
// Ctrl P opens the same bar on notes only. A few words narrow the notes found: `in:travel`, `is:pinned`, `when:today`,
// `when:week`, `has:link`, `has:picture`, `has:task` (palette/filters.ts). After an answer, Tab asks again: the
// follow-up goes with the earlier answers and the same notes, and Ctrl Enter keeps the whole exchange as a note.

import { previewLines, type PreviewLine } from "../notes/plain";
import { withoutCopies } from "../notes/conflict";
import { listName } from "../journal/days";
import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { aiLive, api, errText, type AiAnswer, type AiSource, type Conflict, type NoteSummary } from "../api";
import { answerHtml } from "../copy";
import { ago, folderName, Kbd, say } from "../ui";
import { acceptOffer, inFolder, keep, noFilters, parseFilters } from "./filters";
import { rank } from "./match";
import { jumpTo } from "../note/jump";
import { usageLine } from "../ai/usage";

export interface Command {
  id: string;
  label: string;
  keys?: string;
  /** Hidden unless the condition holds (a note is open, say). */
  when?: () => boolean;
  run(): void;
}

const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Row = { kind: "ask" } | { kind: "note"; n: NoteSummary } | { kind: "command"; c: Command } | { kind: "new"; title: string; folder: string };

/** An answer still being written, without the `Sources:` line it ends with. */
/** Words that read as a question: they end in `?` or start like one. */
const asks = (t: string) => /\?\s*$/.test(t) || /^(what|how|why|when|where|who|which|do|did|does|is|are|can|should|summari[sz]e|list|find)\b/i.test(t.trim());

const unsourced = (t: string) => t.replace(/\n\s*\**Sources:[\s\S]*$/, "");

export default function CommandBar(p: {
  commands: Command[];
  notesOnly?: boolean;
  placeholder?: string;
  /** The notes written on last, newest first: the list before anything is typed. */
  recent?: number[];
  aiReady: boolean;
  /** Questions about this note alone ("Ask about this note" in Ctrl J): no search, only the Ask row. */
  about?: { id: number; title: string };
  /** A question to ask at once, when the bar opens. */
  ask?: string;
  onOpen(id: number): void;
  onAiSetup(): void;
  /** Settle a note changed in two places, from its "to settle" mark. */
  onSettle?(c: Conflict): void;
  onClose(): void;
}) {
  let input!: HTMLInputElement;
  // Focused at once, so the first letters typed after Ctrl K are not lost.
  onMount(() => {
    input.focus();
    if (p.ask?.trim()) void ask();
  });
  const [q, setQ] = createSignal(p.ask ?? "");
  /** Every note the filters let through, not only the ones listed: what a question with filters reads. */
  const [within, setWithin] = createSignal<number[]>([]);
  const [i, setI] = createSignal(0);
  const [answer, setAnswer] = createSignal<AiAnswer | "loading" | null>(null);
  /** The answer as it is written. */
  const [partial, setPartial] = createSignal("");
  /** The answer being written now; closing the bar stops it. */
  let running: string | null = null;
  onCleanup(() => {
    if (running) void api().then((a) => a.aiCancel(running!));
  });
  const [asked, setAsked] = createSignal("");
  /** The questions answered before the latest one, in this exchange. */
  const [thread, setThread] = createSignal<{ question: string; answer: AiAnswer }[]>([]);
  const [following, setFollowing] = createSignal(false);
  const [more, setMore] = createSignal("");
  const [moreLoading, setMoreLoading] = createSignal(false);
  const filters = () => parseFilters(q());
  const [notes] = createResource(q, async (text) => {
    if (p.about) return [];
    const s = await api();
    const f = parseFilters(text);
    if (noFilters(f)) {
      if (!text.trim()) {
        const ids = (p.recent ?? []).slice(0, 8);
        const ns = (await Promise.all(ids.map((id) => s.peekNote(id).catch(() => null)))).filter((n) => !!n);
        const recent: NoteSummary[] = withoutCopies(ns).map((n) => ({ id: n.id, path: n.path, folder: n.folder, title: n.title, preview: n.body.slice(0, 200), tags: n.tags, pinned: n.pinned, modifiedAt: n.modifiedAt }));
        // Ctrl K opens on notes: the ones opened lately, then the last edited, so it is never only commands.
        const want = p.notesOnly ? 12 : 6;
        if (recent.length >= want) return recent.slice(0, want);
        const seen = new Set(recent.map((n) => n.id));
        const edited = (await s.listNotes({ limit: want + 4 })).filter((n) => !seen.has(n.id));
        return [...recent, ...edited].slice(0, want);
      }
      const [byTitle, byWords] = await Promise.all([s.findNotes(text, 8), s.searchNotes(text, 12)]);
      const seen = new Set(byTitle.map((n) => n.id));
      return [...byTitle, ...byWords.filter((n) => !seen.has(n.id))].slice(0, 12);
    }
    // With filters, look wider and narrow after.
    let found: NoteSummary[];
    // A question with filters lists every note the filters let through: the question is asked of them all.
    if (f.words && !asks(f.words)) {
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
    setWithin(found.map((n) => n.id));
    return found.slice(0, 30);
  });

  /** What a new note from the typed text would be: the words as its title, `@word` as its collection. */
  const newNote = (): { title: string; folder: string } | null => {
    if (!noFilters(filters())) return null;
    const text = q().trim();
    const at = /(^|\s)@(\S+)/.exec(text);
    const title = text.replace(/(^|\s)@\S+/, " ").replace(/\s+/g, " ").trim();
    if (!title || title.length > 120) return null;
    const typed = at?.[2] ?? "";
    const known = typed ? (folders() ?? []).find((f) => inFolder(f, typed) && !f.includes("/")) : undefined;
    return { title, folder: known ?? typed };
  };
  const [folders] = createResource(async () => (await (await api()).noteFolders()).map((f) => f.path).filter((f) => f && !f.startsWith(".")));

  const commands = () => {
    if (p.notesOnly) return [];
    const live = p.commands.filter((c) => !c.when || c.when());
    return q().trim() ? rank(q(), live, (c) => c.label) : live.slice(0, 9);
  };
  /** The words asked, without the filters: `in:travel what did I pack?` asks "what did I pack?" of travel. */
  const question = () => (noFilters(filters()) ? q().trim() : filters().words);
  const isQuestion = () =>
    !!p.about || asks(question());

  const rows = (): Row[] => {
    const out: Row[] = [];
    if (p.about) return q().trim() ? [{ kind: "ask" }] : [];
    const ns = (notes() ?? []).map((n) => ({ kind: "note", n }) as Row);
    const cs = commands().map((c) => ({ kind: "command", c }) as Row);
    if (q().trim() && !p.notesOnly && isQuestion()) out.push({ kind: "ask" });
    // A command that matches well beats notes; otherwise notes first.
    out.push(...(q().trim() && cs.length && ns.length === 0 ? cs : [...ns, ...cs]));
    if (q().trim() && !p.notesOnly && !isQuestion() && noFilters(filters())) out.push({ kind: "ask" });
    // No note by that name: make it. `@travel` says where.
    const want = newNote();
    if (want && !isQuestion() && !(notes() ?? []).some((n) => n.title.toLowerCase() === want.title.toLowerCase())) {
      // After the notes; with no note found, after the commands that match too, so "trash" still runs Trash.
      out.splice(ns.length ? ns.length : cs.length && q().trim() ? cs.length : 0, 0, { kind: "new", ...want });
    }
    return out;
  };

  // The highlighted note, shown beside the list with the typed words marked. A signal, not a resource: a
  // resource read under App's Suspense would suspend the page behind the bar.
  const [peek, setPeek] = createSignal<{ id: number; title: string; folder: string; at: number; body: string } | null>(null);
  createEffect(() => {
    const r = rows()[i()];
    if (!r || r.kind !== "note") return setPeek(null);
    const id = r.n.id;
    void api()
      .then((s) => s.peekNote(id))
      .then((n) => {
        const now = rows()[i()];
        if (now?.kind === "note" && now.n.id === id) setPeek({ id, title: n.title, folder: n.folder, at: n.modifiedAt, body: n.body });
      })
      .catch(() => setPeek(null));
  });
  /** The words to mark: what was typed, without the filter words. */
  const marked = () => (filters().words || "").split(/\s+/).filter((w) => w.length > 1);
  /** A paragraph cut into plain and marked pieces; never HTML. */
  const pieces = (text: string): { t: string; on: boolean }[] => {
    const ws = marked();
    if (!ws.length) return [{ t: text, on: false }];
    const re = new RegExp(`(${ws.map(escapeRe).join("|")})`, "giu");
    return text.split(re).filter(Boolean).map((t) => ({ t, on: ws.some((w) => w.toLowerCase() === t.toLowerCase()) }));
  };
  // The preview starts at the passage with the words, when they are further down than it shows. Headings, items and
  // tasks keep a line each, so the preview reads like the page.
  const lines = (): (PreviewLine | "…")[] => {
    const body = peek()?.body ?? "";
    const lower = body.toLowerCase();
    const hits = marked().map((w) => lower.indexOf(w.toLowerCase())).filter((x) => x >= 0);
    const first = hits.length ? Math.min(...hits) : 0;
    const from = first > 600 ? body.lastIndexOf("\n\n", first) + 2 : 0;
    const out = previewLines(body.slice(from, from + 2400)).slice(0, 14);
    return from > 0 ? ["…", ...out] : out;
  };

  /** Notes with a conflict copy beside them, by the note: Ctrl K marks them "to settle". */
  const [clashes] = createResource(async () => {
    const all = await (await api()).conflicts().catch(() => [] as Conflict[]);
    return new Map(all.map((c) => [c.original, c]));
  });
  const clash = (id: number) => clashes()?.get(id);
  const settle = (c: Conflict) => {
    const go = p.onSettle;
    p.onClose();
    go?.(c);
  };

  /** A note named in an answer, `[[Title]]`: click it to open it. */
  async function openCited(title: string) {
    const known = allSources().find((x) => x.title === title);
    const open = p.onOpen;
    if (known) return (p.onClose(), open(known.id));
    const r = await (await api()).resolveLink(title);
    if (r.kind === "note") (p.onClose(), open(r.id));
  }

  async function ask() {
    const asking = question();
    if (!asking) return;
    if (!p.aiReady) {
      p.onClose();
      return p.onAiSetup();
    }
    setAsked(asking);
    setThread([]);
    setFollowing(false);
    setAnswer("loading");
    const live = aiLive(setPartial);
    running = live.id;
    setPartial("");
    try {
      const only = p.about ? [p.about.id] : undefined;
      const among = !p.about && !noFilters(filters()) ? within() : undefined;
      setAnswer(await (await api()).aiAsk(asking, undefined, only, live, among));
    } catch (e) {
      setAnswer(null);
      if (running === live.id) say(errText(e), { error: true });
    } finally {
      if (running === live.id) running = null;
      setPartial("");
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
    const live = aiLive(setPartial);
    running = live.id;
    setPartial("");
    try {
      const next = await (await api()).aiAsk(
        question,
        all.map((t) => ({ question: t.question, answer: t.answer.answer })),
        notes,
        live,
      );
      setThread(all);
      setAsked(question);
      setAnswer(next);
      setMore("");
    } catch (e) {
      say(errText(e), { error: true });
    } finally {
      if (running === live.id) running = null;
      setPartial("");
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
    if (r.kind === "new") return void makeNote(r.title, r.folder);
    // Read before closing: the bar's owner may hand a different onOpen while it is open (a note beside).
    const open = p.onOpen;
    p.onClose();
    if (r.kind === "note") {
      jumpTo(r.n.id, marked());
      open(r.n.id);
    } else r.c.run();
  };

  async function makeNote(title: string, folder: string) {
    const open = p.onOpen;
    try {
      const n = await (await api()).createNote(folder, title, "", []);
      p.onClose();
      open(n.id);
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

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
    // A plain word that could be a filter ("today", "pinned") becomes one on Tab.
    if (e.key === "Tab" && !answer() && filters().offers.length) {
      e.preventDefault();
      e.stopPropagation();
      setQ(acceptOffer(q()));
      input.value = q();
      return setI(0);
    }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setI((i() + 1) % Math.max(1, n));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p" && !p.notesOnly)) setI((i() + n - 1) % Math.max(1, n));
    else if (e.key === "Enter" && answer() && answer() !== "loading" && e.ctrlKey) void saveAnswer();
    else if (e.key === "Enter") choose(rows()[i()]);
    else if (e.key === "Escape") p.onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class="scrim top" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="palette" classList={{ answering: !!answer(), previewing: !answer() && !!peek() }}>
        <div class="palette-field">
          <span class="spark">{p.notesOnly ? "¶" : "✦"}</span>
          <input
            class="palette-input"
            ref={input}
            placeholder={p.placeholder ?? (p.about ? `Ask about ${p.about.title}…` : p.notesOnly ? "Find a note…" : "Search, run a command, or ask your notes a question…")}
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
          <Show when={!answer() && filters().offers[0]}>
            {(o) => (
              <button class="filter-offer small nowrap" onMouseDown={(e) => (e.preventDefault(), setQ(acceptOffer(q())), (input.value = q()))}>
                <kbd>Tab</kbd> {o().label}
              </button>
            )}
          </Show>
          <Show when={!p.notesOnly && answer() && answer() !== "loading"}>
            <span class="muted small nowrap">
              <kbd>Tab</kbd> ask again
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
            <div class="palette-body">
            <div class="palette-list">
              <For each={rows()}>
                {(r, k) => (
                  <button class="palette-row" classList={{ on: k() === i(), ask: r.kind === "ask" }} onMouseMove={() => setI(k())} onClick={() => choose(r)}>
                    {r.kind === "ask" ? (
                      <>
                        <span class="row-icon spark">✦</span>
                        <span class="row-label">
                          {p.about ? "Ask about this note" : noFilters(filters()) ? "Ask your notes" : "Ask these notes"}: “{question()}”
                        </span>
                        <span class="row-sub">
                          {!p.aiReady ? "add a key in Settings first" : p.about ? `Claude answers from ${p.about.title}` : noFilters(filters()) ? "Claude answers from your notes" : `Claude reads only the ${within().length} found`}
                        </span>
                      </>
                    ) : r.kind === "new" ? (
                      <>
                        <span class="row-icon">+</span>
                        <span class="row-label">New note “{r.title}”</span>
                        <span class="row-sub">{r.folder ? `in ${folderName(r.folder)}` : "add @collection to file it"}</span>
                      </>
                    ) : r.kind === "note" ? (
                      <>
                        <span class="row-icon">¶</span>
                        <span class="row-label">{r.n.folder === "inbox" ? r.n.preview.split("\n")[0] || r.n.title : listName(r.n)}</span>
                        <Show when={clash(r.n.id)} fallback={<span class="row-sub">{folderName(r.n.folder)}</span>}>
                          <span class="row-sub row-settle">to settle</span>
                        </Show>
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
            <Show when={peek()}>
              {(n) => (
                <article class="palette-peek" aria-label={`Preview of ${n().title}`}>
                  <p class="peek-meta">
                    {folderName(n().folder)} · edited {ago(n().at)}
                  </p>
                  <Show when={clash(n().id)}>
                    {(c) => (
                      <p class="peek-clash">
                        <span>Changed in two places, {ago(c().copiedAt)}</span>
                        <Show when={p.onSettle}>
                          <button type="button" class="link" onMouseDown={(e) => (e.preventDefault(), settle(c()))}>
                            Settle it
                          </button>
                        </Show>
                      </p>
                    )}
                  </Show>
                  <h2 class="peek-title">{n().folder === "inbox" ? "A capture" : listName(n())}</h2>
                  <For each={lines()}>
                    {(l) =>
                      l === "…" ? (
                        <p class="peek-text muted">…</p>
                      ) : (
                        <p class={`peek-text peek-${l.kind}`} style={l.depth ? { "padding-left": `${l.depth * 18}px` } : undefined}>
                          <For each={pieces(l.text)}>{(x) => (x.on ? <mark>{x.t}</mark> : x.t)}</For>
                        </p>
                      )
                    }
                  </For>
                </article>
              )}
            </Show>
            </div>
          }
        >
          <div
            class="answer"
            onClick={(e) => {
              const t = (e.target as HTMLElement).closest<HTMLElement>("[data-title]");
              if (t?.dataset.title) void openCited(t.dataset.title);
            }}
          >
            <Show
              when={answer() !== "loading"}
              fallback={
                <Show when={partial()} fallback={<p class="ai-thinking">Claude is reading your notes…</p>}>
                  <div class="answer-text streaming" innerHTML={answerHtml(unsourced(partial()))} />
                </Show>
              }
            >
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
                    <Show when={moreLoading() && partial()}>
                      <p class="answer-q">{more()}</p>
                      <div class="answer-text streaming" innerHTML={answerHtml(unsourced(partial()))} />
                    </Show>
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
                    <Show when={a.usage}>
                      <p class="ai-usage">{usageLine(a.usage)}</p>
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
