// Small pieces every screen uses: the toast (with Undo), relative times, key hints.

import { createSignal, For, type JSX, Show } from "solid-js";

export interface Toast {
  text: string;
  undo?: () => unknown;
  error?: boolean;
}

const [toast, setToast] = createSignal<Toast | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

export function say(text: string, o: { undo?: Toast["undo"]; error?: boolean } = {}) {
  clearTimeout(timer);
  setToast({ text, ...o });
  timer = setTimeout(() => setToast(null), o.undo ? 6000 : o.error ? 6000 : 2400);
}

/** `z` anywhere: the last change with an Undo, if its toast is still up. */
export function undoLast(): boolean {
  const t = toast();
  if (!t?.undo) return false;
  setToast(null);
  void t.undo();
  return true;
}

export function ToastView() {
  return (
    <Show when={toast()}>
      {(t) => (
        <div class="toast" classList={{ error: !!t().error }} role="status">
          <span>{t().text}</span>
          <Show when={t().undo}>
            <button class="link" onClick={() => undoLast()}>
              Undo <kbd>Z</kbd>
            </button>
          </Show>
        </div>
      )}
    </Show>
  );
}

export function Kbd(p: { keys: string }) {
  return (
    <span class="keys">
      <For each={p.keys.split(" ")}>{(k) => <kbd>{k}</kbd>}</For>
    </span>
  );
}

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(ms);
  if (s < 7 * 86400) return d.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" });
}

/** A collection's display name: the folder's last part, `Notes` for the top of the folder. */
export function folderName(folder: string): string {
  if (!folder) return "Notes";
  if (folder === "inbox") return "Inbox";
  if (folder === "journal") return "Journal";
  return folder.split("/").pop() ?? folder;
}

export function Empty(p: { title: string; children?: JSX.Element }) {
  return (
    <div class="empty">
      <p class="empty-title">{p.title}</p>
      {p.children}
    </div>
  );
}

/** True when the key event comes from a text field, where letters type rather than command. */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || !!t.closest(".cm-editor");
}
