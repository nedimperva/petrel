// A card, opened: the whole text on a sheet over the library. A prompt's blanks become fields on the right and
// the text fills in as you type; Enter copies. A prompt or snippet with `## versions` shows one at a time: Alt ←
// and Alt → step through them, and the one copied last comes first. A capture from the inbox gets
// its filing buttons instead: Suggest a home (s, Claude, only when pressed). Move to (m) and Delete (d) work on any card.

import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type AiSuggestion, type Note } from "../api";
import { parts } from "../blanks";
import BlankFields, { createBlanks, keepVersion, lastVersions } from "../collection/BlankFields";
import { copyFilled } from "../collection/copyItem";
import { hasVersions, lastFirst, versionsOf } from "../collection/versions";
import { ago, folderName, say, typing } from "../ui";
import { kindOf, topOf } from "./Card";
import Mark, { hueClass } from "./Mark";

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
}) {
  const [note] = createResource(
    () => p.id,
    async (id) => (await api()).peekNote(id),
  );
  const body = () => (note()?.body ?? "").replace(/\n+$/, "");
  const [last] = createResource(lastVersions);
  const versions = createMemo(() => {
    const n = note();
    return n && hasVersions(n.folder) ? lastFirst(versionsOf(body()), last()?.[n.path]) : [];
  });
  const [vi, setVi] = createSignal(0);
  const version = () => versions()[vi() % Math.max(1, versions().length)];
  const text = () => version()?.text ?? body();
  const state = createBlanks(text);
  const fields = state.list;
  const value = (name: string) => {
    const b = fields().find((x) => x.name === name);
    return b ? state.value(b) : "";
  };
  const filled = state.out;
  const inbox = () => note()?.folder === "inbox";
  let side: HTMLElement | undefined;

  /** Alt ← and Alt →: the version before or after, its first blank in focus. */
  function step(back: boolean) {
    const n = versions().length;
    setVi((vi() + (back ? n - 1 : 1)) % n);
    setTimeout(() => side?.querySelector<HTMLElement>("input, textarea, .choices")?.focus());
  }
  const [sugg, setSugg] = createSignal<AiSuggestion[] | "loading" | null>(null);

  async function copy(markdown = false) {
    const n = note();
    if (!n) return;
    const out = markdown ? `# ${n.title}\n\n${filled()}` : filled();
    void state.keep();
    if (version()) void keepVersion(n.path, version()!.name);
    if (await copyFilled(n, out)) p.onClose();
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
    if (!n) return;
    if (e.key === "Escape") {
      if (p.inline) return;
      p.onClose();
    } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && versions().length > 1) step(e.key === "ArrowLeft");
    else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement && !e.ctrlKey)) {
      const s = sugg();
      if (inbox() && Array.isArray(s) && s[0]) p.onFile(n, s[0]);
      else if (inbox()) p.onMove(n);
      else void copy();
    } else if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    else if (e.key === "e") p.onEdit(n.id);
    else if (e.key === "c") void copy();
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
                  {(x) =>
                    x.blank ? (
                      <span class="blank-chip" classList={{ filled: !!value(x.text) }}>
                        {value(x.text) || x.text}
                      </span>
                    ) : (
                      x.text
                    )
                  }
                </For>
              </div>
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
                  <div class="side-head">Fill in</div>
                  <BlankFields state={state} side focusFirst={!p.inline} />
                </Show>
                <div class="side-actions">
                  <button type="button" class="btn primary wide big" onClick={() => copy()}>
                    Copy <kbd>Enter</kbd>
                  </button>
                  <button type="button" class="btn wide" onClick={() => copy(true)}>
                    Copy as Markdown
                  </button>
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
