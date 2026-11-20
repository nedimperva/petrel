// A card, opened: the whole text on a sheet over the library (or inline in Split Sheet / Inbox). A prompt's blanks
// become fields on the right, linked bi-directionally to clickable chips in the preview; Enter copies. A prompt or
// snippet with `## versions` shows clickable tabs; Alt ← and Alt → step through them, and the one copied last comes
// first. A capture from the inbox gets its filing buttons instead: Suggest a home (s, Claude, only when pressed).

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type AiSuggestion, type Note } from "../api";
import { parts } from "../blanks";
import BlankFields, { createBlanks, keepVersion, lastVersions, type BlankKind } from "../collection/BlankFields";
import { copyFilled } from "../collection/copyItem";
import { copyBody } from "../collection/snippetText";
import { hasVersions, lastFirst, versionsOf } from "../collection/versions";
import { ago, folderName, say, typing } from "../ui";
import { kindOf, topOf } from "./Card";
import Mark, { faces, hueClass } from "./Mark";

export default function Sheet(p: {
  id: number;
  copies: number;
  aiReady: boolean;
  onClose(): void;
  onEdit(id: number): void;
  onMove(note: Note): void;
  onFile(note: Note, s: AiSuggestion): void;
  onDelete(note: Note): void;
  onAiSetup(): void;
  /** In the library's preview pane, always open: no scrim, Esc is the library's, the fields wait for a click. */
  inline?: boolean;
  /** True while multi-selection mode is active in the parent list, so batch keys win over single-item keys. */
  disabled?: boolean;
  onCopied?: () => void;
}) {
  // Signals, not createResource: avoids triggering App's top-level <Suspense> when switching items in Split view.
  const [note, setNote] = createSignal<Note | null>(null);
  const [last, setLast] = createSignal<Record<string, string>>({});
  const [vi, setVi] = createSignal(0);
  const [activeBlank, setActiveBlank] = createSignal<string | null>(null);
  const [sugg, setSugg] = createSignal<AiSuggestion[] | "loading" | null>(null);

  onMount(() => void lastVersions().then(setLast, () => {}));
  createEffect(
    on(
      () => p.id,
      (id) => {
        setVi(0);
        setActiveBlank(null);
        setSugg(null);
        void api()
          .then((s) => s.peekNote(id))
          .then((n) => {
            if (p.id === id) setNote(n);
          })
          .catch(() => {});
      },
    ),
  );

  const body = () => {
    const n = note();
    return n ? copyBody(n) : "";
  };
  const versions = createMemo(() => {
    const n = note();
    return n && hasVersions(n.folder, faces()) ? lastFirst(versionsOf(body()), last()[n.path]) : [];
  });
  const version = () => versions()[vi() % Math.max(1, versions().length)];
  const text = () => version()?.text ?? body();
  const state = createBlanks(text);
  const fields = state.list;
  const blankOf = (name: string) => fields().find((x) => x.name === name);
  const value = (name: string) => {
    const b = blankOf(name);
    return b ? state.value(b) : "";
  };
  const kind = (name: string): BlankKind => {
    const b = blankOf(name);
    return b ? state.kind(b) : "unfilled";
  };
  const filled = state.out;
  const inbox = () => note()?.folder === "inbox";
  let side: HTMLElement | undefined;

  const focusBlank = (name: string) => {
    setActiveBlank(name);
    const el = side?.querySelector<HTMLElement>(`[data-blank-input="${CSS.escape(name)}"]`);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };

  /** Alt ← and Alt →: the version before or after, its first blank in focus. */
  function step(back: boolean) {
    const n = versions().length;
    setVi((vi() + (back ? n - 1 : 1)) % n);
    setTimeout(() => side?.querySelector<HTMLElement>("input, textarea, .choices")?.focus());
  }

  async function copy(mode: "plain" | "markdown" | "raw" = "plain") {
    const n = note();
    if (!n) return;
    const out = mode === "raw" ? text() : mode === "markdown" ? `# ${n.title}\n\n${filled()}` : filled();
    if (mode !== "raw") void state.keep();
    if (version()) void keepVersion(n.path, version()!.name);
    if (await copyFilled(n, out)) {
      p.onCopied?.();
      p.onClose();
    }
  }

  async function suggest() {
    const n = note();
    if (!n) return;
    if (!p.aiReady) return p.onAiSetup();
    setSugg("loading");
    try {
      setSugg(await (await api()).aiSuggestHome(n.id));
    } catch (e) {
      setSugg(null);
      say(errText(e), { error: true });
    }
  }

  const key = (e: KeyboardEvent) => {
    const n = note();
    if (!n || p.disabled) return;
    // In inline mode, let overlays (Destination, FacePicker) own keyboard events.
    if (p.inline && document.querySelector(".scrim")) return;
    if (e.key === "Escape") {
      if (p.inline) return;
      p.onClose();
    } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && versions().length > 1) step(e.key === "ArrowLeft");
    else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement && !e.ctrlKey)) {
      if (p.inline && typing(e) && !side?.contains(e.target as Node)) return;
      const s = sugg();
      if (inbox() && Array.isArray(s) && s[0]) p.onFile(n, s[0]);
      else if (inbox()) p.onMove(n);
      else void copy("plain");
    } else if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    else if (e.key === "e") p.onEdit(n.id);
    else if (e.key === "c") void copy("plain");
    else if (e.key === "m") p.onMove(n);
    else if (inbox() && e.key === "s") void suggest();
    else if (e.key === "d" || e.key === "Delete") p.onDelete(n);
    else if (inbox() && /^[123]$/.test(e.key) && Array.isArray(sugg()) && (sugg() as AiSuggestion[])[Number(e.key) - 1])
      p.onFile(n, (sugg() as AiSuggestion[])[Number(e.key) - 1]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => document.addEventListener("keydown", key, true));
  onCleanup(() => document.removeEventListener("keydown", key, true));

  const shown = () => parts(text());

  return (
    <div class={p.inline ? "sheet-inline" : "scrim sheet-scrim"} onMouseDown={(e) => !p.inline && e.target === e.currentTarget && p.onClose()}>
      <Show when={note()}>
        {(n) => (
          <div class={`lsheet ${hueClass(n().folder)} kind-${kindOf(n().folder)}`} role={p.inline ? "region" : "dialog"} aria-label={n().title}>
            <div class="lsheet-main">
              <div class="lsheet-top">
                <span class="lcard-where">
                  <Mark folder={n().folder} size={12} />
                  {folderName(topOf(n().folder))}
                </span>
                <span class="muted small">
                  {p.copies ? `Copied ${p.copies} ${p.copies === 1 ? "time" : "times"} · ` : ""}edited {ago(n().modifiedAt)}
                </span>
              </div>
              <Show when={!inbox()}>
                <h1 class="lsheet-title">{n().title}</h1>
              </Show>
              <Show when={versions().length > 1}>
                <div class="versions" role="tablist" aria-label="Versions">
                  <For each={versions()}>
                    {(v, i) => (
                      <button type="button" role="tab" class="chip" aria-selected={i() === vi()} classList={{ on: i() === vi() }} onClick={() => setVi(i())}>
                        {v.name}
                      </button>
                    )}
                  </For>
                  <span class="muted small">
                    <kbd>Alt ←</kbd> <kbd>Alt →</kbd> other versions
                  </span>
                </div>
              </Show>
              <div class="lsheet-text">
                <For each={shown()}>
                  {(x) => {
                    if (!x.blank) return x.text;
                    const k = () => kind(x.text);
                    const v = () => value(x.text);
                    return (
                      <button
                        type="button"
                        class={`blank-chip state-${k()}`}
                        classList={{ filled: k() !== "unfilled", active: activeBlank() === x.text }}
                        title={`Click to edit ${x.text}`}
                        onClick={() => focusBlank(x.text)}
                        onMouseEnter={() => setActiveBlank(x.text)}
                      >
                        {v() || x.text}
                      </button>
                    );
                  }}
                </For>
              </div>
              <Show when={fields().length && !inbox()}>
                <div class="fill-legend">
                  <span>Click any chip to focus its field.</span>
                  <span class="blank-legend-dots">
                    <span><i class="bdot empty" /> empty</span>
                    <span><i class="bdot auto" /> auto / default</span>
                    <span><i class="bdot typed" /> typed</span>
                  </span>
                </div>
              </Show>
            </div>
            <aside class="lsheet-side" ref={side}>
              <Show
                when={!inbox()}
                fallback={
                  <>
                    <div class="side-head">File it</div>
                    <Show when={sugg() === "loading"}>
                      <p class="ai-thinking">Claude is looking at your collections…</p>
                    </Show>
                    <Show when={Array.isArray(sugg()) && sugg()}>
                      {(list) => (
                        <div class="sugg">
                          <For each={list() as AiSuggestion[]}>
                            {(s, i) => (
                              <button type="button" class="sugg-row" onClick={() => p.onFile(n(), s)}>
                                <span class="sugg-key">{i() + 1}</span>
                                <span class="sugg-what">{s.kind === "merge" ? `Add to ${s.title}` : `New note in ${folderName(s.folder)}`}</span>
                                <span class="sugg-why">{s.why}</span>
                              </button>
                            )}
                          </For>
                        </div>
                      )}
                    </Show>
                    <div class="side-actions">
                      <button type="button" class="btn primary wide" onClick={() => p.onMove(n())}>
                        Move to… <kbd>m</kbd>
                      </button>
                      <button type="button" class="btn wide" onClick={suggest}>
                        <span class="spark">✦</span> Suggest a home <kbd>s</kbd>
                      </button>
                      <button type="button" class="btn wide" onClick={() => p.onEdit(n().id)}>
                        Edit <kbd>e</kbd>
                      </button>
                      <button type="button" class="btn wide" onClick={() => p.onDelete(n())}>
                        Delete <kbd>d</kbd>
                      </button>
                    </div>
                  </>
                }
              >
                <Show when={fields().length}>
                  <div class="side-head">Fill in ({fields().length})</div>
                  <BlankFields state={state} side focusFirst={!p.inline} activeBlank={activeBlank()} onActiveBlank={setActiveBlank} />
                </Show>
                <div class="side-actions">
                  <button type="button" class="btn primary wide big" onClick={() => void copy("plain")}>
                    Copy <kbd>Enter</kbd>
                  </button>
                  <div class="side-actions-row">
                    <button type="button" class="btn wide" onClick={() => void copy("markdown")}>
                      As Markdown
                    </button>
                    <Show when={fields().length}>
                      <button type="button" class="btn wide" onClick={() => void copy("raw")}>
                        Raw template
                      </button>
                    </Show>
                  </div>
                  <button type="button" class="btn wide" onClick={() => p.onEdit(n().id)}>
                    Edit <kbd>e</kbd>
                  </button>
                  <button type="button" class="btn wide" onClick={() => p.onMove(n())}>
                    Move to… <kbd>m</kbd>
                  </button>
                  <button type="button" class="btn wide" onClick={() => p.onDelete(n())}>
                    Delete <kbd>d</kbd>
                  </button>
                  <span class="muted small center">{fields().length ? "Tab next blank · ↑ earlier answers · Esc back" : "Esc back"}</span>
                </div>
              </Show>
            </aside>
          </div>
        )}
      </Show>
    </div>
  );
}
