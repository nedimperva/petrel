// The quick picker (`petrel --picker`, Ctrl Alt V): find a prompt, snippet or any note, fill its blanks, and Enter
// copies it and closes, so the paste goes where you were. Ctrl O opens it in Petrel instead. It lists the things
// to copy (collections set so with `t`); once you type, the notes that match come after them. It knows which app
// was in front: what you copied there before comes first ("3× here"). Alt ← → step through a card's versions.

import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { api, type CaptureContext, type NoteSummary } from "./api";
import { blanks, parts } from "./blanks";
import { keepVersion, lastVersions } from "./collection/BlankFields";
import FillBlanks from "./collection/FillBlanks";
import { copyFilled } from "./collection/copyItem";
import { hasVersions, lastFirst, versionsOf, type Version } from "./collection/versions";
import { applyPrefs, parsePrefs } from "./settings/prefs";
import { folderName, KeyHints } from "./ui";
import { faces, loadFaces } from "./library/Mark";
import { toCopy } from "./library/faces";

export default function Picker() {
  let input!: HTMLInputElement;
  const [q, setQ] = createSignal("");
  const [i, setI] = createSignal(0);
  const [filling, setFilling] = createSignal<{ item: NoteSummary; text: string } | null>(null);
  const [ctx, setCtx] = createSignal<CaptureContext | null>(null);
  const [here, setHere] = createSignal<Record<string, number>>({});
  const [data] = createResource(async () => {
    const s = await api();
    const [all, counts] = await Promise.all([s.listNotes({ limit: 2000 }), s.copyCounts()]);
    return { all: all.filter((n) => n.folder !== "inbox"), counts };
  });
  const [last] = createResource(lastVersions);

  const rows = () => {
    const d = data();
    if (!d) return [];
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    const h = here();
    const score = (n: NoteSummary) => {
      const t = n.title.toLowerCase();
      // What was copied with this app in front comes first; then the most copied anywhere.
      let s = (h[n.path] ?? 0) * 1000 + (d.counts[n.path] ?? 0);
      // Collections (folders) before loose notes: the picker is mostly for prompts and snippets.
      if (n.folder) s += 2;
      for (const w of words) s += t.startsWith(w) ? 30 : t.includes(w) ? 15 : 0;
      return s;
    };
    const hits = d.all
      .filter((n) => words.every((w) => (n.title + " " + n.folder + " " + n.preview).toLowerCase().includes(w)))
      .sort((a, b) => score(b) - score(a) || b.modifiedAt - a.modifiedAt);
    const copyable = hits.filter((n) => toCopy(n.folder, faces()));
    // Notes (pages) only when asked for by name: the list is for what you copy.
    const pages = words.length ? hits.filter((n) => !toCopy(n.folder, faces())).slice(0, 8) : [];
    return [...copyable.slice(0, 40), ...pages];
  };
  const isPage = (n: NoteSummary) => !toCopy(n.folder, faces());

  const close = async () => (await api()).closePicker();
  const sel = () => rows()[i()];

  // The selected card's full text, for its versions.
  const [body] = createResource(
    () => sel()?.id,
    async (id) => (await (await api()).peekNote(id)).body.replace(/\n+$/, ""),
  );
  const versions = createMemo((): Version[] => {
    const n = sel();
    const b = body();
    return n && b !== undefined && hasVersions(n.folder) ? lastFirst(versionsOf(b), last()?.[n.path]) : [];
  });
  const [vi, setVi] = createSignal(0);
  const version = () => versions()[vi() % Math.max(1, versions().length)];

  async function copy(n: NoteSummary, text: string) {
    if (!(await copyFilled(n, text, ctx()?.app ?? null))) return;
    if (version()) void keepVersion(n.path, version()!.name);
    await close();
  }

  async function pick(n: NoteSummary | undefined) {
    if (!n) return;
    const full = n.id === sel()?.id && body() !== undefined ? body()! : (await (await api()).peekNote(n.id)).body.replace(/\n+$/, "");
    const text = n.id === sel()?.id && version() ? version()!.text : full;
    if (blanks(text).length) return setFilling({ item: n, text });
    await copy(n, text);
  }

  const key = async (e: KeyboardEvent) => {
    const n = rows().length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) (setI((i() + 1) % Math.max(1, n)), setVi(0));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) (setI((i() + n - 1) % Math.max(1, n)), setVi(0));
    else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft") && versions().length > 1)
      setVi((vi() + (e.key === "ArrowLeft" ? versions().length - 1 : 1)) % versions().length);
    else if (e.key === "Enter") void pick(rows()[i()]);
    else if (e.ctrlKey && e.key.toLowerCase() === "o") {
      const r = rows()[i()];
      if (r) await (await api()).showNoteInMain(r.id);
      await close();
    } else if (e.key === "Escape") void close();
    else return;
    e.preventDefault();
  };

  onMount(async () => {
    input?.focus();
    void loadFaces();
    const s = await api();
    s.uiSettings().then((m) => applyPrefs(parsePrefs(m)), () => {});
    await s.showWindow();
    // Losing focus means the person went back to what they were doing: get out of the way.
    window.addEventListener("blur", () => !filling() && setTimeout(() => !document.hasFocus() && void close(), 150));
    const c = await s.pickerContext().catch(() => null);
    setCtx(c);
    if (c?.app) setHere(await s.copyCountsIn(c.app).catch(() => ({})));
  });

  const shown = () => version()?.text ?? sel()?.preview ?? "";

  return (
    <div class="picker">
      <Show
        when={!filling()}
        fallback={
          <FillBlanks
            inline
            title={filling()!.item.title}
            text={filling()!.text}
            selection={ctx()?.text}
            onClose={() => setFilling(null)}
            onCopy={(text) => void copy(filling()!.item, text)}
          />
        }
      >
        <div class="palette-field">
          <span class="spark">⌕</span>
          <input
            class="palette-input"
            ref={input}
            placeholder={ctx()?.app ? `Find a prompt, snippet or note to copy into ${ctx()!.app}…` : "Find a prompt, snippet or note to copy…"}
            value={q()}
            onInput={(e) => (setQ(e.currentTarget.value), setI(0), setVi(0))}
            onKeyDown={key}
          />
        </div>
        <div class="picker-body">
          <div class="palette-list">
            <For each={rows()}>
              {(n, k) => (
                <>
                <Show when={isPage(n) && (k() === 0 || !isPage(rows()[k() - 1]))}>
                  <div class="picker-section">Notes</div>
                </Show>
                <button class="palette-row" classList={{ on: k() === i() }} onMouseMove={() => k() !== i() && (setI(k()), setVi(0))} onClick={() => pick(n)}>
                  <span class="row-label">{n.folder === "inbox" ? n.preview.split("\n")[0] : n.title}</span>
                  <Show when={here()[n.path]}>
                    <span class="row-here" title={`Copied ${here()[n.path]} times with ${ctx()?.app} in front`}>
                      {here()[n.path]}× here
                    </span>
                  </Show>
                  <span class="row-sub">{folderName(n.folder)}</span>
                </button>
                </>
              )}
            </For>
            <Show when={data() && !rows().length}>
              <p class="muted pad">{q() ? "Nothing matches." : "Nothing to copy yet. Make a folder like Prompts or Snippets, or set a collection to copy with t in the library."}</p>
            </Show>
          </div>
          <Show when={sel()}>
            <div class="picker-peek">
              <Show when={versions().length > 1}>
                <div class="versions">
                  <For each={versions()}>{(v, k) => <span class="chip small" classList={{ on: k() === vi() }}>{v.name}</span>}</For>
                </div>
              </Show>
              <p class="card-text">
                <For each={parts(shown())}>{(x) => (x.blank ? <span class="chip blank">{x.text}</span> : x.text)}</For>
              </p>
            </div>
          </Show>
        </div>
        <footer class="picker-foot">
          <KeyHints hints={[["Enter", "copy and close"], versions().length > 1 && ["Alt ← →", "version"], ["Ctrl O", "open in Petrel"]]} />
          <span class="grow" />
          <KeyHints hints={[["Esc", "close"]]} />
        </footer>
      </Show>
    </div>
  );
}
