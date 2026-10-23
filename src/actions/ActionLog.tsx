// The action log (`g l`): recent runs, newest first, with the failing step and its message.

import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import { api, type RunLogEntry } from "../api";
import { ago } from "../list/DraftList";

export interface LogHandle {
  key(e: KeyboardEvent): boolean;
  reload(): void;
}

interface Props {
  onRunAgain(e: RunLogEntry): void;
  onOpenDraft(id: number): void;
  onClose(): void;
  ref(h: LogHandle): void;
}

const STATUS: Record<RunLogEntry["status"], string> = {
  ok: "done",
  stopped: "stopped",
  cancelled: "cancelled",
  failed: "failed",
};

export default function ActionLog(props: Props) {
  let panel!: HTMLDivElement;
  const [rows, setRows] = createSignal<RunLogEntry[]>([]);
  const [at, setAt] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);

  async function reload() {
    try {
      setRows(await (await api).actionLog(200));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  createEffect(() => panel?.querySelector(`[data-i="${at()}"]`)?.scrollIntoView({ block: "nearest" }));

  function key(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const r = rows()[at()];
    switch (e.key) {
      case "j":
      case "ArrowDown":
        setAt((i) => Math.min(i + 1, rows().length - 1));
        return true;
      case "k":
      case "ArrowUp":
        setAt((i) => Math.max(i - 1, 0));
        return true;
      case "Enter":
        if (r?.actionUuid && r.draftId) props.onRunAgain(r);
        return true;
      case "o":
        if (r?.draftId) props.onOpenDraft(r.draftId);
        return true;
      case "Escape":
        props.onClose();
        return true;
    }
    return false;
  }

  onMount(() => {
    props.ref({ key, reload });
    reload();
    panel.focus();
  });

  return (
    <div class="list log" ref={panel} tabindex="-1">
      <div class="list-head">
        <nav class="tabs">
          <span class="tab on">Action log</span>
          <span class="grow" />
          <span class="meta">
            <kbd>Enter</kbd> run again <kbd>o</kbd> open draft <kbd>Esc</kbd> back
          </span>
        </nav>
      </div>
      <div class="list-body">
        <Show when={error()}>{(e) => <div class="empty">The log cannot be read: {e()}</div>}</Show>
        <Show when={!error() && rows().length === 0}>
          <div class="empty">No runs yet.</div>
        </Show>
        <For each={rows()}>
          {(r, i) => (
            <div
              class="row run"
              classList={{ at: at() === i() }}
              data-i={i()}
              onClick={() => setAt(i())}
              onDblClick={() => r.actionUuid && r.draftId && props.onRunAgain(r)}
            >
              <span class={`status s-${r.status}`}>{STATUS[r.status] ?? r.status}</span>
              <span class="title">{r.action || "(deleted action)"}</span>
              <span class="preview">
                {r.draftTitle ?? "(no draft)"}
                <Show when={r.status === "failed"}>
                  {" · "}step {r.step}: {r.message}
                </Show>
                <Show when={r.status === "ok" && r.message}>
                  {" · "}
                  {r.message.split("\n").slice(-1)[0]}
                </Show>
              </span>
              <span class="time" title={new Date(r.startedAt).toLocaleString()}>
                {ago(r.startedAt)}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
