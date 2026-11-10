// The inbox: captures on the left, the one you are on to the right. Filing is a key: `m` to pick a note or a
// collection, `s` to ask Claude where it could go (only then, never by itself), Enter to take the first
// suggestion, `e` to edit, `d` to delete, `z` to undo.

import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { api, errText, type AiSuggestion, type Note, type NoteSummary } from "../api";
import { ago, Empty, folderName, Kbd, say, typing, undoLast } from "../ui";
import Destination, { type Target } from "./Destination";
import { fileCapture } from "./file";

export default function Inbox(p: { aiReady: boolean; onOpen(id: number): void; onAiSetup(): void; onCount(n: number): void }) {
  const [rev, setRev] = createSignal(0);
  const [items] = createResource(rev, async () => (await (await api()).listNotes({ folder: "inbox", limit: 500 })).sort((a, b) => b.modifiedAt - a.modifiedAt));
  const [at, setAt] = createSignal(0);
  const [cur, setCur] = createSignal<Note | null>(null);
  const [moving, setMoving] = createSignal(false);
  const [sugg, setSugg] = createSignal<AiSuggestion[] | "loading" | null>(null);
  const [pick, setPick] = createSignal(0);
  let body!: HTMLTextAreaElement;
  let base = "";

  const list = (): NoteSummary[] => items() ?? [];
  createEffect(() => p.onCount(list().length));
  const selected = () => list()[Math.min(at(), Math.max(0, list().length - 1))];

  createEffect(on(selected, async (s) => {
    setSugg(null);
    setPick(0);
    if (!s) return setCur(null);
    const n = await (await api()).peekNote(s.id).catch(() => null);
    setCur(n);
    base = n?.body ?? "";
  }));

  const refresh = () => setRev(rev() + 1);

  const saveEdit = async () => {
    const n = cur();
    if (!n || body.value === base) return;
    try {
      const r = await (await api()).saveNote(n.id, body.value, n.hash);
      base = body.value;
      setCur({ ...n, body: body.value, hash: r.hash, modifiedAt: r.modifiedAt });
    } catch (e) {
      say(errText(e), { error: true });
    }
  };

  async function file(t: Target) {
    setMoving(false);
    const n = cur();
    if (!n) return;
    await saveEdit();
    try {
      const { change, text } = await fileCapture(n, t);
      const s = await api();
      say(text, { undo: () => s.undo(change.token.token).then(refresh) });
      refresh();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  async function suggest() {
    const n = cur();
    if (!n) return;
    if (!p.aiReady) return p.onAiSetup();
    await saveEdit();
    setSugg("loading");
    try {
      const s = await (await api()).aiSuggestHome(n.id);
      if (cur()?.id === n.id) setSugg(s);
    } catch (e) {
      setSugg(null);
      say(errText(e), { error: true });
    }
  }

  const accept = (s: AiSuggestion) =>
    file(s.kind === "merge" && s.noteId != null ? { kind: "note", id: s.noteId, title: s.title } : { kind: "folder", folder: s.folder });

  async function remove() {
    const n = cur();
    if (!n) return;
    try {
      const s = await api();
      const t = await s.trashNote(n.id);
      say("Deleted", { undo: () => s.undo(t.token).then(refresh) });
      refresh();
    } catch (e) {
      say(errText(e), { error: true });
    }
  }

  const key = (e: KeyboardEvent) => {
    if (moving() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing(e)) {
      if (e.key === "Escape" && e.target === body) {
        e.preventDefault();
        void saveEdit();
        body.blur();
      }
      return;
    }
    const s = sugg();
    const n = list().length;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        setAt(Math.min(at() + 1, n - 1));
        break;
      case "k":
      case "ArrowUp":
        setAt(Math.max(at() - 1, 0));
        break;
      case "Enter":
        if (Array.isArray(s) && s.length) void accept(s[pick()] ?? s[0]);
        else setMoving(true);
        break;
      case "1":
      case "2":
      case "3":
        if (Array.isArray(s) && s[Number(e.key) - 1]) setPick(Number(e.key) - 1);
        else return;
        break;
      case "m":
        setMoving(true);
        break;
      case "s":
        void suggest();
        break;
      case "e":
        body?.focus();
        break;
      case "o":
        if (cur()) p.onOpen(cur()!.id);
        break;
      case "d":
      case "Delete":
        void remove();
        break;
      case "z":
        if (!undoLast()) return;
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  document.addEventListener("keydown", key);
  onCleanup(() => {
    document.removeEventListener("keydown", key);
    void saveEdit();
  });

  return (
    <div class="inbox">
      <Show
        when={list().length}
        fallback={
          <Empty title="Inbox zero">
            <p class="muted">
              Captures land here. Press <Kbd keys="Ctrl Alt Space" /> anywhere to write one down.
            </p>
          </Empty>
        }
      >
        <div class="inbox-list">
          <div class="inbox-head">
            <h2>Inbox</h2>
            <span class="muted">{list().length} to file</span>
          </div>
          <For each={list()}>
            {(it, i) => (
              <button class="inbox-row" classList={{ on: i() === at() }} onClick={() => setAt(i())}>
                <span class="inbox-text">{it.title.match(/^\d{4}-\d\d-\d\d \d{6}/) ? it.preview || "Empty" : it.title}</span>
                <span class="inbox-when">{ago(it.modifiedAt)}</span>
              </button>
            )}
          </For>
        </div>
        <div class="inbox-card">
          <Show when={cur()}>
            {(n) => (
              <>
                <div class="inbox-meta">
                  <span>Captured {ago(n().createdAt)}</span>
                  <span class="grow" />
                  <button class="link" onClick={() => p.onOpen(n().id)}>
                    Open as a page <kbd>O</kbd>
                  </button>
                </div>
                <textarea
                  ref={body}
                  class="capture-text"
                  value={n().body}
                  onBlur={saveEdit}
                  spellcheck={true}
                />
                <Show when={sugg()}>
                  <div class="where">
                    <div class="where-head">
                      <span class="spark">✦</span> Where this could go
                    </div>
                    <Show when={sugg() !== "loading"} fallback={<p class="ai-thinking">Claude is reading your notes…</p>}>
                      <Show when={(sugg() as AiSuggestion[]).length} fallback={<p class="muted">No good place found. Press M to choose.</p>}>
                        <For each={sugg() as AiSuggestion[]}>
                          {(s, i) => (
                            <button class="where-row" classList={{ on: i() === pick() }} onClick={() => accept(s)} onMouseEnter={() => setPick(i())}>
                              <kbd>{i() + 1}</kbd>
                              <span class="where-what">
                                {s.kind === "merge" ? (
                                  <>
                                    Add to <b>{s.title}</b>
                                  </>
                                ) : (
                                  <>
                                    New note <b>{s.title || "Untitled"}</b> in {folderName(s.folder)}
                                  </>
                                )}
                              </span>
                              <span class="where-why">{s.why}</span>
                            </button>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </div>
                </Show>
                <div class="keys-row">
                  <span>
                    <kbd>Enter</kbd> {Array.isArray(sugg()) && (sugg() as AiSuggestion[]).length ? "accept" : "file"}
                  </span>
                  <span>
                    <kbd>M</kbd> move to…
                  </span>
                  <span classList={{ "ai-key": true }}>
                    <kbd>S</kbd> suggest
                  </span>
                  <span>
                    <kbd>E</kbd> edit
                  </span>
                  <span>
                    <kbd>D</kbd> delete
                  </span>
                  <span>
                    <kbd>J</kbd> <kbd>K</kbd>
                  </span>
                  <span>
                    <kbd>Z</kbd> undo
                  </span>
                </div>
              </>
            )}
          </Show>
        </div>
      </Show>
      <Show when={moving()}>
        <Destination exclude={cur()?.id} onPick={file} onClose={() => setMoving(false)} />
      </Show>
    </div>
  );
}
