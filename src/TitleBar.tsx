// Petrel's own title bar, as in Tern: the system draws none on Windows. Library and new note on the left, what
// you are on (or the library's collections) in the middle, search and the window buttons on the right. The empty
// parts drag the window and a double click maximizes. On Linux the window manager draws the frame, so the window
// buttons are left out and the bar only carries Petrel's own controls.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { inTauri } from "./api";

export const ownFrame = inTauri && !navigator.userAgent.includes("Linux");

export interface Tab {
  id: string;
  label: string;
  count?: number;
}

async function win() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

const Icon = {
  library: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  back: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  ),
  plus: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  search: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
};

export default function TitleBar(p: {
  library: boolean;
  /** The note's title while writing. */
  title: string;
  tabs: Tab[];
  tab: string;
  onTab(id: string): void;
  onLibrary(): void;
  onNew(): void;
  onSearch(): void;
}) {
  const [max, setMax] = createSignal(false);
  onMount(async () => {
    if (!ownFrame) return;
    const w = await win();
    const read = () => void w.isMaximized().then(setMax, () => {});
    read();
    const stop = await w.onResized(read);
    onCleanup(stop);
  });
  const button = (b: "min" | "max" | "close") =>
    void win().then((w) => (b === "min" ? w.minimize() : b === "max" ? w.toggleMaximize() : w.close()).catch(() => {}));

  return (
    <header class="titlebar" data-tauri-drag-region="deep">
      <div class="titlebar-side">
        <button
          type="button"
          class="icon-btn"
          onClick={p.onLibrary}
          title={p.library ? "Back to writing (Esc)" : "Library (Ctrl L)"}
          aria-label={p.library ? "Back to writing" : "Library"}
        >
          {p.library ? Icon.back : Icon.library}
        </button>
        <button type="button" class="icon-btn" onClick={p.onNew} title="New note (Ctrl N)" aria-label="New note">
          {Icon.plus}
        </button>
      </div>
      <div class="titlebar-mid" data-tauri-drag-region>
        <Show when={p.library} fallback={<span class="titlebar-title" data-tauri-drag-region>{p.title}</span>}>
          <nav class="tabs" aria-label="Collections">
            <For each={p.tabs}>
              {(t) => (
                <button type="button" class="tab" classList={{ on: t.id === p.tab }} onClick={() => p.onTab(t.id)}>
                  {t.label}
                  <Show when={t.count}>
                    <span class="tab-count">{t.count}</span>
                  </Show>
                </button>
              )}
            </For>
          </nav>
        </Show>
      </div>
      <div class="titlebar-end">
        <button type="button" class="icon-btn" onClick={p.onSearch} title="Find or ask (Ctrl K)" aria-label="Find or ask">
          {Icon.search}
        </button>
        <Show when={ownFrame}>
          <div class="window-buttons">
            <button type="button" onClick={() => button("min")} title="Minimize" aria-label="Minimize">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 5h10" stroke="currentColor" />
              </svg>
            </button>
            <button type="button" onClick={() => button("max")} title={max() ? "Restore" : "Maximize"} aria-label={max() ? "Restore" : "Maximize"}>
              <Show
                when={max()}
                fallback={
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <rect x="0.5" y="0.5" width="9" height="9" rx="1" stroke="currentColor" />
                  </svg>
                }
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <rect x="0.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" />
                  <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" stroke="currentColor" />
                </svg>
              </Show>
            </button>
            <button type="button" class="close" onClick={() => button("close")} title="Close" aria-label="Close">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" />
              </svg>
            </button>
          </div>
        </Show>
      </div>
    </header>
  );
}
