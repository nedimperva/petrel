// Petrel's own title bar, as in Tern: the system draws none on Windows. The sidebar's button and new note on the
// left, what you are on in the middle, search and the window buttons on the right. The empty
// parts drag the window and a double click maximizes. On Linux the window manager draws the frame, so the window
// buttons are left out and the bar only carries Petrel's own controls.

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { inTauri } from "./api";

export const ownFrame = inTauri && !navigator.userAgent.includes("Linux");


async function win() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

const Icon = {
  sidebar: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
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
  /** The note's title while writing, or where you are in the library. */
  title: string;
  sidebar: boolean;
  onSidebar(): void;
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
          classList={{ on: p.sidebar }}
          onClick={p.onSidebar}
          title={p.sidebar ? "Hide the sidebar (Ctrl 0)" : "Show the sidebar (Ctrl 0)"}
          aria-label={p.sidebar ? "Hide the sidebar" : "Show the sidebar"}
          aria-pressed={p.sidebar}
        >
          {Icon.sidebar}
        </button>
        <button type="button" class="icon-btn" onClick={p.onNew} title="New note (Ctrl N)" aria-label="New note">
          {Icon.plus}
        </button>
      </div>
      <div class="titlebar-mid" data-tauri-drag-region>
        <span class="titlebar-title" data-tauri-drag-region>
          {p.title}
        </span>
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
