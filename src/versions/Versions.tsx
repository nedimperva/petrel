// The history panel (`Ctrl H`, ui.md §4.5): the open draft's versions, newest first, and what each one had
// compared with the text now. Restore puts a version back; the text it replaces becomes a version itself, so
// restoring never loses anything and can be undone from this same list.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, type Action, type Version } from "../api";
import { ago } from "../list/DraftList";
import { counts, diff } from "./diff";

export interface VersionsHandle {
  key(e: KeyboardEvent): boolean;
}

interface Props {
  draftId: number;
  title: string;
  /** The editor's text now (saved before the panel opened). */
  current(): string;
  actions: Action[];
  onRestore(versionId: number): Promise<void>;
  onClose(): void;
  ref(h: VersionsHandle): void;
}

const words = (n: number) => (n === 1 ? "1 word" : `${n} words`);

/** Why a version was kept, in words. */
export function reasonLabel(reason: string, actions: Action[]): string {
  const [kind, uuid] = reason.split(":");
  const name = () => actions.find((a) => a.uuid === uuid)?.name ?? "an action";
  if (kind === "edit") return "While writing";
  if (kind === "restore") return "Before a restore";
  if (kind === "before_action") return `Before ${name()}`;
  if (kind === "action_conflict") return `${name()}'s result, not applied`;
  return reason;
}

export default function Versions(props: Props) {
  let body!: HTMLDivElement;
  let panel!: HTMLDivElement;
  const [list, setList] = createSignal<Version[] | null>(null);
  const [at, setAt] = createSignal(0);
  const [text, setText] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let generation = 0;

  async function load() {
    try {
      const v = await (await api).listVersions(props.draftId);
      setList(v);
      setAt((i) => Math.min(i, Math.max(0, v.length - 1)));
      await show();
    } catch (e) {
      setError(`History cannot be read: ${e}`);
    }
  }

  async function show() {
    const v = list()?.[at()];
    const mine = ++generation;
    if (!v) return setText(null);
    try {
      const t = await (await api).versionText(v.id);
      if (mine === generation) setText(t);
    } catch (e) {
      if (mine === generation) setError(String(e));
    }
  }

  // The version's text is "from", the current text "to": removed words are what restoring brings back.
  const parts = createMemo(() => {
    const t = text();
    return t === null ? [] : diff(t, props.current());
  });
  const summary = createMemo(() => counts(parts()));

  function move(by: number) {
    const n = list()?.length ?? 0;
    if (!n) return;
    setAt((i) => Math.min(n - 1, Math.max(0, i + by)));
    queueMicrotask(() => body.querySelector(".row.at")?.scrollIntoView({ block: "nearest" }));
    void show();
  }

  async function restore() {
    const v = list()?.[at()];
    if (!v || busy()) return;
    setBusy(true);
    try {
      await props.onRestore(v.id);
    } finally {
      setBusy(false);
    }
  }

  function key(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === "j" || e.key === "ArrowDown") return move(1), true;
    if (e.key === "k" || e.key === "ArrowUp") return move(-1), true;
    if (e.key === "Enter") return void restore(), true;
    if (e.key === "Escape") return props.onClose(), true;
    return false;
  }

  let timer: number | undefined;
  onMount(() => {
    props.ref({ key });
    // Keys go to the panel, never to the editor underneath.
    panel.focus();
    void load();
    // Times are relative ("5 min"); keep them true while the panel stays open.
    timer = window.setInterval(() => setList((l) => (l ? [...l] : l)), 60_000);
  });
  onCleanup(() => window.clearInterval(timer));

  return (
    <div class="list history" tabindex="-1" ref={panel}>
      <div class="list-head history-head">
        <span class="title">History of “{props.title || "untitled"}”</span>
        <span class="grow" />
        <span class="hint">A version is kept every 5 minutes while you write, and before every action and restore.</span>
      </div>
      <Show when={error()}>
        <div class="bar danger">{error()}</div>
      </Show>
      <Show
        when={list()?.length}
        fallback={
          <div class="empty">
            {list() ? "No versions yet. Keep writing: one is kept every 5 minutes, and before every action." : "Loading…"}
          </div>
        }
      >
        <div class="history-body">
          <div class="history-list list-body" ref={body}>
            <For each={list()}>
              {(v, i) => (
                <div
                  class="row"
                  classList={{ at: i() === at() }}
                  onClick={() => {
                    setAt(i());
                    void show();
                  }}
                  onDblClick={() => void restore()}
                >
                  <span class="title">{reasonLabel(v.reason, props.actions)}</span>
                  <span class="grow" />
                  <span class="time">{ago(v.createdAt)}</span>
                </div>
              )}
            </For>
          </div>
          <div class="history-pane">
            <div class="history-bar">
              <span class="meta">
                <Show when={parts().length && (summary().add || summary().del)} fallback="Same as the text now.">
                  Restoring brings back <span class="del">{words(summary().del)}</span> and removes{" "}
                  <span class="add">{words(summary().add)}</span>.
                </Show>
              </span>
              <span class="grow" />
              <button disabled={busy() || text() === null} onClick={() => void restore()}>
                Restore this version
              </button>
            </div>
            <div class="history-diff">
              <For each={parts()}>
                {(p) =>
                  p.kind === "same" ? (
                    <span>{p.text}</span>
                  ) : p.kind === "del" ? (
                    <del title="In this version, not in the text now">{p.text}</del>
                  ) : (
                    <ins title="In the text now, not in this version">{p.text}</ins>
                  )
                }
              </For>
            </div>
          </div>
        </div>
      </Show>
      <div class="list-foot keys-foot">
        <span>
          <kbd>j k</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> restore
        </span>
        <span>
          <kbd>Esc</kbd> back
        </span>
      </div>
    </div>
  );
}
