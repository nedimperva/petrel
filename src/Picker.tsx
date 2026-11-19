// The quick picker (`petrel --picker`, Ctrl Shift Space): find a prompt, snippet or any note, fill its blanks, and Enter
// copies it and closes, so the paste goes where you were. Ctrl O opens it in Petrel instead. It lists the things
// to copy (collections set so with `t`); once you type, the notes that match come after them. It knows which app
// was in front: what you copied there before comes first ("3× here"). Alt ← → step through a card's versions.
//
// With text selected in that app, Ctrl J runs the highlighted prompt on it: the prompt and the selection are
// shown, Enter sends them to Claude, and Enter again pastes the result over the selection (Ctrl C only copies
// it). Nothing is sent until that Enter.

import { copyBody } from "./collection/snippetText";
import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { aiLive, api, errText, type CaptureContext, type NoteSummary } from "./api";
import { fill } from "./blanks";
import { blanks, parts } from "./blanks";
import { keepVersion, lastVersions } from "./collection/BlankFields";
import FillBlanks from "./collection/FillBlanks";
import { copyFilled } from "./collection/copyItem";
import { hasVersions, lastFirst, versionsOf, type Version } from "./collection/versions";
import { applyPrefs, parsePrefs } from "./settings/prefs";
import { ago, folderName, KeyHints } from "./ui";
import { loadUsed, type Used } from "./collection/lastUsed";
import { faces, loadFaces } from "./library/Mark";
import { rest, whenOpened } from "./warm";
import { toCopy } from "./library/faces";
import { fold } from "./palette/match";

export default function Picker() {
  let input!: HTMLInputElement;
  const [q, setQ] = createSignal("");
  const [i, setI] = createSignal(0);
  const [filling, setFilling] = createSignal<{ item: NoteSummary; text: string } | null>(null);
  const [ctx, setCtx] = createSignal<CaptureContext | null>(null);
  const [here, setHere] = createSignal<Record<string, number>>({});
  const [used, setUsed] = createSignal<Used>({});
  /** Ctrl J: a prompt run on the selection. */
  const [run, setRun] = createSignal<{ item: NoteSummary; prompt: string; phase: "ready" | "running" | "done" | "error"; out: string } | null>(null);
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

  const rows = () => {
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
      .filter((n) => deep.has(n.id) || words.every((w) => fold(n.title + " " + n.folder + " " + n.preview).includes(w)))
      .sort((a, b) => score(b) - score(a) || b.modifiedAt - a.modifiedAt);
    const copyable = hits.filter((n) => toCopy(n.folder, faces()));
    // Notes (pages) only when asked for by name: the list is for what you copy.
    const pages = words.length ? hits.filter((n) => !toCopy(n.folder, faces())).slice(0, 8) : [];
    return [...copyable.slice(0, 40), ...pages];
  };
  const isPage = (n: NoteSummary) => !toCopy(n.folder, faces());

  const close = async () => {
    if (closed) return;
    closed = true;
    await (await api()).closePicker();
    rest();
  };
  let closed = false;
  const sel = () => rows()[i()];

  // The selected card's full text, for its versions.
  const [body] = createResource(
    () => sel()?.id,
    async (id) => copyBody(await (await api()).peekNote(id)),
  );
  const versions = createMemo((): Version[] => {
    const n = sel();
    const b = body();
    return n && b !== undefined && hasVersions(n.folder) ? lastFirst(versionsOf(b), last()?.[n.path]) : [];
  });
  const [vi, setVi] = createSignal(0);
  const version = () => versions()[vi() % Math.max(1, versions().length)];

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

  async function pick(n: NoteSummary | undefined) {
    if (!n) return;
    const full = n.id === sel()?.id && body() !== undefined ? body()! : copyBody(await (await api()).peekNote(n.id));
    const text = n.id === sel()?.id && version() ? version()!.text : full;
    if (blanks(text).length) return setFilling({ item: n, text });
    await copy(n, text);
  }

  /** The prompt with its own blanks filled by their defaults; the selection is the text it works on. */
  async function readyRun(n: NoteSummary | undefined) {
    if (!n) return;
    if (!ctx()?.text?.trim()) return void setRun({ item: n, prompt: "", phase: "error", out: "Nothing was selected in the app you were in. Select some text there first, then open the picker." });
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
      const res = await s.aiWrite({ task: "prompt", text: ctx()!.text!, instruction: r.prompt }, live);
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

  const runKey = (e: KeyboardEvent) => {
    const r = run()!;
    if (e.key === "Escape") setRun(null);
    else if (e.key === "Enter" && r.phase === "ready") void go();
    else if (e.key === "Enter" && r.phase === "done") void useResult(true);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && r.phase === "done" && !getSelection()?.toString()) void useResult(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const key = async (e: KeyboardEvent) => {
    const n = rows().length;
    if (e.ctrlKey && e.key.toLowerCase() === "j") {
      e.preventDefault();
      return void readyRun(rows()[i()]);
    }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) (setI((i() + 1) % Math.max(1, n)), setVi(0));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) (setI((i() + n - 1) % Math.max(1, n)), setVi(0));
    else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft") && versions().length > 1)
      setVi((vi() + (e.key === "ArrowLeft" ? versions().length - 1 : 1)) % versions().length);
    else if (e.key === "Enter") {
      pasting = e.ctrlKey ? (e.shiftKey ? "shift" : "plain") : "";
      void pick(rows()[i()]);
    }
    else if (e.ctrlKey && e.key.toLowerCase() === "o") {
      const r = rows()[i()];
      if (r) await (await api()).showNoteInMain(r.id);
      await close();
    } else if (e.key === "Escape") void close();
    else return;
    e.preventDefault();
  };

  onMount(async () => {
    window.addEventListener("keydown", (e) => run() && runKey(e), true);
    void loadFaces();
    await whenOpened(start);
  });

  /** The picker was asked for: the latest notes, the app in front, then show. */
  async function start() {
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

  const shown = () => version()?.text ?? sel()?.preview ?? "";

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
              <p class="run-text run-sel">{(ctx()?.text ?? "").slice(0, 1200)}</p>
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
          <FillBlanks
            inline
            title={filling()!.item.title}
            text={filling()!.text}
            selection={ctx()?.text}
            onClose={() => setFilling(null)}
            onCopy={(text) => void copy(filling()!.item, text)}
          />
          </Show>
        }
      >
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
            placeholder={ctx()?.app ? `Copy into ${ctx()!.app}: find a prompt or snippet…` : "Find a prompt, snippet or note to copy…"}
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
                  <span class="row-two">
                    <span class="row-label">{n.folder === "inbox" ? n.preview.split("\n")[0] : n.title}</span>
                    <Show when={used()[n.path]}>
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
          <KeyHints hints={[["Enter", "copy and close"], ["Ctrl Enter", "paste it"], !!ctx()?.text?.trim() && ["Ctrl J", "run on the selection"], versions().length > 1 && ["Alt ← →", "version"], ["Ctrl O", "open in Petrel"]]} />
          <span class="grow" />
          <KeyHints hints={[["Esc", "close"]]} />
        </footer>
      </Show>
    </div>
  );
}
