// Inline Copy Card & 1-Click Inbox Triage Pane: sits directly beside the workspace list with zero modals.
// - To copy (Prompts, Snippets): `{{blanks}}` are editable right inside the text (InlineTemplate); Tab steps
//   between blanks, Alt ←/→ switches versions, Enter copies with hue flash, e opens the live editor in place.
// - Inbox: shows the capture with a 1-Click Filing Bar underneath (learned top places 1–5, ✦ Suggest home,
//   Later, Move…, Edit, Delete). Filing or deleting advances cleanly to the next capture.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type AiSuggestion, type Note } from "../api";
import { createBlanks, keepVersion, lastVersions } from "../collection/BlankFields";
import InlineTemplate from "../collection/InlineTemplate";
import { copyFilled } from "../collection/copyItem";
import { copyBody } from "../collection/snippetText";
import { hasVersions, lastFirst, versionsOf } from "../collection/versions";
import { placeRows, type Row, type Target } from "../inbox/Destination";
import { filedCounts } from "../inbox/file";
import { ago, folderName, say, typing } from "../ui";
import { kindOf, topOf } from "./Card";
import Mark, { faces, hueClass } from "./Mark";
import { codePreview } from "./preview";

const QUICK_PLACES = 5;

export default function Sheet(p: {
  id: number;
  copies: number;
  aiReady: boolean;
  onClose(): void;
  onEdit(id: number): void;
  onMove(note: Note): void;
  onFileTarget?(note: Note, t: Target): void;
  onFile(note: Note, s: AiSuggestion): void;
  onLater?(note: Note): void;
  onDelete(note: Note): void;
  onAiSetup(): void;
  inline?: boolean;
  disabled?: boolean;
  onCopied?: () => void;
}) {
  const [note, setNote] = createSignal<Note | null>(null);
  const [last, setLast] = createSignal<Record<string, string>>({});
  const [vi, setVi] = createSignal(0);
  const [sugg, setSugg] = createSignal<AiSuggestion[] | "loading" | null>(null);
  const [places, setPlaces] = createSignal<Row[]>([]);
  const [flashed, setFlashed] = createSignal(false);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let hostEl: HTMLDivElement | undefined;

  onMount(() => void lastVersions().then(setLast, () => {}));

  async function loadPlaces(excludeId: number) {
    const s = await api();
    const [folders, recent, used] = await Promise.all([s.noteFolders(), s.listNotes({ limit: 8 }), filedCounts()]);
    const fs = folders.map((f) => f.path).filter((f) => f !== "inbox" && !f.startsWith("."));
    setPlaces(
      placeRows("", fs, recent.filter((n) => n.folder !== "inbox" && n.id !== excludeId), used, "").slice(0, QUICK_PLACES),
    );
  }

  createEffect(
    on(
      () => p.id,
      (id) => {
        setVi(0);
        setSugg(null);
        void api()
          .then((s) => s.peekNote(id))
          .then((n) => {
            if (p.id !== id) return;
            setNote(n);
            if (n.folder === "inbox") void loadPlaces(n.id);
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
  const filled = state.out;
  const inbox = () => note()?.folder === "inbox";
  const isCode = () => {
    const n = note();
    return !!n && !inbox() && kindOf(n.folder) === "code";
  };
  const cp = () => codePreview(text());

  function stepVersion(back: boolean) {
    const n = versions().length;
    setVi((vi() + (back ? n - 1 : 1)) % n);
  }

  async function copy(mode: "plain" | "markdown" | "raw" = "plain") {
    const n = note();
    if (!n) return;
    const out = mode === "raw" ? text() : mode === "markdown" ? `# ${n.title}\n\n${filled()}` : filled();
    if (mode !== "raw") void state.keep();
    if (version()) void keepVersion(n.path, version()!.name);
    if (await copyFilled(n, out)) {
      setFlashed(true);
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => setFlashed(false), 900);
      p.onCopied?.();
      if (!p.inline) p.onClose();
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
    if (p.inline && document.querySelector(".scrim")) return;
    if (e.key === "Escape") {
      if (p.inline) return;
      p.onClose();
    } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && versions().length > 1) {
      stepVersion(e.key === "ArrowLeft");
    } else if (e.key === "Enter" && !typing(e) && !e.ctrlKey && !e.metaKey) {
      const s = sugg();
      if (inbox() && Array.isArray(s) && s[0]) p.onFile(n, s[0]);
      else if (inbox()) p.onMove(n);
      else void copy("plain");
    } else if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) {
      return;
    } else if (e.key === "Tab" && !inbox() && fields().length) {
      const first = hostEl?.querySelector<HTMLElement>("[data-inline-blank]");
      if (first) {
        first.focus();
        if (first instanceof HTMLInputElement) first.select();
      } else return;
    } else if (e.key === "e") p.onEdit(n.id);
    else if (e.key === "c" && !inbox()) void copy("plain");
    else if (e.key === "m") p.onMove(n);
    else if (inbox() && e.key === "s") void suggest();
    else if (inbox() && e.key === "l" && p.onLater) p.onLater(n);
    else if (e.key === "d" || e.key === "Delete") p.onDelete(n);
    else if (inbox() && /^[1-5]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      const sg = sugg();
      if (Array.isArray(sg) && sg[idx]) p.onFile(n, sg[idx]);
      else if (!Array.isArray(sg) && places()[idx] && p.onFileTarget) p.onFileTarget(n, places()[idx].t);
      else return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => document.addEventListener("keydown", key, true));
  onCleanup(() => {
    clearTimeout(flashTimer);
    document.removeEventListener("keydown", key, true);
  });

  return (
    <div class={p.inline ? "sheet-inline" : "scrim sheet-scrim"} onMouseDown={(e) => !p.inline && e.target === e.currentTarget && p.onClose()}>
      <Show when={note()}>
        {(n) => (
          <div
            ref={hostEl}
            class={`lsheet direct-sheet ${hueClass(n().folder)} kind-${kindOf(n().folder)}`}
            classList={{ flash: flashed() }}
            role={p.inline ? "region" : "dialog"}
            aria-label={n().title}
          >
            <div class="direct-sheet-body">
              <header class="direct-sheet-head">
                <div class="direct-sheet-title-wrap">
                  <span class="lcard-where">
                    <Mark folder={n().folder} size={12} />
                    {folderName(topOf(n().folder))}
                    <span class="muted small">
                      · {p.copies ? `copied ${p.copies}× · ` : ""}edited {ago(n().modifiedAt)}
                    </span>
                  </span>
                  <Show when={!inbox()}>
                    <h1 class="lsheet-title">{n().title}</h1>
                  </Show>
                </div>
                <div class="direct-sheet-head-acts">
                  <button type="button" class="btn small" onClick={() => p.onEdit(n().id)} title="Edit as a note (e)">
                    Edit <kbd>e</kbd>
                  </button>
                  <Show when={!inbox()}>
                    <button type="button" class="btn small" onClick={() => p.onMove(n())} title="Move to… (m)">
                      Move
                    </button>
                    <button type="button" class="btn small" onClick={() => p.onDelete(n())} title="Delete (d)">
                      Delete
                    </button>
                  </Show>
                </div>
              </header>

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
                    <kbd>Alt ←</kbd> <kbd>Alt →</kbd>
                  </span>
                </div>
              </Show>

              <div class="direct-sheet-content">
                <Show
                  when={!inbox()}
                  fallback={<div class="inbox-capture-text">{n().body.trim() || "(empty capture)"}</div>}
                >
                  <div class="direct-copy-card" classList={{ code: isCode(), flash: flashed() }}>
                    <Show when={isCode() && cp().lang}>
                      <div class="picker-peek-lang">{cp().lang}</div>
                    </Show>
                    <InlineTemplate
                      text={isCode() ? cp().text : text()}
                      state={state}
                      code={isCode()}
                      onSubmit={() => void copy("plain")}
                    />
                  </div>
                  <Show when={fields().length}>
                    <p class="muted small">Click any blank or press <kbd>Tab</kbd> to edit inline · <kbd>↑</kbd> earlier answers · <kbd>Enter</kbd> copies</p>
                  </Show>
                </Show>
              </div>
            </div>

            {/* Bottom 1-Click Action Bar (Zero modals!) */}
            <footer class="direct-sheet-bar">
              <Show
                when={inbox()}
                fallback={
                  <div class="direct-copy-actions">
                    <button type="button" class="btn primary" onClick={() => void copy("plain")}>
                      {flashed() ? "Copied ✓" : "Copy"} <kbd>↵</kbd>
                    </button>
                    <button type="button" class="btn" onClick={() => void copy("markdown")}>
                      As Markdown
                    </button>
                    <Show when={fields().length}>
                      <button type="button" class="btn" onClick={() => void copy("raw")}>
                        Raw
                      </button>
                    </Show>
                  </div>
                }
              >
                <div class="inbox-triage-bar">
                  <Show when={sugg() === "loading"}>
                    <p class="ai-thinking small">Claude is looking at your collections…</p>
                  </Show>
                  <Show when={Array.isArray(sugg()) && sugg()}>
                    {(list) => (
                      <div class="triage-sugg">
                        <span class="spark">✦</span>
                        <For each={list() as AiSuggestion[]}>
                          {(s, idx) => (
                            <button type="button" class="btn small ai" onClick={() => p.onFile(n(), s)} title={s.why}>
                              <kbd>{idx() + 1}</kbd> {s.kind === "merge" ? `Add to ${s.title}` : folderName(s.folder)}
                            </button>
                          )}
                        </For>
                      </div>
                    )}
                  </Show>
                  <div class="triage-row">
                    <span class="muted small">File to</span>
                    <For each={places()}>
                      {(r, idx) => (
                        <button
                          type="button"
                          class="btn small"
                          onClick={() => (p.onFileTarget ? p.onFileTarget(n(), r.t) : p.onMove(n()))}
                        >
                          <kbd>{idx() + 1}</kbd>
                          <Mark folder={r.folder} size={11} />
                          {r.label}
                        </button>
                      )}
                    </For>
                    <button type="button" class="btn small" onClick={() => p.onMove(n())}>
                      More… <kbd>m</kbd>
                    </button>
                    <span class="grow" />
                    <button type="button" class="btn small ai" onClick={suggest}>
                      <span class="spark">✦</span> Suggest <kbd>s</kbd>
                    </button>
                    <Show when={p.onLater}>
                      <button type="button" class="btn small" onClick={() => p.onLater?.(n())} title="Keep for tomorrow (l)">
                        Later <kbd>l</kbd>
                      </button>
                    </Show>
                    <button type="button" class="btn small" onClick={() => p.onDelete(n())}>
                      Delete <kbd>d</kbd>
                    </button>
                  </div>
                </div>
              </Show>
            </footer>
          </div>
        )}
      </Show>
    </div>
  );
}
