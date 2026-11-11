// A card, opened: the whole text on a sheet over the library. A prompt's blanks become fields on the right and
// the text fills in as you type; Enter copies. A capture from the inbox gets its filing buttons instead: Move to
// (m), Suggest a home (s, Claude, only when pressed) and Delete (d).

import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, errText, type AiSuggestion, type Note } from "../api";
import { blanks, fill, parts } from "../blanks";
import { copyFilled } from "../collection/copyItem";
import { ago, folderName, say, typing } from "../ui";
import { hueOf, kindOf, topOf } from "./Card";

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
}) {
  const [note] = createResource(
    () => p.id,
    async (id) => (await api()).peekNote(id),
  );
  const text = () => (note()?.body ?? "").replace(/\n+$/, "");
  const fields = () => blanks(text());
  const [values, setValues] = createSignal<Record<string, string>>({});
  const value = (name: string) => values()[name] ?? fields().find((b) => b.name === name)?.value ?? "";
  const filled = () => fill(text(), Object.fromEntries(fields().map((b) => [b.name, value(b.name)])));
  const inbox = () => note()?.folder === "inbox";
  const [sugg, setSugg] = createSignal<AiSuggestion[] | "loading" | null>(null);

  async function copy(markdown = false) {
    const n = note();
    if (!n) return;
    const out = markdown ? `# ${n.title}\n\n${filled()}` : filled();
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
    if (e.key === "Escape") p.onClose();
    else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement && !e.ctrlKey)) {
      const s = sugg();
      if (inbox() && Array.isArray(s) && s[0]) p.onFile(n, s[0]);
      else if (inbox()) p.onMove(n);
      else void copy();
    } else if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    else if (e.key === "e") p.onEdit(n.id);
    else if (e.key === "c") void copy();
    else if (inbox() && e.key === "m") p.onMove(n);
    else if (inbox() && e.key === "s") void suggest();
    else if (inbox() && (e.key === "d" || e.key === "Delete")) p.onDelete(n);
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
    <div class="scrim sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <Show when={note()}>
        {(n) => (
          <div class={`lsheet hue-${hueOf(n().folder)} kind-${kindOf(n().folder)}`} role="dialog" aria-label={n().title}>
            <div class="lsheet-main">
              <div class="lsheet-top">
                <span class="lcard-where">
                  <span class="dot" aria-hidden="true" />
                  {folderName(topOf(n().folder))}
                </span>
                <span class="muted small">
                  {p.copies ? `Copied ${p.copies} ${p.copies === 1 ? "time" : "times"} · ` : ""}edited {ago(n().modifiedAt)}
                </span>
              </div>
              <Show when={!inbox()}>
                <h1 class="lsheet-title">{n().title}</h1>
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
            <aside class="lsheet-side">
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
                  <For each={fields()}>
                    {(b, i) => (
                      <label class="side-field">
                        {b.name}
                        {/^(code|text|diff|commits|body|notes)$/i.test(b.name) ? (
                          <textarea
                            rows={3}
                            value={value(b.name)}
                            ref={(el) => i() === 0 && setTimeout(() => el.focus())}
                            onInput={(e) => setValues({ ...values(), [b.name]: e.currentTarget.value })}
                          />
                        ) : (
                          <input
                            value={value(b.name)}
                            ref={(el) => i() === 0 && setTimeout(() => el.focus())}
                            onInput={(e) => setValues({ ...values(), [b.name]: e.currentTarget.value })}
                          />
                        )}
                      </label>
                    )}
                  </For>
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
                  <span class="muted small center">{fields().length ? "Tab next blank · Esc back" : "Esc back"}</span>
                </div>
              </Show>
            </aside>
          </div>
        )}
      </Show>
    </div>
  );
}
