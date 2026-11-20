// The quick picker (`petrel --picker`, Ctrl Shift Space): find a prompt, snippet or any note, fill its blanks, and Enter
// copies it and closes, so the paste goes where you were. Ctrl O opens it in Petrel instead. It lists the things
// to copy (collections set so with `t`); Tab or the scope bar narrows by collection or Pages, and typing finds pages
// too. It knows which app was in front: what you copied there before comes first ("3× here"), and any captured
// selection is shown as a pill so you see what fills `{{selection}}`. Alt ← → step through a card's versions.
//
// With text selected in that app, Ctrl J runs the highlighted prompt on it: the prompt and the selection are
// shown, Enter sends them to Claude, and Enter again pastes the result over the selection (Ctrl C only copies
// it). Nothing is sent until that Enter.

import { createEffect, createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { aiLive, api, errText, type CaptureContext, type NoteSummary } from "./api";
import { blanks, fill, parts, todayText } from "./blanks";
import { keepVersion, lastVersions } from "./collection/BlankFields";
import FillBlanks from "./collection/FillBlanks";
import { copyFilled } from "./collection/copyItem";
import { loadUsed, type Used } from "./collection/lastUsed";
import { copyBody } from "./collection/snippetText";
import { hasVersions, lastFirst, versionsOf, type Version } from "./collection/versions";
import { kindOf } from "./library/Card";
import { toCopy, topOf } from "./library/faces";
import Mark, { faces, hueClass, loadFaces } from "./library/Mark";
import { blankNames, codePreview, highlightParts, subOf } from "./library/preview";
import ReadNote from "./library/ReadNote";
import { fold } from "./palette/match";
import { applyPrefs, parsePrefs } from "./settings/prefs";
import { ago, folderName, KeyHints } from "./ui";
import { rest, whenOpened } from "./warm";

export default function Picker() {
  let input!: HTMLInputElement;
  let listEl: HTMLDivElement | undefined;
  const [q, setQ] = createSignal("");
  const [scope, setScope] = createSignal<string>("all");
  const [i, setI] = createSignal(0);
  const [filling, setFilling] = createSignal<{ item: NoteSummary; text: string; versionName?: string; initialBlank?: string } | null>(null);
  const [ctx, setCtx] = createSignal<CaptureContext | null>(null);
  const [selCleared, setSelCleared] = createSignal(false);
  const [here, setHere] = createSignal<Record<string, number>>({});
  const [used, setUsed] = createSignal<Used>({});
  /** Ctrl J: a prompt run on the selection. */
  const [run, setRun] = createSignal<{ item: NoteSummary; prompt: string; phase: "ready" | "running" | "done" | "error"; out: string } | null>(null);

  const selectionText = () => (selCleared() ? "" : (ctx()?.text ?? "").trim());

  const [data, { refetch }] = createResource(async () => {
    const s = await api();
    const [all, counts] = await Promise.all([s.listNotes({ limit: 2000 }), s.copyCounts()]);
    return { all: all.filter((n) => n.folder !== "inbox"), counts };
  });
  const [last] = createResource(lastVersions);
  // Words further down a long prompt or snippet: the engine searches the whole text, the list adds those.
  const [inText] = createResource(q, async (text) =>
    text.trim() ? new Set((await (await api()).searchNotes(text, 80).catch(() => [])).map((n) => n.id)) : new Set<number>(),
  );

  const copyScopes = createMemo(() => {
    const d = data();
    if (!d) return [] as string[];
    const seen = new Map<string, number>();
    for (const n of d.all) {
      const top = topOf(n.folder);
      if (top && toCopy(n.folder, faces())) seen.set(top, (seen.get(top) ?? 0) + (d.counts[n.path] ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([top]) => top);
  });

  const scopes = createMemo(() => [
    { id: "all", label: "All to copy" },
    ...copyScopes().map((top) => ({ id: `c:${top}`, label: folderName(top) })),
    { id: "pages", label: "Pages" },
  ]);

  const rows = createMemo(() => {
    const d = data();
    if (!d) return [];
    const words = fold(q()).split(/\s+/).filter(Boolean);
    const deep = inText.latest ?? new Set<number>();
    const h = here();
    const score = (n: NoteSummary) => {
      const t = fold(n.title);
      // What was copied with this app in front comes first; then the most copied anywhere.
      let s = (h[n.path] ?? 0) * 1000 + (d.counts[n.path] ?? 0);
      // Collections (folders) before loose notes: the picker is mostly for prompts and snippets.
      if (n.folder) s += 2;
      for (const w of words) s += t.startsWith(w) ? 30 : t.includes(w) ? 15 : 0;
      return s;
    };
    const hits = d.all
      .filter((n) => !words.length || deep.has(n.id) || words.every((w) => fold(n.title + " " + n.folder + " " + n.preview).includes(w)))
      .sort((a, b) => score(b) - score(a) || b.modifiedAt - a.modifiedAt);
    const sc = scope();
    if (sc === "pages") return hits.filter((n) => !toCopy(n.folder, faces())).slice(0, 40);
    if (sc.startsWith("c:")) {
      const top = sc.slice(2);
      return hits.filter((n) => topOf(n.folder) === top).slice(0, 40);
    }
    const copyable = hits.filter((n) => toCopy(n.folder, faces()));
    // Notes (pages) appear after copyable items once the user starts typing.
    const pages = words.length ? hits.filter((n) => !toCopy(n.folder, faces())).slice(0, 10) : [];
    return [...copyable.slice(0, 40), ...pages];
  });
  const isPage = (n: NoteSummary) => !toCopy(n.folder, faces());

  createEffect(() => {
    const len = rows().length;
    if (len > 0 && i() >= len) setI(len - 1);
  });

  const close = async () => {
    if (closed) return;
    closed = true;
    await (await api()).closePicker();
    rest();
  };
  let closed = false;
  const sel = () => rows()[i()];

  // The selected card's full text, for full-body preview and versions.
  const [body] = createResource(
    () => sel()?.id,
    async (id) => copyBody(await (await api()).peekNote(id)),
  );
  const versions = createMemo((): Version[] => {
    const n = sel();
    const b = body();
    return n && b !== undefined && hasVersions(n.folder, faces()) ? lastFirst(versionsOf(b), last()?.[n.path]) : [];
  });
  const [vi, setVi] = createSignal(0);
  const version = () => versions()[vi() % Math.max(1, versions().length)];
  const shown = () => version()?.text ?? body() ?? sel()?.preview ?? "";
  const shownBlanks = createMemo(() => {
    const n = sel();
    return n && !isPage(n) ? blanks(shown()) : [];
  });
  const isCodeSel = () => {
    const n = sel();
    return !!n && !isPage(n) && kindOf(n.folder) === "code";
  };

  /** Preview what a blank would resolve to before pressing Enter. */
  function peekBlankInfo(name: string): { text: string; kind: "unfilled" | "auto" } {
    const b = shownBlanks().find((x) => x.name === name);
    if (!b) return { text: name, kind: "unfilled" };
    if (b.auto === "today") return { text: todayText(), kind: "auto" };
    if (b.auto === "selection") {
      const s = selectionText();
      return s ? { text: s.length > 52 ? `${s.slice(0, 52)}…` : s, kind: "auto" } : { text: name, kind: "unfilled" };
    }
    if (b.value) return { text: b.value, kind: "auto" };
    return { text: name, kind: "unfilled" };
  }

  /** Ctrl Enter: after the copy, paste into the app in front too (Ctrl Shift Enter pastes with Ctrl Shift V). */
  let pasting: "" | "plain" | "shift" = "";

  async function copy(n: NoteSummary, text: string) {
    if (!(await copyFilled(n, text, ctx()?.app ?? null))) return;
    if (version()) void keepVersion(n.path, version()!.name);
    if (pasting) {
      const shift = pasting === "shift";
      pasting = "";
      closed = true;
      rest();
      // The picker is hidden by now, so a failure can only be logged; the text is on the clipboard either way.
      return void (await api()).pasteIntoFront(shift).catch((e) => console.warn("paste", e));
    }
    await close();
  }

  async function pick(n: NoteSummary | undefined, initialBlank?: string) {
    if (!n) return;
    const full = n.id === sel()?.id && body() !== undefined ? body()! : copyBody(await (await api()).peekNote(n.id));
    const v = n.id === sel()?.id ? version() : undefined;
    const text = v ? v.text : full;
    if (!isPage(n) && blanks(text).length) {
      return setFilling({ item: n, text, versionName: v?.name, initialBlank });
    }
    await copy(n, text);
  }

  /** The prompt with its own blanks filled by their defaults; the selection is the text it works on. */
  async function readyRun(n: NoteSummary | undefined) {
    if (!n) return;
    if (!selectionText()) return void setRun({ item: n, prompt: "", phase: "error", out: "Nothing was selected in the app you were in. Select some text there first, then open the picker." });
    const full = n.id === sel()?.id && body() !== undefined ? body()! : copyBody(await (await api()).peekNote(n.id));
    const prompt = fill(n.id === sel()?.id && version() ? version()!.text : full, { selection: "the text", text: "the text", clipboard: "" });
    setRun({ item: n, prompt, phase: "ready", out: "" });
  }

  async function go() {
    const r = run();
    if (!r || r.phase !== "ready") return;
    const s = await api();
    const st = await s.aiStatus().catch(() => null);
    if (!st?.ready) return void setRun({ ...r, phase: "error", out: "Claude needs your API key first: Settings › AI in Petrel." });
    setRun({ ...r, phase: "running" });
    try {
      const live = aiLive((soFar) => run()?.phase === "running" && setRun({ ...run()!, out: soFar }));
      const res = await s.aiWrite({ task: "prompt", text: selectionText(), instruction: r.prompt }, live);
      setRun({ ...run()!, phase: "done", out: res.text });
    } catch (e) {
      setRun({ ...run()!, phase: "error", out: errText(e) });
    }
  }

  /** Enter: paste over the selection; Ctrl C: copy only. Counted as a use of the prompt either way. */
  async function useResult(paste: boolean) {
    const r = run();
    if (r?.phase !== "done") return;
    pasting = paste ? "plain" : "";
    await copy(r.item, r.out);
  }

  const refocusInput = () => setTimeout(() => input?.focus());

  const runKey = (e: KeyboardEvent) => {
    const r = run()!;
    if (e.key === "Escape") (setRun(null), refocusInput());
    else if (e.key === "Enter" && r.phase === "ready") void go();
    else if (e.key === "Enter" && r.phase === "done") void useResult(true);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && r.phase === "done" && !getSelection()?.toString()) void useResult(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  // Prevent stationary mouse cursor from stealing keyboard selection during arrow navigation or scroll.
  let lastPointer = { x: -1, y: -1 };
  let kbLock = false;
  const scrollActive = () => queueMicrotask(() => listEl?.querySelector(".palette-row.on")?.scrollIntoView({ block: "nearest" }));

  const stepRow = (by: number) => {
    const n = rows().length;
    if (!n) return;
    kbLock = true;
    setI((i() + by + n) % n);
    setVi(0);
    scrollActive();
  };

  const stepScope = (back: boolean) => {
    const list = scopes();
    const cur = Math.max(0, list.findIndex((s) => s.id === scope()));
    const next = list[(cur + (back ? list.length - 1 : 1)) % list.length];
    setScope(next.id);
    setI(0);
    setVi(0);
  };

  const key = async (e: KeyboardEvent) => {
    if (e.ctrlKey && e.key.toLowerCase() === "j") {
      e.preventDefault();
      return void readyRun(rows()[i()]);
    }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) stepRow(1);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) stepRow(-1);
    else if (e.key === "Tab") stepScope(e.shiftKey);
    else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft") && versions().length > 1)
      setVi((vi() + (e.key === "ArrowLeft" ? versions().length - 1 : 1)) % versions().length);
    else if (e.key === "Enter") {
      pasting = e.ctrlKey ? (e.shiftKey ? "shift" : "plain") : "";
      void pick(rows()[i()]);
    } else if (e.ctrlKey && e.key.toLowerCase() === "o") {
      const r = rows()[i()];
      if (r) await (await api()).showNoteInMain(r.id);
      await close();
    } else if (e.key === "Escape") {
      if (q()) {
        setQ("");
        setI(0);
        setVi(0);
      } else if (scope() !== "all") {
        setScope("all");
        setI(0);
        setVi(0);
      } else {
        void close();
      }
    } else return;
    e.preventDefault();
  };

  onMount(async () => {
    window.addEventListener("keydown", (e) => run() && runKey(e), true);
    void loadFaces();
    await whenOpened(start);
  });

  /** The picker was asked for: the latest notes, the app in front, then show. */
  async function start() {
    setQ("");
    setScope("all");
    setI(0);
    setVi(0);
    setFilling(null);
    setRun(null);
    setSelCleared(false);
    input?.focus();
    const s = await api();
    void refetch();
    s.uiSettings().then((m) => applyPrefs(parsePrefs(m)), () => {});
    loadUsed().then(setUsed, () => {});
    await s.showWindow();
    // Losing focus means the person went back to what they were doing: get out of the way.
    window.addEventListener("blur", () => !filling() && run()?.phase !== "running" && setTimeout(() => !document.hasFocus() && void close(), 150));
    const c = await s.pickerContext().catch(() => null);
    setCtx(c);
    if (c?.app) setHere(await s.copyCountsIn(c.app).catch(() => ({})));
  }

  const renderHighlighted = (text: string) => (
    <For each={highlightParts(text, q())}>{(seg) => (seg.hit ? <mark class="read-mark">{seg.text}</mark> : seg.text)}</For>
  );

  const selectionSnippet = () => {
    const t = selectionText().replace(/\s+/g, " ");
    return t.length > 26 ? `${t.slice(0, 26)}…` : t;
  };

  return (
    <div class="picker">
      <Show when={run()}>
        {(r) => (
          <div class="picker-run" role="dialog" aria-label={`Run ${r().item.title} on the selection`}>
            <div class="run-head">
              <span class="row-label">{r().item.title}</span>
              <span class="muted small">on what you selected{ctx()?.app ? ` in ${ctx()!.app}` : ""}</span>
            </div>
            <Show when={r().phase === "ready"}>
              <p class="run-text run-prompt">{r().prompt}</p>
              <p class="run-text run-sel">{selectionText().slice(0, 1200)}</p>
            </Show>
            <Show when={r().phase !== "ready"}>
              <p class="run-text run-out" classList={{ bad: r().phase === "error", live: r().phase === "running" }} aria-live="polite">
                {r().out || "Claude is working on it…"}
              </p>
            </Show>
            <footer class="picker-foot">
              <Show when={r().phase === "ready"}>
                <KeyHints hints={[["Enter", "send to Claude"]]} />
              </Show>
              <Show when={r().phase === "done"}>
                <KeyHints hints={[["Enter", "paste over the selection"], ["Ctrl C", "copy only"]]} />
              </Show>
              <span class="grow" />
              <KeyHints hints={[["Esc", "back"]]} />
            </footer>
          </div>
        )}
      </Show>
      <Show
        when={!filling() && !run()}
        fallback={
          <Show when={filling()}>
            {(f) => (
              <FillBlanks
                inline
                title={f().item.title}
                folder={f().item.folder}
                versionName={f().versionName}
                text={f().text}
                selection={selectionText() || null}
                targetApp={ctx()?.app ?? null}
                initialBlank={f().initialBlank}
                onClearSelection={() => setSelCleared(true)}
                onClose={() => (setFilling(null), refocusInput())}
                onCopy={(text) => {
                  pasting = "";
                  void copy(f().item, text);
                }}
                onPaste={(text, shift) => {
                  pasting = shift ? "shift" : "plain";
                  void copy(f().item, text);
                }}
              />
            )}
          </Show>
        }
      >
        <div class="picker-top">
          <div class="palette-field">
            <span class="spark picker-glass">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </span>
            <input
              class="palette-input"
              ref={input}
              placeholder={ctx()?.app ? `Copy into ${ctx()!.app}: find a prompt, snippet or page…` : "Find a prompt, snippet or page to copy…"}
              value={q()}
              onInput={(e) => (setQ(e.currentTarget.value), setI(0), setVi(0))}
              onKeyDown={key}
            />
            <Show when={selectionText()}>
              <span class="picker-sel-pill" title={`Captured from ${ctx()?.app || "front app"} — fills {{selection}} automatically`}>
                <span class="picker-sel-dot" aria-hidden="true" />
                <span class="picker-sel-text">
                  <Show when={ctx()?.app}>
                    <b>{ctx()!.app}</b> ·{" "}
                  </Show>
                  “{selectionSnippet()}” ({selectionText().length}c)
                </span>
                <button
                  type="button"
                  class="picker-sel-x"
                  aria-label="Clear captured selection"
                  title="Clear captured selection"
                  onClick={() => (setSelCleared(true), refocusInput())}
                >
                  ×
                </button>
              </span>
            </Show>
          </div>
          <div class="picker-scopes" role="tablist" aria-label="Scope">
            <For each={scopes()}>
              {(sc) => (
                <button
                  type="button"
                  role="tab"
                  class="picker-scope"
                  aria-selected={scope() === sc.id}
                  classList={{ on: scope() === sc.id }}
                  onClick={() => (setScope(sc.id), setI(0), setVi(0), refocusInput())}
                >
                  {sc.label}
                </button>
              )}
            </For>
            <span class="grow" />
            <span class="picker-scope-hint">
              <kbd>Tab</kbd> scope
            </span>
          </div>
        </div>
        <div class="picker-body">
          <div class="palette-list" ref={listEl}>
            <For each={rows()}>
              {(n, k) => {
                const page = () => isPage(n);
                const bCount = () => (page() ? 0 : blankNames(n.preview).length);
                return (
                  <>
                    <Show when={scope() === "all" && page() && (k() === 0 || !isPage(rows()[k() - 1]))}>
                      <div class="picker-section">Pages</div>
                    </Show>
                    <button
                      type="button"
                      class={`palette-row picker-row ${hueClass(n.folder)}`}
                      classList={{ on: k() === i() }}
                      onPointerMove={(e) => {
                        const dx = Math.abs(e.clientX - lastPointer.x);
                        const dy = Math.abs(e.clientY - lastPointer.y);
                        if (kbLock && dx < 4 && dy < 4) return;
                        kbLock = false;
                        lastPointer = { x: e.clientX, y: e.clientY };
                        if (k() !== i()) (setI(k()), setVi(0));
                      }}
                      onClick={() => void pick(n)}
                    >
                      <span class="picker-row-mark">
                        <Mark folder={n.folder} size={12} />
                      </span>
                      <span class="row-two">
                        <span class="picker-row-title">
                          <span class="row-label">{renderHighlighted(n.folder === "inbox" ? n.preview.split("\n")[0] : n.title)}</span>
                          <Show when={bCount()}>
                            <span class="picker-pill">{bCount()} {bCount() === 1 ? "blank" : "blanks"}</span>
                          </Show>
                        </span>
                        <Show
                          when={used()[n.path]}
                          fallback={<span class="row-used">{page() ? `${folderName(n.folder)} · ${ago(n.modifiedAt)}` : folderName(n.folder)}</span>}
                        >
                          {(u) => (
                            <span class="row-used">
                              Used in {u()[0]} · {ago(u()[1])}
                            </span>
                          )}
                        </Show>
                      </span>
                      <Show when={here()[n.path]}>
                        <span class="row-here" title={`Copied ${here()[n.path]} times with ${ctx()?.app} in front`}>
                          {here()[n.path]}× here
                        </span>
                      </Show>
                      <Show when={!here()[n.path]}>
                        <span class="row-sub">{folderName(topOf(n.folder))}</span>
                      </Show>
                    </button>
                  </>
                );
              }}
            </For>
            <Show when={data() && !rows().length}>
              <p class="muted pad">
                {q()
                  ? "Nothing matches."
                  : scope() === "pages"
                    ? "No pages yet."
                    : "Nothing to copy yet. Make a folder like Prompts or Snippets, or set a collection to copy with t in the library."}
              </p>
            </Show>
          </div>
          <Show when={sel()}>
            {(n) => {
              const page = () => isPage(n());
              const code = () => isCodeSel();
              const sub = () => subOf(n().folder, topOf(n().folder));
              const cp = () => codePreview(shown());
              return (
                <div class={`picker-peek ${hueClass(n().folder)}`}>
                  <div class="picker-peek-head">
                    <div class="picker-peek-meta">
                      <span class="lcard-where">
                        <Mark folder={n().folder} size={12} />
                        {folderName(topOf(n().folder))}
                        <Show when={sub()}>
                          <span class="picker-peek-sub">/ {sub()}</span>
                        </Show>
                      </span>
                      <h2 class="picker-peek-title" classList={{ serif: page() }}>
                        {n().title}
                      </h2>
                    </div>
                    <button type="button" class="btn small primary" onClick={() => void pick(n())}>
                      {page() ? "Copy" : shownBlanks().length ? `Fill ${shownBlanks().length}` : "Copy"}
                    </button>
                  </div>
                  <Show when={versions().length > 1}>
                    <div class="versions" role="tablist" aria-label="Versions">
                      <For each={versions()}>
                        {(v, k) => (
                          <button
                            type="button"
                            role="tab"
                            class="chip small"
                            aria-selected={k() === vi() % versions().length}
                            classList={{ on: k() === vi() % versions().length }}
                            onClick={() => (setVi(k()), refocusInput())}
                          >
                            {v.name}
                          </button>
                        )}
                      </For>
                      <span class="muted small">
                        <kbd>Alt ←</kbd> <kbd>Alt →</kbd>
                      </span>
                    </div>
                  </Show>
                  <div class="picker-peek-body">
                    <Show
                      when={!page()}
                      fallback={<ReadNote compact body={shown()} folder={n().folder} highlight={q()} />}
                    >
                      <Show
                        when={code()}
                        fallback={
                          <div class="picker-peek-text">
                            <For each={parts(shown())}>
                              {(x) => {
                                if (!x.blank) return renderHighlighted(x.text);
                                const info = () => peekBlankInfo(x.text);
                                return (
                                  <button
                                    type="button"
                                    class={`blank-chip state-${info().kind}`}
                                    title={`Click to fill ${x.text}`}
                                    onClick={() => void pick(n(), x.text)}
                                  >
                                    {info().text}
                                  </button>
                                );
                              }}
                            </For>
                          </div>
                        }
                      >
                        <div class="picker-peek-code">
                          <Show when={cp().lang}>
                            <div class="picker-peek-lang">{cp().lang}</div>
                          </Show>
                          <pre>
                            <For each={parts(cp().text)}>
                              {(x) => {
                                if (!x.blank) return renderHighlighted(x.text);
                                const info = () => peekBlankInfo(x.text);
                                return (
                                  <button
                                    type="button"
                                    class={`blank-chip state-${info().kind}`}
                                    title={`Click to fill ${x.text}`}
                                    onClick={() => void pick(n(), x.text)}
                                  >
                                    {info().text}
                                  </button>
                                );
                              }}
                            </For>
                          </pre>
                        </div>
                      </Show>
                    </Show>
                  </div>
                </div>
              );
            }}
          </Show>
        </div>
        <footer class="picker-foot">
          <KeyHints
            hints={[
              ["Enter", shownBlanks().length ? "fill blanks" : "copy and close"],
              ["Ctrl Enter", ctx()?.app ? `paste into ${ctx()!.app}` : "paste it"],
              !!selectionText() && ["Ctrl J", "run on selection"],
              versions().length > 1 && ["Alt ← →", "version"],
              ["Ctrl O", "open in Petrel"],
            ]}
          />
          <span class="grow" />
          <KeyHints hints={[["Esc", q() || scope() !== "all" ? "clear" : "close"]]} />
        </footer>
      </Show>
    </div>
  );
}
